/**
 * synthesize-nodes: RETIRED graph-first pipeline.
 *
 * This command previously wrote knowledge-node HTML files to brain/knowledge-nodes/.
 * That directory is now superseded by the code-first neuron pipeline:
 *   - file-neuron   (one per source file, stored in brain/notes/)
 *   - aggregate-neuron (one per module/project, stored in brain/notes/)
 *   - concept-neuron  (cross-cutting knowledge, stored in brain/notes/)
 *
 * The command still reads brain-graph.json (needed for the global-graph view)
 * but no longer emits HTML files. All helper functions (composeKnowledgeNode,
 * buildInput, …) are retained because enrich.ts imports them until that
 * dependency is also cleaned up.
 *
 * @deprecated Use `lazybrain graph` + `lazybrain build-hierarchy` instead.
 */

import {
  type BrainEdge,
  type BrainNode,
  loadKnowledgeGraph,
} from '../graph/knowledge-graph.js';
import { slug } from '../store/paths.js';
import { nowIso } from '../util/telemetry.js';
import { getLogger } from '../util/logger.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SynthesizeNodesOptions {
  dryRun?: boolean;
  topic?: string;
  force?: boolean;
  pretty?: boolean;
}

export interface SynthesizeNodesReport {
  created: number;
  skipped: number;
  errors: string[];
  nodeIds: string[];
}

// ---------------------------------------------------------------------------
// KnowledgeNodeInput — defined locally until composer is extracted
// ---------------------------------------------------------------------------

type KnowledgeNodeType = 'feature' | 'component' | 'concept' | 'module' | 'project';
type KnowledgeNodeStatus = 'active' | 'deprecated' | 'draft';

export interface KnowledgeNodeInput {
  id: string;
  title: string;
  topicPath: string;
  importance: number;
  confidence: number;
  status: KnowledgeNodeStatus;
  nodeType: KnowledgeNodeType;
  tags: string[];
  tldr: string;
  stack: string[];
  children: Array<{ id: string; title: string }>;
  dependencies: Array<{ id: string; type: string }>;
  graphEdges: BrainEdge[];
  seeAlso: Array<{ id: string; title: string }>;
  inbound: number;
  outbound: number;
  created: string;
  cluster: string;
  pagerank: number;
  entities: Array<{ name: string; entityType: string; description?: string }>;
  // Enrichment data (populated by `enrich` command, empty by default)
  decisions: Array<{ text: string; sourceId: string }>;
  bugs: Array<{ text: string; sourceId: string; status?: string }>;
  ideas: Array<{ text: string; sourceId: string }>;
  rules: Array<{ text: string; sourceId: string }>;
  facts: Array<{ text: string; sourceId: string; kind?: string }>;
  qa: Array<{ question: string; sourceId: string }>;
  // Code structure (from code scanner, may be empty)
  codeFiles: Array<{ path: string; language: string; lineCount: number }>;
}

// ---------------------------------------------------------------------------
// Inline HTML composer (self-contained until knowledge-node.ts is extracted)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEdgeList(
  edges: Array<{ id: string; type?: string; title?: string }>,
  defaultType = 'link',
): string {
  if (edges.length === 0) return '<p>None</p>';
  const items = edges
    .map((e) => {
      const label = esc(e.title ?? e.id);
      const linkType = e.type ?? defaultType;
      return `<li><a href="#/note/${esc(e.id)}" data-cerveau-link-type="${esc(linkType)}" data-cerveau-link-confidence="extracted">${label}</a> <span class="edge-type">${esc(linkType)}</span></li>`;
    })
    .join('\n');
  return `<ul class="edge-list">${items}</ul>`;
}

