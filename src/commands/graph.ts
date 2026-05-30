import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BacklinksIndex, buildBacklinks, saveBacklinks } from '../graph/backlinks.js';
import { type CodeScanResult, buildAggregateNeurons, codeNodesToNotes, scanProject, scanProjectAsync } from '../graph/code-scanner.js';
import { composeAggregateNeuron } from '../annotator/blocks/composers/aggregate-neuron.js';
import { detectClusters, loadClusters, saveClusters } from '../graph/clusters.js';
import { findDuplicates } from '../graph/dedup.js';
import { applyAutoLinks, buildEntityIndex } from '../graph/entities.js';
import { buildGlobalGraph, saveGlobalGraph } from '../graph/global-graph.js';
import { extractHierarchy } from '../graph/hierarchy.js';
import {
  buildKnowledgeGraphFromIndex,
  extractSubGraph,
  saveKnowledgeGraph,
} from '../graph/knowledge-graph.js';
import { computePageRank } from '../graph/pagerank.js';
import { indexNote, listAll } from '../indexer/fts.js';
import { brainRoot } from '../store/paths.js';
import { readAllNotes, readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';

export type GraphFormat = 'html' | 'text' | 'both';

export interface GraphCliOptions {
  skipAutolink?: boolean;
  skipClusters?: boolean;
  skipView?: boolean;
  skipCodeScan?: boolean;
  pretty?: boolean;
  format?: GraphFormat;
  /** Filter to a single topic (generates only that sub-graph + its HTML). */
  topic?: string;
}

export async function runGraph(opts: GraphCliOptions): Promise<string> {
  const log = getLogger();
  const startedAt = Date.now();
  const format: GraphFormat = opts.format ?? 'both';

  // 1. Build entity index from current indexed notes
  const indexedNotes = listAll({ includeExpired: false }).map((n) => ({
    id: n.id,
    title: n.title,
    tags: n.tags,
    topic: n.title || n.id,
  }));
  const entityIndex = buildEntityIndex(indexedNotes);
  log.debug({ entities: indexedNotes.length }, 'entity index built');

  // 2. Auto-link all notes (rewrite HTML if any new links would be added)
  let linksAdded = 0;
  let notesTouched = 0;
  if (!opts.skipAutolink) {
    const notes = readAllNotes();
    for (const note of notes) {
      if (!note.id) continue;
      const before = note.html;
      const { html: after, linksAdded: added } = applyAutoLinks(before, note.id, entityIndex);
      if (added > 0 && after !== before) {
        writeFileSync(note.path, after, 'utf8');
        try {
          indexNote(readNote(note.path));
        } catch (err) {
          log.warn({ path: note.path, err: (err as Error).message }, 'reindex after autolink');
        }
        linksAdded += added;
        notesTouched += 1;
      }
    }
  }

  // 3. Code scanning — bridge conversations to actual code
  let codeFilesAdded = 0;
  let codeProjects = 0;
  if (!opts.skipCodeScan) {
    const codeResults = await runCodeScan(listAll({ includeExpired: false }).map((n) => n.path));
    codeProjects = codeResults.length;
    for (const result of codeResults) {
      const noteHtmls = codeNodesToNotes(result);
      for (const html of noteHtmls) {
        try {
          const written = writeNote(html, { overwrite: true });
          try {
            indexNote(readNote(written.path));
          } catch (err) {
            log.warn({ path: written.path, err: (err as Error).message }, 'code note reindex');
          }
          codeFilesAdded += 1;
        } catch (err) {
          log.debug({ err: (err as Error).message }, 'code note write skipped');
        }
      }
    }
    // Write aggregate-neuron notes (module + project level)
    let codeAggregatesAdded = 0;
    for (const result of codeResults) {
      const descriptors = buildAggregateNeurons(result);
      for (const descriptor of descriptors) {
        try {
          const html = composeAggregateNeuron(descriptor);
          const written = writeNote(html, { overwrite: true });
          try {
            indexNote(readNote(written.path));
          } catch (err) {
            log.warn({ path: written.path, err: (err as Error).message }, 'aggregate note reindex');
          }
          codeAggregatesAdded += 1;
        } catch (err) {
          log.debug({ err: (err as Error).message }, 'aggregate note write skipped');
        }
      }
    }
    if (codeProjects > 0) {
      log.info(
        { projects: codeProjects, notes: codeFilesAdded, aggregates: codeAggregatesAdded },
        'code scan complete',
      );
    }
  }

  // 4. Build backlinks (post-autolink + post-code-scan, reflects full graph)
  const backlinks = buildBacklinks();
  const backlinksPath = saveBacklinks(backlinks);

  // 5. Cluster detection
  let clusterCount = 0;
  let clustersPath = '';
  if (!opts.skipClusters) {
    const previousClusters = loadClusters();
    const clusters = detectClusters(indexedNotes, backlinks, 20, previousClusters);
    clustersPath = saveClusters(clusters);
    clusterCount = clusters.cluster_count;
  }

  // 6. Knowledge graph (brain-graph.json)
  let knowledgeGraphPath = '';
  let globalGraphPath = '';
  let globalGraphStats = { projects: 0, crossEdges: 0, sharedEntities: 0 };
  const loadedClusters = loadClusters();
  if (loadedClusters) {
    const pagerank = computePageRank();
    const knowledgeGraph = buildKnowledgeGraphFromIndex(backlinks, loadedClusters, pagerank);
    knowledgeGraphPath = saveKnowledgeGraph(knowledgeGraph);

    // 6a. Per-project sub-graphs (one per top-level topic with >= 3 nodes)
    const cfg = getConfig();
    const topTopics = Object.keys(knowledgeGraph.stats.topTopics);
    for (const topic of topTopics) {
      const subGraph = extractSubGraph(knowledgeGraph, topic);
      if (subGraph.nodes.length >= 3) {
        const safeTopic = topic.replace(/[^a-z0-9-_]/gi, '_');
        const subPath = join(cfg.cachePath, `brain-graph-${safeTopic}.json`);
        writeFileSync(subPath, JSON.stringify(subGraph, null, 2), 'utf8');
        log.info(
          { topic, nodes: subGraph.nodes.length, edges: subGraph.edges.length },
          'sub-graph saved',
        );
      }
    }

    // 6b. Global cross-project graph
    try {
      const allNoteFiles = readAllNotes();
      const hierarchy = extractHierarchy(allNoteFiles);
      const globalGraph = buildGlobalGraph(knowledgeGraph, hierarchy);
      globalGraphPath = saveGlobalGraph(globalGraph);
      globalGraphStats = {
        projects: globalGraph.stats.totalProjects,
        crossEdges: globalGraph.stats.totalCrossEdges,
        sharedEntities: globalGraph.sharedEntities.length,
      };
      log.info(
        {
          projects: globalGraph.stats.totalProjects,
          crossEdges: globalGraph.stats.totalCrossEdges,
          sharedEntities: globalGraph.sharedEntities.length,
          densestPair: globalGraph.stats.densestPair,
        },
        'global graph saved',
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'global graph build failed');
    }

    // 6c. Dedup detection — report only, no auto-merge
    const allNotes = listAll({ includeExpired: false });
    const dedupResult = findDuplicates(allNotes);
    if (dedupResult.duplicatePairs.length > 0) {
      log.info(
        { duplicates: dedupResult.duplicatePairs.length },
        'potential duplicate notes detected',
      );
      for (const pair of dedupResult.duplicatePairs.slice(0, 10)) {
        log.debug(
          { noteA: pair.noteA, noteB: pair.noteB, similarity: pair.similarity.toFixed(3) },
          'duplicate pair',
        );
      }
    }
  }

  // 7. Static graph view (HTML)
  let viewPath = '';
  if (!opts.skipView && (format === 'html' || format === 'both')) {
    viewPath = renderGraphView(indexedNotes, backlinks, clusterCount);
  }

  // 8. Graph text (KGGen-style adjacency list for LLM ingestion)
  let textPath = '';
  if (format === 'text' || format === 'both') {
    textPath = renderGraphText(backlinks);
  }

  const result = {
    notes: indexedNotes.length,
    auto_links_added: linksAdded,
    notes_touched: notesTouched,
    code_projects_scanned: codeProjects,
    code_notes_added: codeFilesAdded,
    backlinks_total: backlinks.total_edges,
    cluster_count: clusterCount,
    backlinks_path: backlinksPath,
    clusters_path: clustersPath,
    view_path: viewPath,
    text_path: textPath,
    knowledge_graph_path: knowledgeGraphPath,
    global_graph_path: globalGraphPath,
    global_graph_projects: globalGraphStats.projects,
    global_graph_cross_edges: globalGraphStats.crossEdges,
    global_graph_shared_entities: globalGraphStats.sharedEntities,
    duration_ms: Date.now() - startedAt,
  };

  if (opts.pretty) {
    return [
      `Graph built in ${result.duration_ms}ms`,
      '─'.repeat(40),
      `Notes:          ${result.notes}`,
      `Auto-links:     ${result.auto_links_added} added across ${result.notes_touched} notes`,
      `Code scan:      ${result.code_projects_scanned} projects → ${result.code_notes_added} notes added`,
      `Backlinks:      ${result.backlinks_total} edges  → ${result.backlinks_path}`,
      `Clusters:       ${result.cluster_count}  → ${result.clusters_path}`,
      `Graph view:     ${result.view_path || '(skipped)'}`,
      `Graph text:     ${result.text_path || '(skipped)'}`,
      `Knowledge graph: ${result.knowledge_graph_path || '(skipped)'}`,
      `Global graph:   ${result.global_graph_projects} projects, ${result.global_graph_cross_edges} cross-edges, ${result.global_graph_shared_entities} shared entities`,
    ].join('\n');
  }
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Code scan helper
// ---------------------------------------------------------------------------

/**
 * Collect unique cwd values from note HTML files (via data-cerveau-cwd and
 * data-cerveau-source attributes), then scan each discovered project dir.
 *
 * Uses scanProjectAsync (AST-based) when available, falling back to the
 * synchronous regex scan on a per-file basis.
 */
async function runCodeScan(notePaths: string[]): Promise<CodeScanResult[]> {
  const cwds = new Set<string>();

  for (const notePath of notePaths) {
    let html = '';
    try {
      html = readFileSync(notePath, 'utf8');
    } catch {
      continue;
    }

    // data-cerveau-cwd — explicit working directory attribute
    const cwdMatch = html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
    if (cwdMatch?.[1]) cwds.add(cwdMatch[1]);

    // data-cerveau-source — may be an absolute directory path
    const srcMatch = html.match(/data-cerveau-source\s*=\s*["']([^"']+)["']/i);
    if (srcMatch?.[1]) {
      const src = srcMatch[1];
      // Only treat as a directory if it looks like an absolute path
      if ((src.startsWith('/') || /^[A-Z]:\\/i.test(src)) && existsSync(src)) {
        try {
          const s = statSync(src);
          if (s.isDirectory()) cwds.add(src);
        } catch { /* skip */ }
      }
    }
  }

  const results: CodeScanResult[] = [];
  for (const cwd of cwds) {
    try {
      // Prefer AST scan; falls back to regex per-file inside scanProjectAsync
      const result = await scanProjectAsync(cwd);
      if (result && result.nodes.length > 0) {
        results.push(result);
      }
    } catch {
      // Last resort: synchronous regex scan
      const result = scanProject(cwd);
      if (result && result.nodes.length > 0) {
        results.push(result);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------

interface GraphNoteRef {
  id: string;
  title: string;
  tags: string;
}

/**
 * Render a KGGen-style adjacency-list text file for LLM ingestion.
 * Format:
 *   [HUB] [#hub] · 12 inbound, 3 outbound
 *   [#auth-decision-12] —replaces→ [#jwt-impl-jan] (s=1.0)
 *   [#q2-audit] ←cited-by— 5 notes [#auth-decision-12, #sso-design, ...]
 *
 * One section per node that has ≥ 1 edge. Hubs (≥5 inbound) get [HUB] prefix.
 * Target: < 500ms on 200 notes using the pre-built backlinks cache.
 */
function renderGraphText(backlinks: BacklinksIndex): string {
  const root = brainRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const outPath = join(root, 'graph.txt');

  // Collect all node ids that have ≥1 edge
  const nodeSet = new Set<string>([
    ...Object.keys(backlinks.outgoing),
    ...Object.keys(backlinks.incoming),
  ]);

  const lines: string[] = [
    `# Brain graph — ${nodeSet.size} nodes, ${backlinks.total_edges} edges`,
    `# Generated: ${backlinks.generated}`,
    '',
  ];

  // Sort nodes: hubs first (descending inbound), then alphabetically
  const sortedNodes = [...nodeSet].sort((a, b) => {
    const inA = (backlinks.incoming[a] ?? []).length;
    const inB = (backlinks.incoming[b] ?? []).length;
    if (inB !== inA) return inB - inA;
    return a.localeCompare(b);
  });

  for (const nodeId of sortedNodes) {
    const outEdges = backlinks.outgoing[nodeId] ?? [];
    const inEdges = backlinks.incoming[nodeId] ?? [];
    const inCount = inEdges.length;
    const outCount = outEdges.length;

    if (inCount === 0 && outCount === 0) continue;

    const isHub = inCount >= 5;
    const hubPrefix = isHub ? '[HUB] ' : '';
    lines.push(`${hubPrefix}[#${nodeId}] · ${inCount} inbound, ${outCount} outbound`);

    // Outbound edges — one per line
    for (const edge of outEdges) {
      const strength = edge.auto ? '' : ' (s=1.0)';
      lines.push(`  [#${nodeId}] —${edge.type}→ [#${edge.to}]${strength}`);
    }

    // Inbound summary — compact when ≥ 3 inbound
    if (inCount >= 3) {
      const sampleIds = inEdges
        .slice(0, 5)
        .map((e) => `#${e.from}`)
        .join(', ');
      const extra = inCount > 5 ? ` +${inCount - 5} more` : '';
      lines.push(`  [#${nodeId}] ←cited-by— ${inCount} notes [${sampleIds}${extra}]`);
    } else {
      for (const edge of inEdges) {
        lines.push(`  [#${edge.from}] —${edge.type}→ [#${nodeId}]`);
      }
    }

    lines.push('');
  }

  writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

/**
 * Build a one-line graph topology summary for injection into LLM context.
 * Returns: "[GRAPH] N nodes, M edges. Top hubs: #x(12), #y(8), #z(5)."
 * Returns empty string when no backlinks data is available.
 */
export function buildGraphTopologySummary(backlinks: BacklinksIndex | null): string {
  if (!backlinks || backlinks.total_edges === 0) return '';

  const nodeSet = new Set<string>([
    ...Object.keys(backlinks.outgoing),
    ...Object.keys(backlinks.incoming),
  ]);

  // Rank hubs by inbound edge count
  const hubRanked = [...Object.entries(backlinks.incoming)]
    .map(([id, edges]) => ({ id, count: edges.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .filter((h) => h.count >= 2);

  const hubStr = hubRanked.map((h) => `#${h.id}(${h.count})`).join(', ');
  const hubPart = hubStr ? `. Top hubs: ${hubStr}` : '';
  return `[GRAPH] ${nodeSet.size} nodes, ${backlinks.total_edges} edges${hubPart}.`;
}

function renderGraphView(
  notes: GraphNoteRef[],
  backlinks: ReturnType<typeof buildBacklinks>,
  clusterCount: number,
): string {
  void clusterCount;
  const root = brainRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const outPath = join(root, 'graph.html');

  const nodes = notes.map((n) => ({ id: n.id, label: n.title || n.id, tags: n.tags }));
  const seen = new Set<string>();
  const edges: Array<{ from: string; to: string; type: string; auto: boolean }> = [];
  for (const list of Object.values(backlinks.outgoing ?? {})) {
    for (const e of list) {
      const key = `${e.from}→${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: e.from, to: e.to, type: e.type, auto: e.auto });
    }
  }

  const dataJson = JSON.stringify({ nodes, edges });
  const html = buildGraphHtml(dataJson);
  writeFileSync(outPath, html, 'utf8');
  return outPath;
}

const VIEW_TEMPLATE_PATHS = [
  new URL('../graph/view-template.html', import.meta.url),
  new URL('../../src/graph/view-template.html', import.meta.url),
];

function buildGraphHtml(dataJson: string): string {
  for (const tplPath of VIEW_TEMPLATE_PATHS) {
    try {
      const tpl = readFileSync(tplPath, 'utf8');
      return tpl.replace('"__DATA__"', dataJson);
    } catch { /* try next path */ }
  }
  return FALLBACK_TEMPLATE.replace('"__DATA__"', dataJson);
}

const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Brain graph</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html,body{margin:0;background:#0e0f12;color:#e6e8ee;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden}
  #info{position:fixed;top:12px;left:12px;background:#16181d;border:1px solid #262a33;border-radius:8px;padding:10px 14px;max-width:340px;z-index:10}
  #info h2{margin:0 0 6px;font-size:15px;color:#7dd3fc}
  #info p{margin:2px 0;font-size:12px;color:#8a93a6}
  canvas{display:block;cursor:grab}
  canvas:active{cursor:grabbing}
</style>
</head><body>
<div id="info"><h2>Brain graph</h2><p id="hover">Hover a node to inspect.</p><p id="stats"></p></div>
<canvas id="c"></canvas>
<script>
const data = "__DATA__";
const W = window.innerWidth, H = window.innerHeight;
const c = document.getElementById('c'); c.width = W; c.height = H;
const ctx = c.getContext('2d');
const nodes = data.nodes.map((n,i)=>({...n, x: Math.cos(i)*200+W/2, y: Math.sin(i*0.7)*200+H/2, vx:0, vy:0}));
const idx = new Map(nodes.map(n=>[n.id,n]));
const edges = data.edges.filter(e=>idx.has(e.from)&&idx.has(e.to));
document.getElementById('stats').textContent = nodes.length+' nodes, '+edges.length+' edges';
// Simple force-directed layout
function step(){
  // Repulsion
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
    const a=nodes[i], b=nodes[j];
    let dx=a.x-b.x, dy=a.y-b.y, d=Math.hypot(dx,dy)||0.01;
    const f = 600/(d*d);
    dx/=d; dy/=d;
    a.vx+=dx*f; a.vy+=dy*f; b.vx-=dx*f; b.vy-=dy*f;
  }
  // Attraction along edges
  for(const e of edges){
    const a=idx.get(e.from), b=idx.get(e.to);
    let dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy)||0.01;
    const f=(d-80)*0.02;
    dx/=d; dy/=d;
    a.vx+=dx*f; a.vy+=dy*f; b.vx-=dx*f; b.vy-=dy*f;
  }
  // Integrate + center pull
  for(const n of nodes){
    n.vx*=0.85; n.vy*=0.85;
    n.x+=n.vx; n.y+=n.vy;
    n.vx += (W/2-n.x)*0.002; n.vy += (H/2-n.y)*0.002;
  }
}
let hover=null;
c.addEventListener('mousemove',(ev)=>{
  let best=null, bd=20;
  for(const n of nodes){ const d=Math.hypot(n.x-ev.offsetX,n.y-ev.offsetY); if(d<bd){bd=d;best=n;}}
  hover=best;
  document.getElementById('hover').textContent = best ? best.label+' ('+best.tags+')' : 'Hover a node to inspect.';
});
function draw(){
  ctx.fillStyle='#0e0f12'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#262a33'; ctx.lineWidth=1;
  for(const e of edges){
    const a=idx.get(e.from), b=idx.get(e.to);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  for(const n of nodes){
    ctx.fillStyle = n===hover ? '#f0abfc' : '#7dd3fc';
    ctx.beginPath(); ctx.arc(n.x,n.y,6,0,Math.PI*2); ctx.fill();
    if(n===hover){
      ctx.fillStyle='#e6e8ee'; ctx.font='12px sans-serif';
      ctx.fillText(n.label, n.x+10, n.y+4);
    }
  }
}
function loop(){ step(); draw(); requestAnimationFrame(loop); }
loop();
</script></body></html>`;
