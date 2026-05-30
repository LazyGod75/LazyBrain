import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SALIENCY_GLYPH, type SaliencyKind } from '../annotator/saliency.js';
import { loadBacklinks } from '../graph/backlinks.js';
import { loadClusters } from '../graph/clusters.js';
import { loadKnowledgeGraph, type TopicTreeNode } from '../graph/knowledge-graph.js';
import { type IndexedNote, listAll, notesForCwdCount } from '../indexer/fts.js';
import { retentionScore } from '../retrieval/decay.js';
import { route } from '../retrieval/router.js';
import {
  type StrippedNote,
  stripNote,
  stripNoteToPrompt,
  stripSection,
} from '../retrieval/strip.js';
import { brainRoot } from '../store/paths.js';
import { readNote } from '../store/reader.js';
import { alreadyInjected, recordInjected } from '../util/session-cache.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { estimateTokenCount } from '../util/tokenize.js';
import { computePageRank } from '../graph/pagerank.js';
import { parseFileNeuronHtml } from '../graph/file-neuron-parse.js';
import { compressFileNeuron } from '../retrieval/compress-file-neuron.js';
import { slugifyCwd } from './build-clusters.js';
import { buildGraphTopologySummary } from './graph.js';
import { profileTextForInjection } from './profile-update.js';

export type InjectMode = 'session' | 'turn' | 'marker' | 'highlights';
export type InjectFormat = 'full' | 'compact';

export interface InjectContextCliOptions {
  maxTokens?: number;
  preferRecent?: boolean;
  preferImportant?: boolean;
  pretty?: boolean;
  mode?: InjectMode;
  format?: InjectFormat;
  query?: string;
  minScore?: number;
  cwd?: string;
  /** Q3: when present, the turn-inject will skip notes already shown to this session. */
  sessionId?: string;
}

const TYPE_ICON: Record<string, string> = {
  decision: 'D',
  episodic: 'E',
  reference: 'R',
  semantic: 'S',
  procedural: 'P',
};

const COMPACT_LEGEND =
  'Brain idx [MM-DD T #id title (tags)] D=decision E=episodic R=reference S=semantic P=procedural · `lazybrain query #id` for full.';

const MARKER_TRIVIAL_PROMPTS = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'continue',
  'go',
  'next',
  'merci',
  'thanks',
  'thx',
  'oui',
  'non',
  'cool',
  'parfait',
  'good',
  'nice',
  'stop',
  'wait',
  'super',
  'sure',
  'fine',
  'great',
  'allez',
  'vas-y',
  'go ahead',
  'roger',
  'done',
  'noted',
  'understood',
  'compris',
  'ack',
  'k',
  'kk',
  'yep',
  'nope',
]);

// Q5: triggers that explicitly *ask* for memory recall. Presence of any of
// these patterns forces a recall attempt even on short prompts.
const MEMORY_TRIGGERS = [
  /\b(did we|have we|what did we|we discussed|we decided|earlier|previously|last time|before)\b/i,
  /\b(rappel|rappelle|on a vu|on a déjà|on a fait|déjà parlé|déjà vu|on avait|tu te souviens)\b/i,
  /\b(remember|recall|past|history|context)\b/i,
  /#[a-z0-9-]{4,}/, // references to a short id from prior inject
];

