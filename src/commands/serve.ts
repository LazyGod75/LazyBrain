import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllReadonly } from '../indexer/fts.js';
import { loadBacklinks } from '../graph/backlinks.js';
import { loadGlobalGraph } from '../graph/global-graph.js';
import { route } from '../retrieval/router.js';
import { brainRoot, knowledgeNodePath, notesDir, batchesDir, slug } from '../store/paths.js';
import { readAllNotes } from '../store/reader.js';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { runIncrementalUpdate } from './index-update.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServeCliOptions {
  port?: number;
  token?: string;
  bind?: string;
}

// ---------------------------------------------------------------------------
// Pidfile / portfile helpers — kept separate from the daemon files
// ---------------------------------------------------------------------------

function servePidPath(): string {
  return join(getConfig().cachePath, 'serve.pid');
}

function servePortPath(): string {
  return join(getConfig().cachePath, 'serve.port');
}

function writeServeFiles(port: number): void {
  const cachePath = getConfig().cachePath;
  if (!existsSync(cachePath)) mkdirSync(cachePath, { recursive: true });
  writeFileSync(servePidPath(), String(process.pid), 'utf8');
  writeFileSync(servePortPath(), String(port), 'utf8');
}

function cleanServeFiles(): void {
  for (const path of [servePidPath(), servePortPath()]) {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

/** Read the port from the serve portfile, or null if absent/invalid. */
export function readServePort(): number | null {
  try {
    const raw = readFileSync(servePortPath(), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * POST /_api/shutdown to a running `lazybrain serve` and wait for it to close.
 * Returns 'stopped' if the request succeeded, 'no-server' if nothing is running,
 * or 'error:<message>' on unexpected failure.
 */
export async function stopServe(timeoutMs = 3000): Promise<'stopped' | 'no-server' | `error:${string}`> {
  const port = readServePort();
  if (!port) return 'no-server';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`http://127.0.0.1:${port}/_api/shutdown`, {
      method: 'POST',
      signal: controller.signal,
    });
    return 'stopped';
  } catch (err) {
    // Connection refused / aborted means the server is already gone — treat as success
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('aborted') || msg.includes('fetch failed')) {
      return 'stopped';
    }
    return `error:${msg}`;
  } finally {
    clearTimeout(timer);
    cleanServeFiles();
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

export function runServe(opts: ServeCliOptions): Promise<import('node:http').Server> {
  return new Promise((resolveServer, reject) => {
    const port = opts.port ?? 4242;
    const bind = opts.bind ?? '127.0.0.1';
    const root = brainRoot();
    const log = getLogger();

    // Resolve path to brain-ui directory.
    // __dirname = src/commands, so go up 2 levels to project root, then down to examples.
    const uiDir = resolve(__dirname, '..', '..', 'examples', 'brain-ui');
    const uiIndexPath = join(uiDir, 'index.html');
    const uiIndexExists = existsSync(uiIndexPath);

    if (!existsSync(uiDir)) {
      log.error(
        { uiDir },
        'brain-ui directory not found — the UI will be unavailable. ' +
        'If running from npm, ensure "examples/" is listed in package.json "files". ' +
        'If running from source, check that examples/brain-ui/ exists.',
      );
    }

    const server = createServer((req, res) => {
      // Auth
      if (opts.token) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${opts.token}`) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
      }

      const url = new URL(req.url ?? '/', `http://${bind}:${port}`);
      const rel = decodeURIComponent(url.pathname);

      // API route: POST /_api/shutdown — graceful stop
      if (rel === '/_api/shutdown' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Defer close so the response is fully written first.
        // server.close() stops accepting new connections; the process exits
        // naturally once the event loop drains (no explicit process.exit needed).
        setImmediate(() => {
          server.close();
          cleanServeFiles();
        });
        return;
      }

      // API route: list all notes
      if (rel === '/_api/notes') {
        try {
          const allNotes = listAllReadonly({ includeExpired: false });
          const json = JSON.stringify(
            allNotes.map((n) => ({
              id: n.id,
              path: n.path.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, ''),
              title: n.title,
              type: n.type,
              tags: n.tags,
              topic: n.topic || null,
              created: n.created,
              importance: n.importance,
            })),
          );
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-security-policy': "default-src 'self'",
          });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/notes');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Index not ready' }));
          return;
        }
      }

      // API route: GET /_api/notes/:id/backlinks
      const backlinksMatch = rel.match(/^\/_api\/notes\/([^/]+)\/backlinks$/);
      if (backlinksMatch) {
        try {
          const noteId = decodeURIComponent(backlinksMatch[1]);
          const idx = loadBacklinks();
          if (!idx) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Backlinks index not available' }));
            return;
          }
          const incoming = idx.incoming[noteId] ?? [];
          const json = JSON.stringify({
            noteId,
            total: incoming.length,
            backlinks: incoming.map((b) => ({
              from: b.from,
              type: b.type,
              surface: b.surface,
              auto: b.auto,
            })),
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/notes/:id/backlinks');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load backlinks' }));
          return;
        }
      }

      // API route: GET /_api/notes/:id/neighbors
      const neighborsMatch = rel.match(/^\/_api\/notes\/([^/]+)\/neighbors$/);
      if (neighborsMatch) {
        try {
          const noteId = decodeURIComponent(neighborsMatch[1]);
          const idx = loadBacklinks();
          if (!idx) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Backlinks index not available' }));
            return;
          }
          const inbound = idx.incoming[noteId] ?? [];
          const outbound = idx.outgoing[noteId] ?? [];
          const json = JSON.stringify({
            noteId,
            inbound: {
              count: inbound.length,
              notes: inbound.map((b) => ({ id: b.from, type: b.type })),
            },
            outbound: {
              count: outbound.length,
              notes: outbound.map((b) => ({ id: b.to, type: b.type })),
            },
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/notes/:id/neighbors');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load neighbors' }));
          return;
        }
      }

      // API route: GET /_api/hierarchy — nested topic/project tree
      if (rel === '/_api/hierarchy') {
        try {
          const allNotes = listAllReadonly({ includeExpired: false });
          const root: Record<string, unknown> = { children: {}, count: 0 };

          for (const note of allNotes) {
            const parts = (note.topic || '_uncategorized').split('/').filter(Boolean);
            let node = root;

            for (const part of parts) {
              const children = node.children as Record<string, unknown>;
              if (!children[part]) {
                children[part] = { children: {}, count: 0 };
              }
              node = children[part] as Record<string, unknown>;
            }

            node.count = ((node.count as number) || 0) + 1;
          }

          // Recursive helper to add total counts including children
          function addTotals(node: Record<string, unknown>): number {
            let total = (node.count as number) || 0;
            const children = node.children as Record<string, Record<string, unknown>>;
            for (const child of Object.values(children)) {
              total += addTotals(child);
            }
            node.total = total;
            return total;
          }
          addTotals(root);

          const json = JSON.stringify(root);
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-security-policy': "default-src 'self'",
          });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/hierarchy');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to build hierarchy' }));
          return;
        }
      }

      // API route: GET /_api/search?q=...&top=5
      if (rel.startsWith('/_api/search')) {
        try {
          const q = url.searchParams.get('q');
          if (!q) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing q parameter' }));
            return;
          }
          const topK = Math.min(Math.max(parseInt(url.searchParams.get('top') ?? '5', 10), 1), 50);
          route({ query: q, topK }).then((result) => {
            const json = JSON.stringify({
              query: q,
              topK,
              results: result.hits.map((h) => ({
                id: h.id,
                path: h.path.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, ''),
                score: h.score,
                level: result.levelUsed,
                snippet: h.snippet,
              })),
              totalMs: result.totalMs,
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(json);
          }).catch((err) => {
            log.error({ err }, 'API error in /_api/search');
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Search failed' }));
          });
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/search');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Search error' }));
          return;
        }
      }

      // API route: GET /_api/global-graph — returns the cross-project global graph
      if (rel === '/_api/global-graph') {
        try {
          const globalGraph = loadGlobalGraph();
          if (!globalGraph) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Global graph not available. Run: lazybrain graph' }));
            return;
          }
          const json = JSON.stringify(globalGraph);
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-security-policy': "default-src 'self'",
          });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/global-graph');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load global graph' }));
          return;
        }
      }

      // API route: GET /_api/graph — returns all nodes and edges
      if (rel === '/_api/graph') {
        try {
          const allNotes = listAllReadonly({ includeExpired: false });
          const backlinksIdx = loadBacklinks();

          const nodes = allNotes.map((n) => ({
            id: n.id,
            title: n.title,
            type: n.type,
            topic: n.topic || null,
            importance: n.importance || 0.5,
          }));

          const edges: Array<{ from: string; to: string; type: string; auto: boolean }> = [];
          if (backlinksIdx) {
            for (const outgoingEdges of Object.values(backlinksIdx.outgoing)) {
              for (const edge of outgoingEdges) {
                edges.push({
                  from: edge.from,
                  to: edge.to,
                  type: edge.type,
                  auto: edge.auto,
                });
              }
            }
          }

          const json = JSON.stringify({ nodes, edges });
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-security-policy': "default-src 'self'",
          });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/graph');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load graph data' }));
          return;
        }
      }

      // API route: GET /_api/graph.json — alias for /_api/graph (used by vis-network dashboard)
      if (rel === '/_api/graph.json') {
        try {
          const allNotes = listAllReadonly({ includeExpired: false });
          const backlinksIdx = loadBacklinks();

          const nodes = allNotes.map((n) => ({
            id: n.id,
            title: n.title,
            type: n.type,
            topic: n.topic || null,
            importance: n.importance || 0.5,
          }));

          const edges: Array<{ from: string; to: string; type: string; auto: boolean }> = [];
          if (backlinksIdx) {
            for (const outgoingEdges of Object.values(backlinksIdx.outgoing)) {
              for (const edge of outgoingEdges) {
                edges.push({
                  from: edge.from,
                  to: edge.to,
                  type: edge.type,
                  auto: edge.auto,
                });
              }
            }
          }

          const json = JSON.stringify({ nodes, edges });
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-security-policy': "default-src 'self'",
          });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/graph.json');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load graph data' }));
          return;
        }
      }

      // API route: GET /_api/topics/:path
      const topicsMatch = rel.match(/^\/_api\/topics\/(.+)$/);
      if (topicsMatch) {
        try {
          const topicPath = decodeURIComponent(topicsMatch[1]);
          const allNotes = listAllReadonly({ includeExpired: false });
          const topicNotes = allNotes.filter((n) => (n.topic ?? '').startsWith(topicPath));
          const topicDecisions = topicNotes.filter((n) => n.type === 'decision');

          const tagCounts = new Map<string, number>();
          for (const n of topicNotes) {
            const tags = (n.tags ?? '').split(/\s+/).filter(Boolean);
            for (const tag of tags) {
              tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
            }
          }
          const topTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([tag]) => tag);

          const avgImportance = topicNotes.length > 0
            ? topicNotes.reduce((sum, n) => sum + (n.importance ?? 0), 0) / topicNotes.length
            : 0;

          const json = JSON.stringify({
            topic: topicPath,
            stats: {
              totalNotes: topicNotes.length,
              activeDecisions: topicDecisions.length,
              topTags,
              avgImportance: Math.round(avgImportance * 100) / 100,
            },
            notes: topicNotes.map((n) => ({
              id: n.id,
              path: n.path.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, ''),
              title: n.title,
              type: n.type,
              importance: n.importance,
            })),
            decisions: topicDecisions.map((d) => ({
              id: d.id,
              title: d.title,
              created: d.created,
              importance: d.importance,
            })),
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/topics/:path');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load topic' }));
          return;
        }
      }

      // API route: GET /_api/synthesis/index — returns brain-index HTML
      if (rel === '/_api/synthesis/index') {
        try {
          const allNotes = readAllNotes();
          const brainIndex = allNotes.find(n => /data-cerveau-type="brain-index"/.test(n.html));
          if (!brainIndex) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'No brain index found. Run: lazybrain dream --synthesize' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(brainIndex.html);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/synthesis/index');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load brain index' }));
          return;
        }
      }

      // API route: GET /_api/synthesis/:topic — returns topic-overview HTML
      if (rel.startsWith('/_api/synthesis/')) {
        try {
          const topic = decodeURIComponent(rel.slice('/_api/synthesis/'.length));
          const allNotes = readAllNotes();
          const overview = allNotes.find(n => {
            const typeMatch = /data-cerveau-type="topic-overview"/.test(n.html);
            if (!typeMatch) return false;
            // Match by first segment of data-cerveau-topic (e.g. "acme")
            const topicMatch = n.html.match(/data-cerveau-topic="([^"]*)"/);
            if (topicMatch) {
              const firstSegment = topicMatch[1].split('/')[0]?.trim();
              if (firstSegment === topic) return true;
            }
            // Fallback: match by first comma-separated tag (legacy pages)
            const tagMatch = n.html.match(/data-cerveau-tags="([^"]*)"/);
            return tagMatch != null && tagMatch[1].split(',')[0]?.trim() === topic;
          });
          if (!overview) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `No synthesis found for topic: ${topic}` }));
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(overview.html);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/synthesis/:topic');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load topic overview' }));
          return;
        }
      }

      // API route: GET /_api/resolve?href=<href> — resolve a legacy href (e.g. "file:<path>")
      // to a note id + path. Used by the wiki UI to handle children links in aggregate-neurons.
      if (rel === '/_api/resolve') {
        try {
          const href = url.searchParams.get('href');
          if (!href) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing href parameter' }));
            return;
          }
          const allNotes = listAllReadonly({ includeExpired: false });
          let found: (typeof allNotes)[0] | undefined;

          // Match "file:<relative-path>" against data-code-file or note ID slug
          if (href.startsWith('file:')) {
            const codePath = href.slice('file:'.length).replace(/\\/g, '/');
            const sluggedPath = slug(codePath);
            found = allNotes.find((n) => {
              if (n.type !== 'file-neuron') return false;
              // Match by end of ID (slug of code path)
              return n.id.endsWith(sluggedPath) || n.id.includes(sluggedPath);
            });
            // Fallback: partial path match on the note id
            if (!found) {
              const parts = codePath.split('/').map((p) => slug(p));
              found = allNotes.find((n) => {
                if (n.type !== 'file-neuron') return false;
                return parts.every((p) => n.id.includes(p));
              });
            }
          } else {
            // Generic: try exact slug match
            const hrefSlug = slug(href);
            found = allNotes.find((n) => n.id === hrefSlug || slug(n.id) === hrefSlug);
          }

          if (!found) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `No note found for href: ${href}` }));
            return;
          }

          const json = JSON.stringify({
            id: found.id,
            path: found.path.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, ''),
            type: found.type,
            title: found.title,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/resolve');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to resolve href' }));
          return;
        }
      }

      // API route: GET /_api/note-meta/:id — return note metadata (id, path, type, title)
      // Used by the wiki UI to look up the path for any note type by ID.
      const noteMetaMatch = rel.match(/^\/_api\/note-meta\/(.+)$/);
      if (noteMetaMatch) {
        try {
          const noteId = decodeURIComponent(noteMetaMatch[1]);
          const allNotes = listAllReadonly({ includeExpired: false });
          const found = allNotes.find((n) => n.id === noteId);
          if (!found) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `Note not found: ${noteId}` }));
            return;
          }
          const json = JSON.stringify({
            id: found.id,
            path: found.path.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, ''),
            type: found.type,
            title: found.title,
            topic: found.topic ?? null,
            tags: found.tags ?? '',
            importance: found.importance ?? 0.5,
            created: found.created ?? null,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/note-meta/:id');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to look up note metadata' }));
          return;
        }
      }

      // API route: GET /_api/note/:id — resolve ANY note by ID across all stores.
      // Searches: (1) FTS index (notes/ + batches/), (2) slugged fallback.
      // This is the canonical endpoint: the SPA must use this for ALL neuron types.
      // Note: the knowledge-nodes/ directory fallback has been removed because that
      // pipeline is retired. All canonical pages now live under notes/ and are indexed.
      const noteByIdMatch = rel.match(/^\/_api\/note\/(.+)$/);
      if (noteByIdMatch) {
        try {
          const noteId = decodeURIComponent(noteByIdMatch[1]);
          const noteCSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";

          // 1. Look up in the FTS index (covers all indexed notes: file-neuron, aggregate-neuron, concept, etc.)
          const allIndexed = listAllReadonly({ includeExpired: false });
          const indexed = allIndexed.find((n) => n.id === noteId);
          if (indexed && existsSync(indexed.path)) {
            const html = readFileSync(indexed.path, 'utf-8');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': noteCSP });
            res.end(html);
            return;
          }

          // 2. Slugged fallback: try slug(noteId) match in indexed notes
          const sluggedId = slug(noteId);
          const slugMatch = allIndexed.find((n) => n.id === sluggedId || slug(n.id) === sluggedId);
          if (slugMatch && existsSync(slugMatch.path)) {
            const html = readFileSync(slugMatch.path, 'utf-8');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': noteCSP });
            res.end(html);
            return;
          }

          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `Note not found: ${noteId}` }));
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/note/:id');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load note' }));
          return;
        }
      }

      // API route: GET /_api/node/:id — legacy alias (knowledge-nodes only, kept for backward compat)
      const nodeMatch = rel.match(/^\/_api\/node\/([^/]+)$/);
      if (nodeMatch) {
        try {
          const nodeId = decodeURIComponent(nodeMatch[1]);
          const nodePath = knowledgeNodePath(slug(nodeId));
          if (!existsSync(nodePath)) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `Knowledge node not found: ${nodeId}` }));
            return;
          }
          const html = readFileSync(nodePath, 'utf-8');
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
          });
          res.end(html);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/node/:id');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load knowledge node' }));
          return;
        }
      }

      // API route: GET /_api/tree — code-first hierarchy for sidebar folder tree.
      // Returns: { projects: [ { id, label, noteId, type, children: [...] } ] }
      // Structure: project → modules (aggregate-neurons) → files (file-neurons)
      // Note: topics may use different case (e.g. "AdminPanel" vs "adminpanel");
      // we normalise by slug for grouping, but preserve original label.
      if (rel === '/_api/tree') {
        try {
          const allNotes = listAllReadonly({ includeExpired: false });

          type NoteEntry = typeof allNotes[0];

          // Collect code neurons only
          const aggregates = allNotes.filter((n) => n.type === 'aggregate-neuron');
          const fileNeurons = allNotes.filter((n) => n.type === 'file-neuron');

          // Normalise a topic segment for comparison (case-insensitive, slug-like)
          function normSeg(s: string): string {
            return s.toLowerCase().replace(/[^a-z0-9]/g, '-');
          }

          // Normalise full topic path for comparison
          function normTopic(t: string): string {
            return t.split('/').map(normSeg).join('/');
          }

          // Build a canonical project key (lower-case slug of first topic segment)
          function projectSlug(note: NoteEntry): string {
            const first = (note.topic || '').split('/')[0];
            return normSeg(first) || slug(note.id);
          }

          // Map: normalised project slug → { label (display), rootAgg, subAggs, files }
          const projectMap = new Map<string, {
            label: string;
            rootAgg: NoteEntry | null;
            subAggs: NoteEntry[];
            files: NoteEntry[];
          }>();

          function ensureProject(key: string, label: string) {
            if (!projectMap.has(key)) {
              projectMap.set(key, { label, rootAgg: null, subAggs: [], files: [] });
            }
          }

          for (const agg of aggregates) {
            const key = projectSlug(agg);
            const label = (agg.topic || '').split('/')[0] || agg.id;
            ensureProject(key, label);
            const entry = projectMap.get(key)!;
            const topicDepth = (agg.topic || '').split('/').filter(Boolean).length;
            if (topicDepth <= 1 && !entry.rootAgg) {
              entry.rootAgg = agg;
            } else {
              entry.subAggs.push(agg);
            }
          }

          // For any project that still has no rootAgg, promote the highest-importance
          // sub-aggregate so the project node links to something meaningful.
          for (const entry of projectMap.values()) {
            if (entry.rootAgg === null && entry.subAggs.length > 0) {
              const best = entry.subAggs.reduce<NoteEntry>((prev, cur) =>
                (cur.importance ?? 0) > (prev.importance ?? 0) ? cur : prev,
                entry.subAggs[0]!,
              );
              entry.rootAgg = best;
              entry.subAggs = entry.subAggs.filter((a) => a.id !== best.id);
            }
          }

          for (const file of fileNeurons) {
            const key = projectSlug(file);
            const label = (file.topic || '').split('/')[0] || '_unknown';
            ensureProject(key, label);
            projectMap.get(key)!.files.push(file);
          }

          // Build the tree response
          const projects = [...projectMap.entries()]
            .filter(([k]) => k !== '' && k !== '_unknown')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, { label, rootAgg, subAggs, files }]) => {
              const normProjectTopic = normTopic((rootAgg?.topic || label).split('/')[0] || label);

              // Build module children (sub-aggregates), each with their file leaves
              const moduleChildren = subAggs
                .sort((a, b) => (a.topic || '').localeCompare(b.topic || ''))
                .map((agg) => {
                  const topicParts = (agg.topic || '').split('/').filter(Boolean);
                  const moduleLabel = topicParts.slice(1).join('/') || agg.title || agg.id;
                  const normAggTopic = normTopic(agg.topic || '');

                  // Files whose normalised topic starts with this module's normalised topic
                  const moduleFiles = files
                    .filter((f) => {
                      const nft = normTopic(f.topic || '');
                      return nft === normAggTopic || nft.startsWith(normAggTopic + '/');
                    })
                    .map((f) => ({
                      id: f.id,
                      label: f.title || f.id,
                      noteId: f.id,
                      type: f.type as string,
                      children: [] as unknown[],
                    }));

                  return {
                    id: agg.id,
                    label: moduleLabel,
                    noteId: agg.id,
                    type: 'aggregate-neuron' as string,
                    children: moduleFiles,
                  };
                });

              // Files whose normalised project segment matches but aren't under any sub-aggregate
              const assignedFileIds = new Set(
                moduleChildren.flatMap((m) => (m.children as Array<{id: string}>).map((f) => f.id))
              );
              const topFiles = files
                .filter((f) => {
                  if (assignedFileIds.has(f.id)) return false;
                  const nft = normTopic(f.topic || '');
                  const firstSeg = nft.split('/')[0];
                  return firstSeg === normProjectTopic;
                })
                .map((f) => ({
                  id: f.id,
                  label: f.title || f.id,
                  noteId: f.id,
                  type: f.type as string,
                  children: [] as unknown[],
                }));

              const children = [...moduleChildren, ...topFiles].sort((a, b) =>
                a.label.localeCompare(b.label)
              );

              return {
                id: rootAgg?.id ?? label,
                label,
                noteId: rootAgg?.id ?? null,
                type: 'project' as string,
                children,
              };
            });

          const json = JSON.stringify({ projects });
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-security-policy': "default-src 'self'",
          });
          res.end(json);
          return;
        } catch (err) {
          log.error({ err }, 'API error in /_api/tree');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to build tree' }));
          return;
        }
      }

      // Serve UI files (index.html, graph.html) from brain-ui dir with permissive CSP
      const isRoot = rel === '/' || rel === '';
      const uiCSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data: blob:";
      if (isRoot && uiIndexExists) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'content-security-policy': uiCSP });
        createReadStream(uiIndexPath).pipe(res);
        return;
      }
      if (rel === '/graph.html') {
        const graphPath = join(uiDir, 'graph.html');
        if (existsSync(graphPath)) {
          res.writeHead(200, { 'content-type': MIME['.html'], 'content-security-policy': uiCSP });
          createReadStream(graphPath).pipe(res);
          return;
        }
      }

      // Serve SPA static assets (CSS, JS modules) from brain-ui directory
      const uiAssetPrefixes = ['/styles/', '/components/', '/lib/'];
      if (uiAssetPrefixes.some((prefix) => rel.startsWith(prefix))) {
        // Security: reject path traversal
        if (rel.includes('..')) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        const assetRelPath = rel.replace(/^\//, '');
        const assetPath = resolve(uiDir, assetRelPath);
        if (!assetPath.startsWith(resolve(uiDir))) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        if (!existsSync(assetPath)) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const assetMime = MIME[extname(assetPath).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': assetMime, 'content-security-policy': uiCSP });
        createReadStream(assetPath).pipe(res);
        return;
      }

      // Regular file serving with path traversal protection
      // Reject path traversal
      const safeRel = normalize(rel).replace(/^[/\\]+/, '');
      const resolved = resolve(root, safeRel);
      if (!resolved.startsWith(resolve(root))) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      let target = resolved;
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        target = join(resolved, 'index.html');
      }

      if (!existsSync(target)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        'content-type': mime,
        'content-security-policy': "default-src 'self'; script-src 'none'",
      });
      createReadStream(target).pipe(res);
    });

    server.listen(port, bind, () => {
      // When port 0 is requested, the OS assigns a free ephemeral port.
      // Read the actual bound port from server.address() so serve.port is accurate.
      const boundPort = (server.address() as import('node:net').AddressInfo).port;
      writeServeFiles(boundPort);
      log.info({ port: boundPort, bind, root }, 'lazybrain serve listening');

      // Auto-build: if the index is empty but note files exist on disk,
      // trigger an incremental index update in the background so the serve
      // becomes useful immediately without requiring a manual `index-rebuild`.
      // We check both notesDir and batchesDir (same as readAllNotes).
      setImmediate(() => {
        try {
          const indexedNotes = listAllReadonly({ includeExpired: true });
          if (indexedNotes.length === 0) {
            const hasNoteFiles =
              existsSync(notesDir()) ||
              existsSync(batchesDir());
            if (hasNoteFiles) {
              log.info('serve: index is empty but note files exist — running incremental index update');
              try {
                const result = runIncrementalUpdate();
                log.info(
                  { indexed: result.indexed, failed: result.failed },
                  'serve: auto index-update complete',
                );
              } catch (buildErr) {
                log.warn(
                  { err: (buildErr as Error).message },
                  'serve: auto index-update failed — run `lazybrain index-rebuild` manually',
                );
              }
            }
          }
        } catch {
          // Never block server startup on index check errors
        }
      });

      // Named handlers so they can be removed when the server closes,
      // preventing MaxListenersExceededWarning in test environments.
      const onExit = (): void => { cleanServeFiles(); };
      const onSigInt = (): void => { cleanServeFiles(); server.close(); };
      const onSigTerm = (): void => { cleanServeFiles(); server.close(); };

      process.on('exit', onExit);
      process.on('SIGINT', onSigInt);
      process.on('SIGTERM', onSigTerm);

      // Remove signal handlers once the server closes to avoid leaks in tests
      server.once('close', () => {
        process.removeListener('exit', onExit);
        process.removeListener('SIGINT', onSigInt);
        process.removeListener('SIGTERM', onSigTerm);
      });

      resolveServer(server);
    });
    server.on('error', reject);
  });
}