export function composeKnowledgeNode(input: KnowledgeNodeInput): string {
  const now = nowIso();
  const tags = [...new Set([...input.tags, input.topicPath.split('/')[0]])].filter(Boolean);
  const entitiesAttr = input.entities.map((e) => `${e.entityType}:${e.name}`).join(',');

  // Collect only sections that have content
  const sections: string[] = [];

  // TLDR — always present
  sections.push(`<section data-section="tldr"><p>${esc(input.tldr || input.title)}</p></section>`);

  // Architecture — only if code files exist
  if (input.codeFiles.length > 0) {
    const items = input.codeFiles.slice(0, 20).map(
      (f) =>
        `<li><data value="file:${esc(f.path)}" data-cerveau-entity-type="file">${esc(f.path)}</data> <small>${esc(f.language)}, ${f.lineCount}L</small></li>`,
    );
    const list =
      input.codeFiles.length > 5
        ? `<details><summary>${input.codeFiles.length} files</summary><ul>${items.join('\n')}</ul></details>`
        : `<ul>${items.join('\n')}</ul>`;
    sections.push(`<section data-section="architecture"><h3>Architecture</h3>${list}</section>`);
  }

  // Decisions — only if enrichment found decisions
  if (input.decisions.length > 0) {
    const items = input.decisions
      .slice(0, 10)
      .map(
        (d) =>
          `<aside role="doc-note" class="decision-box"><strong>Decision:</strong> ${esc(d.text)}\n` +
          `<p class="source"><a href="#/note/${esc(d.sourceId)}" data-cerveau-link-type="documents" data-cerveau-link-confidence="inferred">source</a></p></aside>`,
      )
      .join('\n');
    sections.push(`<section data-section="decisions"><h3>Decisions</h3>${items}</section>`);
  }

  // Bugs — only if enrichment found bugs
  if (input.bugs.length > 0) {
    const items = input.bugs
      .slice(0, 10)
      .map(
        (b) =>
          `<aside role="doc-errata"><strong data-cerveau-kind="bug">Bug:</strong> ${esc(b.text)}` +
          (b.status ? ` <mark data-cerveau-status="${esc(b.status)}">${esc(b.status)}</mark>` : '') +
          `\n<p class="source"><a href="#/note/${esc(b.sourceId)}" data-cerveau-link-type="fixes" data-cerveau-link-confidence="inferred">source</a></p></aside>`,
      )
      .join('\n');
    sections.push(`<section data-section="bugs"><h3>Bugs &amp; Issues</h3>${items}</section>`);
  }

  // Ideas — only if enrichment found ideas
  if (input.ideas.length > 0) {
    const items = input.ideas
      .slice(0, 10)
      .map(
        (i) =>
          `<li data-cerveau-fact data-cerveau-kind="idea">${esc(i.text)} <a href="#/note/${esc(i.sourceId)}" data-cerveau-link-type="mentions" data-cerveau-link-confidence="inferred">source</a></li>`,
      );
    sections.push(`<section data-section="ideas"><h3>Ideas</h3><ul>${items.join('\n')}</ul></section>`);
  }

  // Rules — only if enrichment found rules
  if (input.rules.length > 0) {
    const items = input.rules
      .slice(0, 10)
      .map((r) => `<aside role="doc-tip">${esc(r.text)}</aside>`)
      .join('\n');
    sections.push(`<section data-section="rules"><h3>Rules</h3>${items}</section>`);
  }

  // Facts — only if enrichment found facts
  if (input.facts.length > 0) {
    const items = input.facts
      .slice(0, 15)
      .map(
        (f) =>
          `<li data-cerveau-fact${f.kind ? ` data-cerveau-kind="${esc(f.kind)}"` : ''}>${esc(f.text)} <a href="#/note/${esc(f.sourceId)}" data-cerveau-link-type="mentions" data-cerveau-link-confidence="inferred">source</a></li>`,
      );
    const list =
      input.facts.length > 5
        ? `<details open><summary>${input.facts.length} facts</summary><ul>${items.join('\n')}</ul></details>`
        : `<ul>${items.join('\n')}</ul>`;
    sections.push(`<section data-section="facts"><h3>Facts</h3>${list}</section>`);
  }

  // Q&A — only if enrichment found questions
  if (input.qa.length > 0) {
    const items = input.qa
      .slice(0, 10)
      .map(
        (q) =>
          `<div class="qa-pair" data-cerveau-kind="qa"><p class="question"><strong>Q:</strong> ${esc(q.question)}</p>` +
          `<p class="source"><a href="#/note/${esc(q.sourceId)}" data-cerveau-link-type="documents" data-cerveau-link-confidence="inferred">source</a></p></div>`,
      )
      .join('\n');
    sections.push(`<section data-section="qa"><h3>Q&amp;A</h3>${items}</section>`);
  }

  // Entities — only if detected
  if (input.entities.length > 0) {
    const rows = input.entities
      .map(
        (e) =>
          `<tr><td><data value="${esc(e.entityType)}:${esc(e.name)}" data-cerveau-entity-type="${esc(e.entityType)}">${esc(e.name)}</data></td><td><abbr title="${esc(e.entityType)}">${esc(e.entityType)}</abbr></td></tr>`,
      )
      .join('\n');
    sections.push(
      `<section data-section="entities"><h3>Entities</h3><table class="wikitable compact"><thead><tr><th>Entity</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    );
  }

  // Stack — only if detected
  if (input.stack.length > 0) {
    const items = input.stack
      .map((s) => `<li><data value="${esc(s)}" data-cerveau-stack-item="${esc(s)}">${esc(s)}</data></li>`)
      .join('');
    sections.push(`<section data-section="stack"><h3>Stack</h3><ul>${items}</ul></section>`);
  }

  // Dependencies — only if outgoing edges exist
  if (input.dependencies.length > 0) {
    sections.push(
      `<section data-section="dependencies"><h3>Dependencies</h3>${renderEdgeList(input.dependencies, 'depends-on')}</section>`,
    );
  }

  // Children — only if sub-nodes exist
  if (input.children.length > 0) {
    sections.push(
      `<section data-section="children"><h3>Components</h3>${renderEdgeList(input.children, 'contains')}</section>`,
    );
  }

  // Graph connections — only if edges exist
  if (input.graphEdges.length > 0) {
    const graphEdges = input.graphEdges.map((e) => ({
      id: e.source === input.id ? e.target : e.source,
      type: e.type,
      direction: e.source === input.id ? 'outgoing' : 'incoming',
      confidence: (e as BrainEdge & { confidence?: string }).confidence ?? 'inferred',
    }));
    const items = graphEdges.map(
      (e) =>
        `<li data-direction="${esc(e.direction)}">${e.direction === 'outgoing' ? '→' : '←'} ` +
        `<a href="#/note/${esc(e.id)}" data-cerveau-link-type="${esc(e.type)}" data-cerveau-link-confidence="${esc(String(e.confidence))}">${esc(e.id)}</a> ` +
        `<span class="edge-type">${esc(e.type)}</span></li>`,
    );
    const list =
      graphEdges.length > 10
        ? `<details><summary>${graphEdges.length} connections</summary><ul class="edge-list">${items.join('\n')}</ul></details>`
        : `<ul class="edge-list">${items.join('\n')}</ul>`;
    sections.push(`<section data-section="graph"><h3>Connections</h3>${list}</section>`);
  }

  // See Also — only if cluster peers found
  if (input.seeAlso.length > 0) {
    sections.push(
      `<section data-section="see-also"><h3>See Also</h3>${renderEdgeList(input.seeAlso, 'see-also')}</section>`,
    );
  }

  const sectionCount = sections.length;

  // Build breadcrumb
  const breadcrumbParts = input.topicPath.split('/').filter(Boolean);
  const breadcrumb = breadcrumbParts
    .map((seg, i) => {
      const path = breadcrumbParts.slice(0, i + 1).join('/');
      return i < breadcrumbParts.length - 1
        ? `<a href="#/topic/${esc(path)}">${esc(seg)}</a>`
        : `<span aria-current="page">${esc(seg)}</span>`;
    })
    .join(' / ');

  // Assemble article
  const article = [
    `<article id="${esc(input.id)}"`,
    `  data-cerveau-version="0.2.0"`,
    `  data-cerveau-created="${esc(input.created)}"`,
    `  data-cerveau-type="knowledge-node"`,
    `  data-cerveau-source="synthesize-nodes"`,
    `  data-cerveau-tier="working"`,
    `  data-cerveau-generated="graph-first"`,
    `  data-cerveau-synthesized-at="${esc(now)}"`,
    `  data-cerveau-topic="${esc(input.topicPath)}"`,
    `  data-cerveau-importance="${input.importance}"`,
    `  data-cerveau-status="${esc(input.status)}"`,
    `  data-cerveau-tags="${esc(tags.join(','))}"`,
    `  data-cerveau-cluster="${esc(input.cluster)}"`,
    `  data-cerveau-pagerank="${input.pagerank.toFixed(6)}"`,
    `  data-cerveau-node-type="${esc(input.nodeType)}"`,
    `  data-cerveau-entities="${esc(entitiesAttr)}"`,
    `  data-cerveau-inbound="${input.inbound}"`,
    `  data-cerveau-outbound="${input.outbound}"`,
    `  data-cerveau-confidence="${input.confidence}"`,
    `  data-cerveau-edge-count="${input.graphEdges.length}"`,
    `  data-cerveau-section-count="${sectionCount}"`,
    `>`,
    `<header class="wiki-header">`,
    `  <h1>${esc(input.title)}</h1>`,
    `  <aside class="infobox"><dl>`,
    `    <dt>Type</dt><dd><span class="type-badge ${esc(input.nodeType)}">${esc(input.nodeType)}</span></dd>`,
    `    <dt>Status</dt><dd><mark data-cerveau-status="${esc(input.status)}">${esc(input.status)}</mark></dd>`,
    `    <dt>Topic</dt><dd>${esc(input.topicPath)}</dd>`,
    `    <dt>Importance</dt><dd>${input.importance.toFixed(2)}</dd>`,
    `    <dt>Confidence</dt><dd>${input.confidence.toFixed(2)}</dd>`,
    `    <dt>PageRank</dt><dd>${input.pagerank.toFixed(4)}</dd>`,
    `    <dt>Cluster</dt><dd>${esc(input.cluster)}</dd>`,
    `    <dt>Inbound</dt><dd>${input.inbound}</dd>`,
    `    <dt>Outbound</dt><dd>${input.outbound}</dd>`,
    `  </dl></aside>`,
    `</header>`,
    `<nav class="breadcrumb">${breadcrumb}</nav>`,
    ...sections,
    `<footer class="categories">`,
    `  ${tags.map((t) => `<a rel="tag" href="#/tag/${esc(t)}">${esc(t)}</a>`).join(' ')}`,
    `</footer>`,
    `</article>`,
  ];

  return article.filter((p) => p.trim().length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function nodeTypeFromCerveauType(type: string): KnowledgeNodeType {
  switch (type) {
    case 'decision':
    case 'episodic':
      return 'concept';
    case 'reference':
    case 'semantic':
      return 'component';
    case 'architecture':
      return 'module';
    case 'feature':
    case 'feature-set':
      return 'feature';
    default:
      return 'concept';
  }
}

export function findChildren(
  node: BrainNode,
  allNodes: readonly BrainNode[],
): Array<{ id: string; title: string }> {
  const prefix = node.topicPath === 'unknown' ? null : node.topicPath + '/';
  if (!prefix) return [];

  return allNodes
    .filter((n) => {
      if (!n.topicPath.startsWith(prefix)) return false;
      const remainder = n.topicPath.slice(prefix.length);
      return remainder.length > 0 && !remainder.includes('/');
    })
    .map((n) => ({ id: n.id, title: n.title }));
}

export function findEdgesForNode(
  nodeId: string,
  edges: readonly BrainEdge[],
): { outgoing: BrainEdge[]; incoming: BrainEdge[] } {
  return {
    outgoing: edges.filter((e) => e.source === nodeId),
    incoming: edges.filter((e) => e.target === nodeId),
  };
}

/** Always returns false — page emission is retired. */
function nodeExists(_nodeId: string): boolean {
  return false;
}

export function buildInput(
  node: BrainNode,
  allNodes: readonly BrainNode[],
  allEdges: readonly BrainEdge[],
  created: string,
): KnowledgeNodeInput {
  const { outgoing, incoming } = findEdgesForNode(node.id, allEdges);

  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  const clusterPeers = allNodes.filter(
    (n) =>
      n.cluster === node.cluster &&
      n.id !== node.id &&
      !outgoing.some((e) => e.target === n.id) &&
      !incoming.some((e) => e.source === n.id),
  );

  const seeAlso = clusterPeers
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 5)
    .map((n) => ({ id: n.id, title: n.title }));

  const dependencies = outgoing.map((e) => {
    const target = nodeMap.get(e.target);
    return { id: e.target, title: target?.title ?? e.target, type: e.type };
  });

  const stack = node.tags.filter((t) =>
    /^(typescript|javascript|react|expo|supabase|next\.?js|tailwind|python|node\.?js|postgresql|prisma|stripe|electron)$/i.test(t),
  );

  const entities = node.tags
    .filter((t) =>
      /^(supabase|stripe|postgresql|react|expo|nextjs|tailwind|electron|prisma|nodejs|python|typescript|javascript)$/i.test(
        t,
      ),
    )
    .map((t) => ({ name: t, entityType: 'lib', description: undefined }));

  return {
    id: slug(node.id),
    title: node.title,
    topicPath: node.topicPath,
    importance: node.importance,
    confidence: 0.7,
    status: node.validUntil ? 'deprecated' : 'active',
    nodeType: nodeTypeFromCerveauType(node.type),
    tags: node.tags,
    tldr: node.tldr,
    stack,
    children: findChildren(node, allNodes),
    dependencies,
    graphEdges: [...outgoing, ...incoming],
    seeAlso,
    inbound: incoming.length,
    outbound: outgoing.length,
    created,
    cluster: node.cluster,
    pagerank: node.pagerank,
    entities,
    decisions: [],
    bugs: [],
    ideas: [],
    rules: [],
    facts: [],
    qa: [],
    codeFiles: [],
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * runSynthesizeNodes — RETIRED.
 *
 * Page emission to knowledge-nodes/ has been disabled. The command still
 * reads brain-graph.json so existing callers and skill references do not
 * crash, but it produces no output files. All candidates are reported as
 * "skipped" so that downstream tooling treats the run as a no-op.
 *
 * Canonical wiki pages are now generated by the code-first pipeline:
 *   lazybrain graph          → file-neuron + aggregate-neuron pages
 *   lazybrain build-hierarchy → hierarchy knowledge-nodes in notes/
 *   lazybrain enrich         → enriches file-neurons from conversations
 */
export async function runSynthesizeNodes(
  opts: SynthesizeNodesOptions,
): Promise<SynthesizeNodesReport> {
  const log = getLogger();
  const report: SynthesizeNodesReport = { created: 0, skipped: 0, errors: [], nodeIds: [] };

  // Warn early so tooling output is visible in logs.
  log.warn(
    {},
    'synthesize-nodes: RETIRED — page emission disabled. Use `lazybrain graph` + `lazybrain build-hierarchy` instead.',
  );

  const graph = loadKnowledgeGraph();
  if (!graph) {
    report.errors.push('brain-graph.json not found — run `lazybrain graph` first');
    return report;
  }

  const created = nowIso();

  const candidates = graph.nodes.filter(
    (n) =>
      n.type !== 'external' &&
      n.id.trim().length > 0 &&
      !n.id.startsWith('$') &&
      !/^[a-z]+$/.test(n.id) &&
      n.id.length >= 5,
  );

  const filtered = opts.topic
    ? candidates.filter(
        (n) => n.topicPath === opts.topic || n.topicPath.startsWith(opts.topic + '/'),
      )
    : candidates;

  log.debug(
    { total: filtered.length, topic: opts.topic ?? 'all' },
    'synthesize-nodes: retired — all candidates reported as skipped',
  );

  // All candidates are skipped — no files are written.
  // We still call buildInput/composeKnowledgeNode when dryRun is set so that
  // dry-run callers can inspect the generated HTML without any I/O side effects.
  for (const node of filtered) {
    const nodeId = slug(node.id);

    if (opts.dryRun) {
      try {
        const input = buildInput(node, graph.nodes, graph.edges, created);
        // Compose but discard — dry-run inspection only
        void composeKnowledgeNode(input);
      } catch (err) {
        const msg = (err as Error).message;
        report.errors.push(`${node.id}: ${msg}`);
      }
    }

    // nodeExists always returns false (retired); every node is reported skipped.
    if (!opts.force && nodeExists(nodeId)) {
      report.skipped += 1;
      continue;
    }

    report.skipped += 1;
  }

  log.debug(
    { skipped: report.skipped, errors: report.errors.length },
    'synthesize-nodes: done (retired)',
  );

  return report;
}