// Q5: prompts that look like pure tool output, code, or pasted error — no
// memory needed because the context is right there in the prompt.
const SELF_CONTAINED_PATTERNS = [
  /^\s*[{[]/, // JSON / array dumps
  /^\s*\$\s/, // shell prompt prefix
  /^\s*(?:error|warning|exception|traceback|stderr|stdout):/i,
  /^\s*\/[a-z-]+(?:\s|$)/i, // slash command at start of line
];

function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  const norm = trimmed.toLowerCase().replace(/[!?.,;:]+$/g, '');
  if (norm.length < 12) return true;
  if (MARKER_TRIVIAL_PROMPTS.has(norm)) return true;
  // Memory triggers override every length/format heuristic below.
  for (const re of MEMORY_TRIGGERS) {
    if (re.test(trimmed)) return false;
  }
  for (const re of SELF_CONTAINED_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  // Long pure-code blocks: if there's no whitespace-separated word (just code
  // chars), skip recall.
  const wordCount = norm.split(/\s+/).filter((w) => /[a-zà-ÿ]{2,}/i.test(w)).length;
  if (wordCount < 3 && trimmed.length < 80) return true;
  return false;
}

function shortId(id: string): string {
  // Drop the leading date (10 chars + dash) when present; keep the slug.
  return id.replace(/^\d{4}-\d{2}-\d{2}-/, '').slice(0, 32);
}

function abbreviateTag(tag: string): string {
  const map: Record<string, string> = {
    typescript: 'ts',
    javascript: 'js',
    python: 'py',
    shell: 'sh',
    database: 'db',
    frontend: 'fe',
    docs: 'doc',
    config: 'cfg',
    refactor: 'rf',
    performance: 'perf',
    security: 'sec',
    testing: 'test',
  };
  return map[tag] ?? tag;
}

function stripRedundantDate(title: string, isoDate: string): string {
  // Many auto-titles start with the timestamp ("2026-05-22 Bash: out.js").
  return title.replace(new RegExp(`^${isoDate}\\s+`), '').trim();
}

function relationHints(n: IndexedNote): string {
  const parts: string[] = [];
  if (n.replaces) parts.push(`↺${n.replaces.split(',')[0]}`);
  if (n.causes) {
    const first = n.causes.split('|')[0];
    if (first && first.length > 0) parts.push(`∵${first.slice(0, 28)}`);
  }
  if (n.triples) {
    const t = n.triples.split(';')[0];
    if (t) parts.push(`◦${t}`);
  }
  return parts.length ? ` · ${parts.join(' ')}` : '';
}

function compactLine(n: IndexedNote & { saliency_kind?: string | null }): string {
  const isoDate = (n.created ?? '').slice(0, 10);
  const md = isoDate.slice(5); // MM-DD
  const icon = TYPE_ICON[n.type ?? ''] ?? '·';
  // Importance only shown when extreme (< 0.4 or ≥ 0.8) — silence the median.
  const importance =
    n.importance != null && (n.importance < 0.4 || n.importance >= 0.8)
      ? ` [${n.importance.toFixed(1)}]`
      : '';
  const tagList = n.tags ? n.tags.split(/\s+/).slice(0, 3).map(abbreviateTag).join(',') : '';
  const tags = tagList ? ` (${tagList})` : '';
  const rawTitle = (n.title ?? n.id).slice(0, 60);
  const title = stripRedundantDate(rawTitle, isoDate);
  const rels = relationHints(n);
  // Saliency glyph appended after type letter when present
  const saliency = n.saliency_kind
    ? (SALIENCY_GLYPH[n.saliency_kind as NonNullable<SaliencyKind>] ?? '')
    : '';
  const iconWithSaliency = saliency ? `${icon}${saliency}` : icon;
  return `${md} ${iconWithSaliency} #${shortId(n.id)} ${title}${tags}${importance}${rels}`
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Per-cluster headline: `clusters: llm=8 memory=5 auth=3` — gives the LLM a
 * map of "what topics live in the brain" in one line (~20 tokens).
 */
function clusterSummary(notes: IndexedNote[]): string {
  const counts = new Map<string, number>();
  for (const n of notes) {
    if (!n.tags) continue;
    for (const tag of n.tags.split(/\s+/).filter(Boolean)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return '';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `clusters: ${sorted.map(([t, c]) => `${abbreviateTag(t)}=${c}`).join(' ')}`;
}

const DEFAULT_TURN_MAX_TOKENS = 150;
// Per-level minimum score: BM25 scores are unbounded (typical 1-50), cosine ∈
// [0,1], reranker logits roughly [-15,15]. A single threshold can't fit all
// three, so we scale to whichever level actually answered.
const MIN_SCORE_BY_LEVEL: Record<string, number> = {
  L1: 0.5,
  L2: 0.5,
  L3: 0.45,
  L4: 0.0, // reranker monotonically picks the best; trust its ordering
};

/**
 * Build a compact stripped-text context to inject into Claude Code hooks.
 *
 * Two modes:
 *   - session (default): used by SessionStart. Stable, large (~3k tokens),
 *     sorted by id so identical brains produce identical output → cache-friendly.
 *   - turn: used by UserPromptSubmit. Tiny (~150 tokens), query-driven, with a
 *     relevance threshold. Returns empty string when nothing scores above it.
 */
export async function runInjectContext(opts: InjectContextCliOptions): Promise<string> {
  if (opts.mode === 'marker') return runMarkerInject(false, opts.cwd);
  if (opts.mode === 'highlights') return runMarkerInject(true, opts.cwd);
  if (opts.mode === 'turn') return runTurnInject(opts);
  return runSessionInject(opts);
}

/**
 * Render the topic tree as a compact text representation, max 2 levels deep.
 * Nodes with 0 notes are skipped. Sorted by noteCount descending.
 */
function renderTopicTree(nodes: TopicTreeNode[], indent: string = ''): string {
  const lines: string[] = [];
  const sorted = [...nodes].sort((a, b) => b.noteCount - a.noteCount);
  for (const node of sorted) {
    if (node.noteCount === 0) continue;
    const hubInfo = node.hubIds.length > 0 ? ` [${node.hubIds.length} hubs]` : '';
    lines.push(`${indent}${node.name}/ (${node.noteCount})${hubInfo}`);
    if (node.children.length > 0 && indent.length < 4) {
      lines.push(renderTopicTree(node.children, indent + '  '));
    }
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Ultra-minimal session injection: one line telling the LLM the brain exists,
 * how many notes are live, and which CLI to use on demand. ~25 tokens.
 *
 * When `highlights` is true, additionally emit the top-3 most-important note
 * one-liners + Wikipedia main-page block → ~300 tokens total.
 */
function runMarkerInject(highlights = false, cwd?: string): string {
  const start = Date.now();
  const all = listAll({ includeExpired: false });
  const notes = all.filter((n) => !n.path.endsWith('_user-profile.html'));

  const profile = profileTextForInjection();
  const profileLine = profile ? `[USER PROFILE]\n${profile}\n` : '';
  const marker = `[BRAIN] ${notes.length} notes available. Use the lazybrain-recall skill or run \`lazybrain search <query>\` / \`lazybrain query #<id>\`.`;

  // Topic tree from brain-graph.json (additive, silent if absent)
  let graphLines = '';
  try {
    const graph = loadKnowledgeGraph();
    if (graph?.topicTree && graph.topicTree.length > 0) {
      const treeText = renderTopicTree(graph.topicTree);
      if (treeText) graphLines += `\n${treeText}`;
    }
    const backlinks = loadBacklinks();
    const topologySummary = buildGraphTopologySummary(backlinks);
    if (topologySummary) graphLines += `\n${topologySummary}`;
  } catch {
    // best-effort: skip silently if brain-graph.json is absent or corrupt
  }

  let body = `${profileLine}${marker}${graphLines}`;

  if (highlights && notes.length > 0) {
    // Wikipedia main page block (opt-out via LAZYBRAIN_INJECT_MAINPAGE=0)
    if (process.env.LAZYBRAIN_INJECT_MAINPAGE !== '0') {
      const mainPage = buildMainPage(notes);
      if (mainPage) body += `\n${mainPage}`;
    } else {
      // Fallback to old cluster summary
      const cluster = clusterSummary(notes);
      if (cluster) body += `\n${cluster}`;
    }

    // [CLUSTER] — inject cluster atlas summary if cwd matches a known cluster
    if (cwd) {
      try {
        const slug = slugifyCwd(cwd);
        const clusterPath = join(brainRoot(), 'clusters', slug, '_cluster.html');
        if (existsSync(clusterPath)) {
          const clusterHtml = readFileSync(clusterPath, 'utf-8');
          // Extract metadata from <meta> tags
          const noteCountMatch = clusterHtml.match(/name="cluster-note-count"\s+content="(\d+)"/);
          const activeDecMatch = clusterHtml.match(
            /name="cluster-active-decisions"\s+content="(\d+)"/,
          );
          const hubsMatch = clusterHtml.match(/name="cluster-hubs"\s+content="([^"]+)"/);

          const noteCount = noteCountMatch ? noteCountMatch[1] : '?';
          const activeDec = activeDecMatch ? activeDecMatch[1] : '0';
          const hubs = hubsMatch ? hubsMatch[1].split(', ').slice(0, 2).join(', ') : '';

          let clusterLine = `[CLUSTER ${slug}] ${noteCount} neurons · ${activeDec} active decisions`;
          if (hubs) clusterLine += ` · hubs: ${hubs}`;
          body += `\n${clusterLine}`;
        }
      } catch {
        // best-effort
      }
    }

    // [PROJECT CONTEXT] — conditional on cwd
    if (cwd) {
      try {
        const cwdNotes = notesForCwdCount(cwd);
        if (cwdNotes.count > 0) {
          const decisions = cwdNotes.activeDecisions
            ? ` · active: ${cwdNotes.activeDecisions}`
            : '';
          body += `\n[PROJECT]\n  ${cwd}\n  ${cwdNotes.count} notes${decisions}`;
        }
      } catch {
        // best-effort
      }
    }

    // [LAST SESSION] — last 3 recent notes for current project (continuity)
    if (cwd) {
      try {
        const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
        const segments = normalized.split('/').filter(Boolean);
        const SKIP = new Set([
          'documents',
          'users',
          'home',
          'desktop',
          'projects',
          'repos',
          'src',
          'dev',
          'code',
          'workspace',
        ]);
        let projectSlug = '';
        for (let i = segments.length - 1; i >= 0; i--) {
          const seg = segments[i].toLowerCase();
          if (seg.length < 2 || /^[a-z]:?$/.test(seg) || SKIP.has(seg)) continue;
          projectSlug = seg.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
          break;
        }
        if (projectSlug) {
          const projectNotes = notes
            .filter((n) =>
              ((n as IndexedNote & { topic?: string }).topic ?? '')
                .toLowerCase()
                .startsWith(projectSlug),
            )
            .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));

          // Show last 3 notes with expanded TLDRs
          const lastThree = projectNotes.slice(0, 3);
          if (lastThree.length > 0) {
            body += '\n[LAST SESSION]';
            for (const note of lastThree) {
              const title = (note.title ?? '').slice(0, 80);
              const date = (note.created ?? '').slice(0, 10);
              body += `\n  ${date} ${title}`;
              try {
                const noteFile = readNote(note.path);
                const tldr = stripSection(noteFile.html, 'section[data-section="tldr"]');
                if (tldr) body += `\n    ${tldr.slice(0, 250)}`;
              } catch {
                /* best-effort */
              }
            }
          }

          // [KEY FEATURES] — all notes grouped by sub-topic for this project
          const groupedBySubTopic = new Map<string, IndexedNote[]>();
          for (const n of projectNotes) {
            const topic = ((n as IndexedNote & { topic?: string }).topic ?? '').toLowerCase();
            // Extract sub-topic after project slug (e.g., "myproject/coach-features" -> "coach-features")
            const parts = topic.split('/');
            const subTopic = parts.length > 1 ? parts.slice(1).join('/') : '_general';
            if (!groupedBySubTopic.has(subTopic)) {
              groupedBySubTopic.set(subTopic, []);
            }
            groupedBySubTopic.get(subTopic)!.push(n);
          }

          const keyFeatureLines: string[] = [];
          for (const [subTopic, subNotes] of [...groupedBySubTopic.entries()].sort(
            (a, b) => b[1].length - a[1].length,
          )) {
            // Cap at 15 notes total to control token budget
            if (keyFeatureLines.length >= 15) break;

            // Get the most important note for this sub-topic for its TLDR
            const best = subNotes.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
            if (!best) continue;

            try {
              const noteFile = readNote(best.path);
              const tldr = stripSection(noteFile.html, 'section[data-section="tldr"]');
              const tldrText = tldr ? tldr.slice(0, 150) : (best.title ?? '').slice(0, 80);
              const fullPath = subTopic === '_general' ? projectSlug : `${projectSlug}/${subTopic}`;
              keyFeatureLines.push(`  ${fullPath}: ${tldrText}`);
            } catch {
              // Fallback to title
              const fullPath = subTopic === '_general' ? projectSlug : `${projectSlug}/${subTopic}`;
              keyFeatureLines.push(`  ${fullPath}: ${(best.title ?? '').slice(0, 80)}`);
            }
          }

          if (keyFeatureLines.length > 0) {
            body += `\n\n[KEY FEATURES ${projectSlug}]\n${keyFeatureLines.join('\n')}`;
          }
        }
      } catch {
        // best-effort
      }
    }

    // [RECALL] — ultra-compact query hint
    try {
      body += `\n[RECALL] L1 CSS: \`lazybrain query 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])'\` | L2: \`lazybrain search "<topic>" --top 5\``;
    } catch {
      // best-effort
    }
  }

  logTelemetry({
    event: 'inject',
    ts: nowIso(),
    tokens: estimateTokenCount(body),
    sections: notes.length > 0 ? (highlights ? 2 : 1) : 0,
    duration_ms: Date.now() - start,
  });
  return body;
}

/**
 * Hierarchical main page: project/feature structure with integrated TLDR, decision
 * counts, warnings, and active decisions. Replaces flat [CONCEPTS], [TOPIC TREE],
 * [ACTIVE DECISIONS] with a scannable hierarchy. Target: ≤ 200 extra tokens.
 */
function buildMainPage(_notes: IndexedNote[]): string {
  const parts: string[] = [];

  // Build project/feature hierarchy
  const projects = new Map<string, Map<string, IndexedNote[]>>();
  const uncategorized: IndexedNote[] = [];

  for (const n of _notes) {
    const topic = n.topic;
    if (!topic) {
      uncategorized.push(n);
      continue;
    }
    const segments = topic.split('/');
    const project = segments[0];
    const feature = segments[1] || '_general';

    if (!projects.has(project)) projects.set(project, new Map());
    const proj = projects.get(project)!;
    if (!proj.has(feature)) proj.set(feature, []);
    proj.get(feature)!.push(n);
  }

  // Project summaries with per-feature lines
  for (const [projectName, features] of [...projects.entries()].sort((a, b) => {
    // Sort by total note count descending
    const aCount = [...a[1].values()].reduce((s, arr) => s + arr.length, 0);
    const bCount = [...b[1].values()].reduce((s, arr) => s + arr.length, 0);
    return bCount - aCount;
  })) {
    const totalNotes = [...features.values()].reduce((s, arr) => s + arr.length, 0);
    const featureLines: string[] = [];

    for (const [featureName, featureNotes] of [...features.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      if (featureName === '_general') continue;

      // Find the best TLDR for this feature (highest importance)
      const bestNote = featureNotes.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
      const tldr = (bestNote?.title ?? '').slice(0, 50);

      // Count types
      const dCount = featureNotes.filter((n) => n.type === 'decision').length;
      const wCount = featureNotes.filter((n) => n.warnings?.trim()).length;
      const eCount = featureNotes.filter(
        (n) =>
          (n.tags ?? '').includes('bug') ||
          (n.tags ?? '').includes('error') ||
          (n.tags ?? '').includes('critical'),
      ).length;

      const counts: string[] = [];
      if (dCount > 0) counts.push(`D:${dCount}`);
      if (wCount > 0) counts.push(`W:${wCount}`);
      if (eCount > 0) counts.push(`E:${eCount}`);

      const countStr = counts.length > 0 ? ` | ${counts.join(' ')}` : '';
      featureLines.push(`  ${featureName}: ${tldr}${countStr}`);
    }

    if (featureLines.length > 0) {
      parts.push(`${projectName}/ (${totalNotes} notes)\n${featureLines.slice(0, 8).join('\n')}`);
    } else {
      parts.push(`${projectName}/ (${totalNotes} notes)`);
    }
  }

  // Uncategorized count
  if (uncategorized.length > 5) {
    parts.push(`_other/ (${uncategorized.length} notes)`);
  }

  // Scoped warnings
  const allWarnings: string[] = [];
  for (const [projectName, features] of projects) {
    for (const [featureName, featureNotes] of features) {
      for (const n of featureNotes) {
        const w = n.warnings;
        if (w?.trim()) {
          const firstWarning = w.split('|')[0].trim().slice(0, 80);
          const scope = featureName !== '_general' ? `${projectName}/${featureName}` : projectName;
          allWarnings.push(`  ! ${scope}: ${firstWarning}`);
        }
      }
    }
  }
  if (allWarnings.length > 0) {
    parts.push(`[WARNINGS]\n${allWarnings.slice(0, 5).join('\n')}`);
  }

  // Scoped active decisions
  const allDecisions: string[] = [];
  for (const [projectName, features] of projects) {
    for (const [featureName, featureNotes] of features) {
      for (const n of featureNotes) {
        if (n.type !== 'decision') continue;
        if (n.valid_until) continue; // Skip expired
        const scope = featureName !== '_general' ? `${projectName}/${featureName}` : projectName;
        const title = (n.title ?? '').slice(0, 60);
        allDecisions.push(`  D ${scope}: ${title}`);
      }
    }
  }
  if (allDecisions.length > 0) {
    parts.push(`[DECISIONS]\n${allDecisions.slice(0, 5).join('\n')}`);
  }

  // Keep stubs
  try {
    const allNotes = listAll({ includeExpired: false });
    const stubs = allNotes.filter((n) => n.quality === 'stub').slice(0, 5);
    if (stubs.length > 0) {
      const ids = stubs.map((n) => `#${shortId(n.id)}`).join(', ');
      parts.push(`[STUBS] ${stubs.length} notes need expansion: ${ids}`);
    }
  } catch {
    // best-effort
  }

  return parts.join('\n');
}

/**
 * PageRank percentile threshold below which file-neurons are rendered in
 * skeleton-only mode (maximally compact). Files above this percentile get the
 * full signature representation. Value of 0.4 means the bottom 40% of
 * file-neurons by PageRank score get skeleton treatment.
 */
const SKELETON_PAGERANK_PERCENTILE = 0.4;

/**
 * Weight for blending PageRank into the retention score.
 * Combined score = retention * (1 + PAGERANK_WEIGHT * normalizedPageRank)
 * where normalizedPageRank is scaled to [0, 1] within the note set.
 * A weight of 0.5 gives PageRank meaningful influence without overwhelming
 * Ebbinghaus retention (recency + importance + access).
 */
const PAGERANK_BLEND_WEIGHT = 0.5;

function runSessionInject(opts: InjectContextCliOptions): string {
  const start = Date.now();
  const budget = opts.maxTokens ?? 3000;
  const format = opts.format ?? 'full';
  const all = listAll({ includeExpired: false });

  const batches = all.filter((n) => n.path.includes('batches')).slice(0, 5);
  const notes = all
    .filter((n) => !n.path.includes('batches'))
    .filter((n) => !n.path.endsWith('_user-profile.html'));

  // Load PageRank scores (cached, 6h TTL). Gracefully degrade if unavailable.
  let pagerankScores: Record<string, number> = {};
  try {
    const pr = computePageRank({ noCache: false });
    pagerankScores = pr.scores;
  } catch {
    // best-effort: continue without PageRank if graph is unavailable
  }

  // Normalize PageRank scores to [0, 1] within the current note set so the
  // blend weight is stable regardless of score magnitude.
  const prValues = notes.map((n) => pagerankScores[n.id] ?? 0);
  const prMax = Math.max(...prValues, 1e-9);
  const normalizedPr = new Map<string, number>(
    notes.map((n, i) => [n.id, (prValues[i] ?? 0) / prMax]),
  );

  // Q6: Ebbinghaus retention scoring blended with PageRank.
  // Combined score = retention * (1 + PAGERANK_BLEND_WEIGHT * normalizedPageRank)
  // This makes high-PageRank neurons (hub files) float up while keeping
  // recency and importance as the primary signal.
  const now = Date.now();
  const scored = notes.map((n) => {
    const retention = retentionScore(n, now);
    const pr = normalizedPr.get(n.id) ?? 0;
    const combined = retention * (1 + PAGERANK_BLEND_WEIGHT * pr);
    return { note: n, score: combined, pr };
  });
  scored.sort((a, b) => b.score - a.score);

  // Compute PageRank percentile threshold for skeleton-only mode on file-neurons.
  // Use the indexed `type` field (= data-cerveau-type stored at index time) — O(1),
  // no disk I/O per note.
  const fileNeuronPrValues = scored
    .filter((s) => s.note.type === 'file-neuron')
    .map((s) => s.pr)
    .sort((a, b) => a - b);
  const thresholdIdx = Math.floor(fileNeuronPrValues.length * SKELETON_PAGERANK_PERCENTILE);
  const skeletonPrThreshold = fileNeuronPrValues[thresholdIdx] ?? 0;

  const sections: string[] = [];
  let tokens = 0;

  const profile = profileTextForInjection();
  if (profile) {
    const profileBlock = `[USER PROFILE]\n${profile}`;
    sections.push(profileBlock);
    tokens += estimateTokenCount(profileBlock);
  }

  // Headline notes (full strip): top 3 in compact mode, all in full mode.
  const headlineLimit = format === 'compact' ? 3 : scored.length;
  const headlineSet = new Set(scored.slice(0, headlineLimit).map((s) => s.note.id));

  const backlinks = loadBacklinks();
  const clusters = loadClusters();

  // 1) Batches first (already consolidated)
  for (const b of batches) {
    if (tokens >= budget) break;
    const piece = renderFull(b, backlinks, clusters);
    if (!piece) continue;
    const estimated = estimateTokenCount(piece);
    if (tokens + estimated > budget && sections.length > 0) continue;
    sections.push(`[BATCH]\n${piece}`);
    tokens += estimated;
  }

  // 2) Headline notes: file-neurons get compressed representations; other notes
  //    get the full strip. Id-sorted within for cache stability.
  const headlineNotes = notes.filter((n) => headlineSet.has(n.id));
  headlineNotes.sort((a, b) => a.id.localeCompare(b.id));
  for (const n of headlineNotes) {
    if (tokens >= budget) break;

    // Attempt compressed representation for file-neurons
    const compressed = tryCompressFileNeuron(n.path, normalizedPr.get(n.id) ?? 0, skeletonPrThreshold);
    if (compressed !== null) {
      const estimated = estimateTokenCount(compressed);
      if (tokens + estimated > budget && sections.length > 0) continue;
      sections.push(`[FILE]\n${compressed}`);
      tokens += estimated;
      continue;
    }

    const piece = renderFull(n, backlinks, clusters);
    if (!piece) continue;
    const estimated = estimateTokenCount(piece);
    if (tokens + estimated > budget && sections.length > 0) continue;
    sections.push(`[NOTE]\n${piece}`);
    tokens += estimated;
  }

  // 3) Tail in compact mode: legend once, then one line per remaining note
  if (format === 'compact') {
    const tail = notes.filter((n) => !headlineSet.has(n.id));
    tail.sort((a, b) => a.id.localeCompare(b.id));
    const lines = tail.map(compactLine).filter(Boolean);
    if (lines.length > 0) {
      const indexBlock = `[INDEX]\n${COMPACT_LEGEND}\n${lines.join('\n')}`;
      const estimated = estimateTokenCount(indexBlock);
      if (tokens + estimated <= budget || sections.length === 0) {
        sections.push(indexBlock);
        tokens += estimated;
      }
    }
  }

  const output = sections.join('\n\n').trim();
  const duration = Date.now() - start;
  logTelemetry({
    event: 'inject',
    ts: nowIso(),
    tokens,
    sections: sections.length,
    duration_ms: duration,
  });

  if (opts.pretty) {
    return `# Brain context — ${sections.length} blocks, ~${tokens} tokens (${duration}ms, format=${format})\n\n${output}`;
  }
  return output;
}

/**
 * Try to read a note at `notePath` and compress it as a file-neuron.
 * Returns the compressed string if the note is a valid file-neuron, null otherwise.
 * Uses skeletonOnly when the note's normalizedPr is below the threshold.
 */
function tryCompressFileNeuron(
  notePath: string,
  normalizedPr: number,
  skeletonThreshold: number,
): string | null {
  try {
    const file = readNote(notePath);
    const codeNode = parseFileNeuronHtml(file.html);
    if (!codeNode) return null;
    const skeletonOnly = normalizedPr < skeletonThreshold;
    return compressFileNeuron(codeNode, { skeletonOnly });
  } catch {
    return null;
  }
}

function renderFull(
  n: IndexedNote,
  backlinks: ReturnType<typeof loadBacklinks>,
  clusters: ReturnType<typeof loadClusters>,
): string | null {
  try {
    const file = readNote(n.path);
    const stripped = stripNote(file.html);
    let prompt = stripNoteToPrompt(stripped);
    // Graph footer is only added when there's a meaningful signal (≥2 links
    // OR cluster + ≥1 link). Plain cluster labels are noise at compact tier.
    const inbound = backlinks?.incoming[n.id]?.length ?? 0;
    const outbound = backlinks?.outgoing[n.id]?.length ?? 0;
    const links = inbound + outbound;
    const cluster = clusters?.members[n.id];
    const clusterLabel = cluster !== undefined ? clusters?.labels[cluster] : undefined;
    if (links >= 2 || (links >= 1 && clusterLabel)) {
      const parts: string[] = [];
      if (clusterLabel) parts.push(`c=${clusterLabel}`);
      parts.push(`l:${inbound}/${outbound}`);
      prompt += ` · ${parts.join(' ')}`;
    }
    return prompt;
  } catch {
    return null;
  }
}

function tryFeatureMapInject(query: string, _cwd?: string): string | null {
  const lower = query.toLowerCase().trim();
  const allNotes = listAll({ includeExpired: false });

  // Build project/feature index
  const projects = new Map<string, Map<string, IndexedNote[]>>();
  for (const n of allNotes) {
    const topic = n.topic;
    if (!topic) continue;
    const parts = topic.split('/');
    const proj = parts[0];
    const feat = parts[1] || '_general';
    if (!projects.has(proj)) projects.set(proj, new Map());
    const p = projects.get(proj)!;
    if (!p.has(feat)) p.set(feat, []);
    p.get(feat)!.push(n);
  }

  // Check if query matches a project name
  for (const [projName, features] of projects) {
    if (lower.includes(projName)) {
      // Return project overview with all features
      const lines: string[] = [`[${projName}/ map]`];
      for (const [featName, featNotes] of [...features.entries()].sort(
        (a, b) => b[1].length - a[1].length,
      )) {
        if (featName === '_general') continue;
        const decisions = featNotes.filter((n) => n.type === 'decision' && !n.valid_until);
        const warnings = featNotes.filter((n) => n.warnings);
        const best = featNotes.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
        const tldr = (best?.title ?? '').slice(0, 60);

        let line = `  ${featName}: ${tldr}`;
        const counts: string[] = [];
        if (decisions.length) counts.push(`D:${decisions.length}`);
        if (warnings.length) counts.push(`W:${warnings.length}`);
        if (counts.length) line += ` | ${counts.join(' ')}`;
        lines.push(line);

        // Show decision titles for this feature
        for (const d of decisions.slice(0, 2)) {
          lines.push(`    D ${(d.title ?? '').slice(0, 50)}`);
        }
        // Show warnings for this feature
        for (const w of warnings.slice(0, 1)) {
          const wText = (w.warnings ?? '').split('|')[0].slice(0, 60);
          lines.push(`    ! ${wText}`);
        }
      }

      // Also check for specific feature match
      for (const [featName, featNotes] of features) {
        if (lower.includes(featName) && featName !== '_general') {
          lines.push(`\n  [${projName}/${featName} detail]`);
          for (const n of featNotes
            .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
            .slice(0, 5)) {
            const type = n.type === 'decision' ? 'D' : n.type === 'reference' ? 'R' : 'E';
            lines.push(`    ${type} ${(n.title ?? '').slice(0, 60)}`);
          }
        }
      }

      return lines.join('\n');
    }
  }

  return null;
}

type QueryIntent = 'reasoning' | 'warning' | 'quick' | 'detailed';

function detectQueryIntent(query: string): QueryIntent {
  const lower = query.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  // Reasoning: why/how/explain questions
  if (/^(why|how|explain|pourquoi|comment)\b/i.test(lower)) return 'reasoning';

  // Warning: should/can/avoid/risk questions
  if (/^(should|can|could|avoid|risk|danger|warning|attention|est-ce que)\b/i.test(lower))
    return 'warning';
  if (/\b(safe|careful|pitfall|anti.?pattern|don'?t)\b/i.test(lower)) return 'warning';

  // Quick: short queries (< 5 words, no question words)
  if (words.length <= 4 && !/\?$/.test(lower)) return 'quick';

  // Default: detailed
  return 'detailed';
}

function selectiveStripForTurn(hitPath: string, note: StrippedNote, intent: QueryIntent): string {
  if (intent === 'detailed') {
    return stripNoteToPrompt(note);
  }

  // Try to read the raw HTML for selective stripping
  let rawHtml: string;
  try {
    const noteFile = readNote(hitPath);
    rawHtml = noteFile.html;
  } catch {
    // Fallback to full strip if we can't read the file
    return stripNoteToPrompt(note);
  }

  const TYPE_LETTER: Record<string, string> = {
    decision: 'D',
    episodic: 'E',
    reference: 'R',
    semantic: 'S',
    procedural: 'P',
  };
  const header = `${TYPE_LETTER[note.type ?? ''] ?? '·'} ${(note.created ?? '').slice(0, 10)} #${(note.id ?? '').replace(/^\d{4}-\d{2}-\d{2}-/, '').slice(0, 32)}`;

  if (intent === 'quick') {
    // TLDR only — minimal tokens
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    if (tldr) return `${header}\n  ${tldr}`;
    // Fallback: first fact
    const summary = stripSection(rawHtml, 'details[open] summary');
    if (summary) return `${header}\n  ${summary}`;
    return stripNoteToPrompt(note);
  }

  if (intent === 'reasoning') {
    // Reasoning section + TLDR for context
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    const reasoning = stripSection(rawHtml, 'section[data-section="reasoning"]');
    const parts = [header];
    if (tldr) parts.push(`  ${tldr}`);
    if (reasoning) parts.push(`  [reasoning] ${reasoning}`);
    if (parts.length > 1) return parts.join('\n');
    return stripNoteToPrompt(note);
  }

  if (intent === 'warning') {
    // Warnings + TLDR
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    const warnings = stripSection(rawHtml, 'aside[role="doc-warning"]');
    const tips = stripSection(rawHtml, 'aside[role="doc-tip"]');
    const parts = [header];
    if (tldr) parts.push(`  ${tldr}`);
    if (warnings) parts.push(`  [WARNING] ${warnings}`);
    if (tips) parts.push(`  [TIP] ${tips}`);
    if (parts.length > 1) return parts.join('\n');
    return stripNoteToPrompt(note);
  }

  return stripNoteToPrompt(note);
}

async function runTurnInject(opts: InjectContextCliOptions): Promise<string> {
  const start = Date.now();
  const query = (opts.query ?? '').trim();
  if (!query || isTrivialPrompt(query)) {
    logTelemetry({
      event: 'inject',
      ts: nowIso(),
      tokens: 0,
      sections: 0,
      duration_ms: Date.now() - start,
    });
    return '';
  }

  const budget = opts.maxTokens ?? DEFAULT_TURN_MAX_TOKENS;

  // Feature map injection: if query mentions a known project, return the map
  const featureMap = tryFeatureMapInject(query, opts.cwd);
  if (featureMap) {
    const tokens = estimateTokenCount(featureMap);
    if (tokens <= budget) {
      logTelemetry({
        event: 'inject',
        ts: nowIso(),
        tokens,
        sections: 1,
        duration_ms: Date.now() - start,
      });
      return opts.pretty ? `# Feature map — ~${tokens} tokens\n\n${featureMap}` : featureMap;
    }
  }

  // Q3: differential injection — overfetch then drop notes the LLM has already
  // seen earlier in this session, so each turn pays only for net-new context.
  const result = await route({
    query,
    topK: 5,
    level: 'auto',
    cwd: opts.cwd,
    hydrateNote: true,
  });

  // Pick the minScore floor that matches the level actually used. Callers can
  // still override via opts.minScore; default scales by level to keep BM25
  // strict and cosine permissive.
  const minScore = opts.minScore ?? MIN_SCORE_BY_LEVEL[result.levelUsed] ?? 0.45;

  const seen = alreadyInjected(opts.sessionId);
  const relevant = result.hits.filter((h) => h.score >= minScore).filter((h) => !seen.has(h.id));

  if (relevant.length === 0) {
    logTelemetry({
      event: 'inject',
      ts: nowIso(),
      tokens: 0,
      sections: 0,
      duration_ms: Date.now() - start,
    });
    return '';
  }

  const sections: string[] = [];
  const accepted: string[] = [];
  let tokens = 0;
  const intent = detectQueryIntent(query);
  for (const hit of relevant) {
    if (!hit.note) continue;

    // Attempt compressed file-neuron representation first (Item 1).
    // File-neurons carry the richest code context; compressFileNeuron is far
    // more token-efficient than generic stripNoteToPrompt on their HTML.
    const compressed = tryCompressFileNeuron(hit.path, 0, 0);
    if (compressed !== null) {
      const estimated = estimateTokenCount(compressed);
      if (tokens + estimated > budget && sections.length > 0) break;
      sections.push(`[FILE]\n${compressed}`);
      accepted.push(hit.id);
      tokens += estimated;
      if (tokens >= budget) break;
      continue;
    }

    const prompt = selectiveStripForTurn(hit.path, hit.note, intent);
    const estimated = estimateTokenCount(prompt);
    if (tokens + estimated > budget && sections.length > 0) break;
    sections.push(`[RECALL]\n${prompt}`);
    accepted.push(hit.id);
    tokens += estimated;
    if (tokens >= budget) break;
  }
  recordInjected(opts.sessionId, accepted);

  const output = sections.join('\n\n').trim();
  logTelemetry({
    event: 'inject',
    ts: nowIso(),
    tokens,
    sections: sections.length,
    duration_ms: Date.now() - start,
  });

  if (opts.pretty && output) {
    return `# Brain recall — ${sections.length} hits, ~${tokens} tokens\n\n${output}`;
  }
  return output;
}
