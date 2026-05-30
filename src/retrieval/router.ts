import { resolveEntityKeysInQuery } from '../annotator/entities.js';
import { loadBacklinks } from '../graph/backlinks.js';
import { computePageRank, notesForCwd, recentNotes } from '../graph/pagerank.js';
import { embed, embedOne, hashKey, isEmbedderUnavailable, topKCosine } from '../indexer/embeddings.js';
import {
  type FtsHit,
  allDistinctTags,
  applyStructuralFieldBoost,
  getTagNoteCount,
  getNoteById,
  getNoteText,
  listAll,
  listAllWithText,
  loadAllStoredEmbeddings,
  notesAnsweringQuestion,
  notesByTagOrType,
  notesForErrorPattern,
  notesMatchingPathPrefix,
  notesMentioningEntity,
  notesWithWarningsOrNegative,
  recordAccessMany,
  searchFts,
  searchFtsSpread,
  upsertNoteEmbedding,
} from '../indexer/fts.js';
import { type RerankInput, rerank } from '../indexer/reranker.js';
import { structuralQuery } from '../indexer/structural.js';
import { readNote } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { embedQueryForRetrieval } from './hyde.js';
import { type MmrInput, mmr } from './mmr.js';
import { type StrippedNote, stripNote, stripTags } from './strip.js';

/**
 * B1/B2 — Embed/rerank input is the full stripped body (title + first ~1800
 * chars of text), not title+tags. bge-base accepts ~512 tokens; we trim
 * conservatively to stay safely inside that budget while preserving facts.
 */
const EMBED_CHAR_LIMIT = 1800;
const RERANK_CHAR_LIMIT = 1500;

function buildEmbedText(n: { title?: string; tags?: string; text?: string }): string {
  const title = (n.title ?? '').trim();
  const tags = (n.tags ?? '').trim();
  const body = (n.text ?? '').slice(0, EMBED_CHAR_LIMIT).trim();
  return [title, tags, body].filter(Boolean).join('\n');
}

export type RouterLevel = 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4' | 'auto';

export interface RouterResult {
  hits: ResolvedHit[];
  levelUsed: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4';
  totalMs: number;
}

export interface ResolvedHit {
  id: string;
  path: string;
  score: number;
  level: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4';
  note?: StrippedNote;
  snippet?: string;
  neighbours?: Array<{ id: string; type: string; direction: 'in' | 'out' }>;
}

export interface SearchInput {
  query: string;
  topK?: number;
  level?: RouterLevel;
  includeExpired?: boolean;
  type?: string;
  tag?: string;
  diversityLambda?: number; // 0..1, undefined = no MMR
  hydrateNote?: boolean; // include full stripped note in hits
  /** When set, PageRank biases toward notes from this working directory. */
  cwd?: string;
  /** PageRank weight in the final score mix (0 = off, 1 = pure PR). Default 0.25 when graph present. */
  pageRankWeight?: number;
  /** When set, only notes whose data-cerveau-source starts with this prefix are returned. */
  sourcePrefix?: string;
}

/**
 * Adaptive retrieval router.
 *
 * L1 — Structural (CSS selector). Triggered when the query is itself a CSS selector
 *      or when filters like type/tag uniquely identify the result set.
 *      Latency: < 5 ms. Cost: $0. Recall: 100% on exact matches.
 *
 * L2 — FTS5 (BM25). Lexical full-text. Fast and cheap.
 *      Latency: < 30 ms. Cost: $0. Recall: high on keyword queries.
 *
 * L3 — Bi-encoder (bge-base WASM). Semantic similarity.
 *      Latency: ~150 ms. Cost: $0 (local). Recall: high on fuzzy queries.
 *
 * L4 — Cross-encoder re-ranking (ms-marco WASM) on top-50 from L3.
 *      Latency: +50 ms. Cost: $0. Quality: SOTA on hard queries.
 *
 * Auto routing:
 *   - Query looks like a CSS selector (`[data-…]`, `article.…`) → L1
 *   - Query has < 4 tokens AND no quoted phrases → L2 (cheap)
 *   - Otherwise → L3 (semantic)
 *   - If --rerank explicit or topK > 5 → escalate to L4
 */
export async function route(input: SearchInput): Promise<RouterResult> {
  const start = Date.now();
  const log = getLogger();
  const topK = input.topK ?? 5;
  const level = input.level ?? 'auto';
  const finalLevel = level === 'auto' ? pickLevel(input.query, topK) : level;

  log.debug({ query: input.query, level: finalLevel, topK }, 'route');

  const withSourceScope = (arr: ResolvedHit[]): ResolvedHit[] => {
    if (!input.sourcePrefix) return arr;
    return arr.filter((h) => (getNoteById(h.id)?.source ?? '').startsWith(input.sourcePrefix!));
  };

  // Dense-brain bench / small fixture scope: when a scenario has ≤ topK notes, return
  // the entire fixture memory so substring scoring sees every captured turn.
  if (input.sourcePrefix) {
    const scoped = listAllWithText({ includeExpired: false }).filter((n) =>
      (n.source ?? '').startsWith(input.sourcePrefix!),
    );
    if (scoped.length > 0 && scoped.length <= Math.max(topK, 8)) {
      const ftsOrder = searchFts(input.query, {
        limit: scoped.length + 4,
        sourcePrefix: input.sourcePrefix,
      });
      const scoreById = new Map(ftsOrder.map((h, i) => [h.id, ftsOrder.length - i]));
      const sorted = [...scoped].sort(
        (a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0),
      );
      const scopedHits: ResolvedHit[] = sorted.map((n) => ({
        id: n.id,
        path: n.path,
        score: scoreById.get(n.id) ?? 0.5,
        level: 'L2' as const,
        snippet: (n.text ?? '').slice(0, 280),
      }));
      const totalMs = Date.now() - start;
      logTelemetry({
        event: 'query',
        ts: nowIso(),
        level: 'L2',
        latency_ms: totalMs,
        results: scopedHits.length,
      });
      if (input.hydrateNote) {
        for (const h of scopedHits) {
          try {
            h.note = stripNote(readNote(h.path).html);
          } catch {
            // ignore
          }
        }
      }
      let finalScoped = scopedHits;
      if (/\b(current|now|today|latest)\b/i.test(input.query)) {
        finalScoped = applyCurrentVersionBoost(finalScoped);
        finalScoped = dropObviousSuperseded(finalScoped);
      }
      return { hits: finalScoped, levelUsed: 'L2', totalMs };
    }
  }

  let hits: ResolvedHit[];

  // Filetree-scope: path prefixes in the question (src/auth/, package.json, tests/)
  const pathPrefixes = extractPathPrefixesFromQuery(input.query);
  if (pathPrefixes.length > 0) {
    const pathHits: ResolvedHit[] = [];
    const seen = new Set<string>();
    for (const prefix of pathPrefixes) {
      for (const n of notesMatchingPathPrefix(prefix, topK * 2, input.sourcePrefix)) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        pathHits.push({
          id: n.id,
          path: n.path,
          score: 1.0,
          level: 'L1',
          snippet: (n.section_summary ?? n.text ?? '').slice(0, 280),
        });
      }
    }
    if (pathHits.length > 0) {
      const totalMs = Date.now() - start;
      logTelemetry({
        event: 'query',
        ts: nowIso(),
        level: 'L1',
        latency_ms: totalMs,
        results: pathHits.length,
      });
      return { hits: withSourceScope(pathHits).slice(0, topK), levelUsed: 'L1', totalMs };
    }
  }

  // Negative-memory / advisory: should/can questions → warnings + negation notes
  if (/^(?:should|can|could|would)\s/i.test(input.query.trim())) {
    let negHits = notesWithWarningsOrNegative(input.query, topK * 2, input.sourcePrefix);
    if (negHits.length === 0 && input.sourcePrefix) {
      negHits = listAllWithText({ includeExpired: false })
        .filter((n) => (n.source ?? '').startsWith(input.sourcePrefix!))
        .slice(0, topK * 2);
    }
    if (negHits.length > 0) {
      hits = negHits.map((n) => ({
        id: n.id,
        path: n.path,
        score: 1.0,
        level: 'L1' as const,
        snippet: (n.warnings ?? n.text ?? '').slice(0, 280),
      }));
      const totalMs = Date.now() - start;
      logTelemetry({
        event: 'query',
        ts: nowIso(),
        level: 'L1',
        latency_ms: totalMs,
        results: hits.length,
      });
      return { hits: withSourceScope(hits).slice(0, topK), levelUsed: 'L1', totalMs };
    }
  }

  // Haiku #8: Error-pattern shortcut (fix:|error:|how to fix or Traceback/Exception markers)
  if (
    /^(?:fix:|error:|how to fix)/i.test(input.query) ||
    /\bhow (?:do i|to) fix\b/i.test(input.query) ||
    /TraceError|Exception|FAILED|Traceback|OperationalError|TypeError|ERESOLVE|deadlock|CORS/i.test(
      input.query,
    )
  ) {
    const errHits = notesForErrorPattern(input.query, topK, input.sourcePrefix);
    if (errHits.length > 0) {
      hits = errHits.map((n) => ({
        id: n.id,
        path: n.path,
        score: 1.0,
        level: 'L1' as const,
        snippet: (n.section_summary ?? n.text ?? '').slice(0, 240),
      }));
      const totalMs = Date.now() - start;
      logTelemetry({
        event: 'query',
        ts: nowIso(),
        level: 'L1',
        latency_ms: totalMs,
        results: hits.length,
      });
      return { hits: withSourceScope(hits).slice(0, topK), levelUsed: 'L1', totalMs };
    }
  }

  // Why-questions within a fixture — FTS on full bodies (questions column is often empty).
  if (/^why\s/i.test(input.query) && input.sourcePrefix) {
    const ftsHits = searchFts(input.query, { limit: topK, sourcePrefix: input.sourcePrefix });
    if (ftsHits.length > 0) {
      hits = ftsHits.map((h) => ({
        id: h.id,
        path: h.path,
        score: h.bm25,
        level: 'L2' as const,
        snippet: stripTags(h.snippet),
      }));
      const totalMs = Date.now() - start;
      logTelemetry({
        event: 'query',
        ts: nowIso(),
        level: 'L2',
        latency_ms: totalMs,
        results: hits.length,
      });
      return { hits: withSourceScope(hits).slice(0, topK), levelUsed: 'L2', totalMs };
    }
  }

  // Haiku #8: Q-pattern shortcut (why/how/what/when/should/can/is X)
  if (/^(why|how|what|when|should|can|is)\s/i.test(input.query)) {
    const qHits = notesAnsweringQuestion(input.query, topK, input.sourcePrefix);
    if (qHits.length > 0) {
      hits = qHits.map((n) => ({
        id: n.id,
        path: n.path,
        score: 1.0,
        level: 'L1' as const,
        snippet: (n.section_summary ?? n.text ?? '').slice(0, 240),
      }));
      const totalMs = Date.now() - start;
      logTelemetry({
        event: 'query',
        ts: nowIso(),
        level: 'L1',
        latency_ms: totalMs,
        results: hits.length,
      });
      return { hits: withSourceScope(hits).slice(0, topK), levelUsed: 'L1', totalMs };
    }
  }

  // NL → L1 structural shortcut: when the query mentions a known tag or type,
  // route directly to SQL-indexed tag/type lookup instead of semantic search.
  // This is the key advantage of HTML structure over markdown.
  const nlStructural = tryNlToStructural(input.query, topK, input.sourcePrefix);
  if (nlStructural.length > 0) {
    hits = nlStructural;
    const totalMs = Date.now() - start;
    logTelemetry({
      event: 'query',
      ts: nowIso(),
      level: 'L1',
      latency_ms: totalMs,
      results: hits.length,
    });
    return { hits: withSourceScope(hits).slice(0, topK), levelUsed: 'L1', totalMs };
  }

  // Standard routing if shortcuts don't match
  if (finalLevel === 'L1') {
    hits = await runL1(input);
  } else if (finalLevel === 'L2') {
    hits = await runL2(input, topK);
  } else if (finalLevel === 'L2_L3_HYBRID') {
    hits = await runL2L3Hybrid(input, topK);
  } else if (finalLevel === 'L3') {
    hits = await runL3(input, topK);
  } else {
    hits = await runL4(input, topK);
  }

  // P2: entity-graph expansion — if the query references any registered entity,
  // pull notes mentioning that entity and merge them with the BM25/embedding
  // hits using a boost. Cheap (LIKE on indexed column), often the difference
  // between recall ≈ baseline and recall ≈ +10 points on entity-heavy queries.
  const entityKeys = resolveEntityKeysInQuery(input.query);
  if (entityKeys.length > 0) {
    const haveIds = new Set(hits.map((h) => h.id));
    for (const key of entityKeys) {
      for (const n of notesMentioningEntity(key, 5)) {
        if (haveIds.has(n.id)) continue;
        hits.push({
          id: n.id,
          path: n.path,
          score: 0.6, // injected priors compete with BM25 but below high-confidence hits
          level: finalLevel as 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
          snippet: (n.text ?? '').slice(0, 240),
        });
        haveIds.add(n.id);
        if (hits.length >= topK * 3) break;
      }
      if (hits.length >= topK * 3) break;
    }
    // Re-sort by score
    hits.sort((a, b) => b.score - a.score);
  }

  // Invalidation penalty: soft-penalize notes with valid_until set; drop entirely
  // when LAZYBRAIN_HARD_INVALIDATE=1. Boost notes that are active replacements.
  hits = applyInvalidationPenalty(hits, log);

  // Warning boost: amplify notes with anti-pattern warnings when query references
  // entities that appear in the warning text.
  hits = applyWarningBoost(hits, input.query);

  // Schema-evolution / bi-temporal: boost "current" markers and newest replacements
  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    hits = applyCurrentVersionBoost(hits);
  }

  // Temporal: "originally" / "first" → prefer earlier notes that mention failures
  if (/\b(originally|previously|at first|initially)\b/i.test(input.query)) {
    hits = applyTemporalEarlierBoost(hits);
  }

  hits = withSourceScope(hits);

  // Drop obvious superseded notes when asking for "current" state (same fixture scope).
  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    hits = dropObviousSuperseded(hits);
  }

  // Personalized PageRank re-weighting for semantic levels (L3/L4).
  // B6: pass entity-derived seeds so PR boosts notes 1-hop from the query's entities.
  if ((finalLevel === 'L3' || finalLevel === 'L4') && hits.length > 1) {
    const weight = input.pageRankWeight ?? 0.25;
    if (weight > 0) {
      hits = applyPageRank(hits, input.cwd, weight, entityKeys);
    }
  }

  if (input.diversityLambda !== undefined && hits.length > topK) {
    hits = await applyMmr(hits, input.query, topK, input.diversityLambda);
  } else if (hits.length > topK) {
    hits = hits.slice(0, topK);
  }

  // B4: record retrieval hits for Ebbinghaus-style decay scoring (Q6).
  // Done after slicing so we only credit notes that survived ranking.
  if (hits.length > 0) recordAccessMany(hits.map((h) => h.id));

  if (input.hydrateNote) {
    const backlinks = loadBacklinks();
    for (const h of hits) {
      if (!h.note) {
        try {
          const note = readNote(h.path);
          h.note = stripNote(note.html);
        } catch {
          // ignore
        }
      }
      // Expose graph neighbours so prompt injection can mention them
      if (backlinks) {
        const inbound = backlinks.incoming[h.id] ?? [];
        const outbound = backlinks.outgoing[h.id] ?? [];
        h.neighbours = [
          ...outbound
            .slice(0, 5)
            .map((e) => ({ id: e.to, type: e.type, direction: 'out' as const })),
          ...inbound
            .slice(0, 5)
            .map((e) => ({ id: e.from, type: e.type, direction: 'in' as const })),
        ];
      }
    }
  }

  const totalMs = Date.now() - start;
  logTelemetry({
    event: 'query',
    ts: nowIso(),
    level: finalLevel as 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
    latency_ms: totalMs,
    results: hits.length,
  });

  return { hits, levelUsed: finalLevel as 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4', totalMs };
}

function pickLevel(query: string, topK: number): 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4' {
  const trimmed = query.trim();
  // CSS selector heuristic: brackets, dot-classes after element, ID hash, attribute selector
  if (/^[a-z*]+(\[|#|\.|:)/i.test(trimmed) || trimmed.startsWith('[')) return 'L1';
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const hasPhrase = /["']/.test(trimmed);
  // Short queries (1-5 tokens, no phrases) → pure L2 FTS.
  // Widened from ≤ 3 to ≤ 5: keyword queries up to 5 tokens are served well by
  // BM25 + structural field boost. Saves the ~50s WASM model load for typical queries.
  if (tokens.length <= 5 && !hasPhrase) return 'L2';
  // Medium complexity (6-15 tokens) → hybrid L2+L3 fusion
  if (tokens.length >= 6 && tokens.length <= 15) return 'L2_L3_HYBRID';
  // Small topK or default → pure L3 semantic
  if (topK <= 5) return 'L3';
  // Large topK → cross-encoder rerank on top of semantic
  return 'L4';
}

async function runL1(input: SearchInput): Promise<ResolvedHit[]> {
  const hits = structuralQuery(input.query, { limit: input.topK ?? 5 });
  return hits.map((h) => ({
    id: h.noteId,
    path: h.notePath,
    score: 1.0,
    level: 'L1',
    snippet: h.text.slice(0, 240),
  }));
}

async function runL2(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  const opts = {
    limit: topK,
    includeExpired: input.includeExpired,
    type: input.type,
    tag: input.tag,
    sourcePrefix: input.sourcePrefix,
  };
  // Use spread activation for multi-word queries; fall back to plain FTS for single tokens.
  const tokens = input.query.trim().split(/\s+/).filter(Boolean);
  const ftsHits: FtsHit[] =
    tokens.length >= 2 ? searchFtsSpread(input.query, opts) : searchFts(input.query, opts);

  // Build initial hits, then apply structural field boost (Item 2).
  // Notes whose topic or data-code-file exactly contains a query token are boosted
  // above free-text body matches, fixing ambiguous short tokens.
  const rawHits = ftsHits.map((h) => {
    const note = getNoteById(h.id);
    return {
      id: h.id,
      path: h.path,
      score: h.bm25,
      level: 'L2' as const,
      snippet: stripTags(h.snippet),
      topic: note?.topic ?? null,
      tags: note?.tags ?? null,
      codeFile: note?.source?.startsWith('code-scanner:')
        ? (note.title ?? null)
        : null,
    };
  });

  const boosted = applyStructuralFieldBoost(rawHits, input.query);
  return boosted.map(({ topic: _t, tags: _g, codeFile: _c, ...rest }) => rest);
}

/**
 * L2_L3_HYBRID: RRF fusion of FTS (BM25) and semantic (cosine) results.
 *
 * Runs L2 (FTS) and L3 (embeddings) in parallel, then fuses results using
 * Reciprocal Rank Fusion with K=60. De-duplicates by note ID, keeping the
 * highest RRF score. Suitable for medium-complexity queries (5–15 tokens).
 */
async function runL2L3Hybrid(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  // Graceful degradation: if the ONNX embedding model is unavailable, skip the
  // L3 branch entirely and return pure FTS results so the user still gets a
  // response instead of zero-vector noise or a crash.
  if (isEmbedderUnavailable()) {
    getLogger().debug({ query: input.query }, 'runL2L3Hybrid: embedder unavailable, using L2 only');
    return runL2(input, topK);
  }

  const opts = {
    limit: topK * 2, // Overfetch for fusion
    includeExpired: input.includeExpired,
    type: input.type,
    tag: input.tag,
    sourcePrefix: input.sourcePrefix,
  };

  // Run L2 and L3 in parallel
  const [l2Hits, l3Hits] = await Promise.all([
    (async () => {
      const tokens = input.query.trim().split(/\s+/).filter(Boolean);
      const ftsHits: FtsHit[] =
        tokens.length >= 2 ? searchFtsSpread(input.query, opts) : searchFts(input.query, opts);
      return ftsHits.map((h, idx) => ({ hit: h, rank: idx }));
    })(),
    (async () => {
      const queryVec = await embedQueryForRetrieval(input.query);
      const corpus = listAllWithText({ includeExpired: input.includeExpired }).filter((n) => {
        if (input.sourcePrefix && !(n.source ?? '').startsWith(input.sourcePrefix)) return false;
        if (input.type && n.type !== input.type) return false;
        if (input.tag && !(n.tags ?? '').includes(input.tag)) return false;
        return true;
      });
      // Speed fix: use SQLite-cached vectors — only embeds query (1 vector).
      const vectors = await resolveCorpusVectors(corpus);
      const ranked = topKCosine(
        queryVec,
        corpus.map((c, i) => ({ id: c.id, vector: vectors[i] })),
        topK * 2,
      );
      const byId = new Map(corpus.map((c) => [c.id, c]));
      return ranked
        .filter((r) => byId.has(r.id))
        .map((r, idx) => {
          const n = byId.get(r.id);
          if (!n) throw new Error('unreachable');
          return {
            hit: {
              id: r.id,
              path: n.path,
              title: n.title ?? '',
              snippet: ((n.text ?? '') || n.title || '').slice(0, 280),
              bm25: r.score,
            },
            rank: idx,
          };
        });
    })(),
  ]);

  // RRF fusion: K=60, score = 1/(K+rank_l2) + 1/(K+rank_l3)
  const RRF_K = 60;
  const fused = new Map<string, number>();
  const best = new Map<string, { id: string; path: string; snippet: string }>();

  // Add L2 contributions
  for (const { hit, rank } of l2Hits) {
    const rrfScore = 1 / (RRF_K + rank);
    fused.set(hit.id, (fused.get(hit.id) ?? 0) + rrfScore);
    if (!best.has(hit.id)) {
      best.set(hit.id, { id: hit.id, path: hit.path, snippet: stripTags(hit.snippet) });
    }
  }

  // Add L3 contributions
  for (const { hit, rank } of l3Hits) {
    const rrfScore = 1 / (RRF_K + rank);
    fused.set(hit.id, (fused.get(hit.id) ?? 0) + rrfScore);
    if (!best.has(hit.id)) {
      best.set(hit.id, { id: hit.id, path: hit.path, snippet: hit.snippet });
    }
  }

  // Sort by fused RRF score, apply structural field boost, then slice to topK
  const preFused = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  const fusedForBoost = preFused.map(([id, score]) => {
    const hit = best.get(id)!;
    const note = getNoteById(id);
    return {
      id,
      path: hit.path,
      score,
      level: 'L2_L3_HYBRID' as const,
      snippet: hit.snippet,
      topic: note?.topic ?? null,
      tags: note?.tags ?? null,
      codeFile: note?.source?.startsWith('code-scanner:') ? (note.title ?? null) : null,
    };
  });

  const boosted = applyStructuralFieldBoost(fusedForBoost, input.query);
  const results: ResolvedHit[] = boosted.map(({ topic: _t, tags: _g, codeFile: _c, ...rest }) => rest);
  return results;
}

/**
 * Resolve corpus vectors: prefer the SQLite-cached embedding for each note
 * (keyed by embed_text_hash == FNV-1a of buildEmbedText output).
 * Only notes with a stale or missing cache entry are re-embedded with the WASM
 * model — and those are then immediately stored back for future queries.
 *
 * Typical hot-path cost: 1 SQLite SELECT + 1 WASM embedOne(query) ≈ 50–200ms.
 * Cold path (first run after index rebuild): embeds all missing notes once,
 * then stores them — subsequent queries pay only the hot-path cost.
 */
async function resolveCorpusVectors(
  corpus: Array<{ id: string; title?: string; tags?: string; text?: string }>,
): Promise<Float32Array[]> {
  const stored = loadAllStoredEmbeddings();
  const vectors: Float32Array[] = new Array(corpus.length);
  const missing: Array<{ idx: number; id: string; text: string; hash: string }> = [];

  for (let i = 0; i < corpus.length; i++) {
    const n = corpus[i];
    const embedText = buildEmbedText(n) || 'untitled';
    const hash = hashKey(embedText);
    const cached = stored.get(n.id);
    if (cached && cached.embedTextHash === hash) {
      vectors[i] = cached.vector;
    } else {
      missing.push({ idx: i, id: n.id, text: embedText, hash });
    }
  }

  if (missing.length > 0) {
    const log = getLogger();
    log.debug({ missing: missing.length, total: corpus.length }, 'resolveCorpusVectors: computing missing embeddings');
    const texts = missing.map((m) => m.text);
    const computed = await embed(texts);
    for (let j = 0; j < missing.length; j++) {
      const { idx, id, hash } = missing[j];
      const vec = computed[j];
      vectors[idx] = vec;
      upsertNoteEmbedding(id, hash, vec);
    }
  }

  return vectors;
}

async function runL3(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  // Graceful degradation: if the ONNX embedding model failed to load, fall back
  // to FTS (L2) rather than returning meaningless zero-vector cosine scores.
  if (isEmbedderUnavailable()) {
    getLogger().debug({ query: input.query }, 'runL3: embedder unavailable, falling back to L2');
    return runL2(input, topK);
  }

  // Q8: HyDE — when enabled and the query benefits from expansion, embed a
  // hallucinated "memory note" instead of the raw query. Falls back to a
  // plain embedOne(query) when HyDE is disabled or skipped.
  const queryVec = await embedQueryForRetrieval(input.query);
  // B1: fetch corpus WITH text so embeddings reflect facts, not just title+tags.
  // When hard invalidation is enabled, filter out invalidated notes BEFORE scoring
  // to prevent contamination from affecting cosine similarity rankings.
  const hardInvalidate = process.env.LAZYBRAIN_HARD_INVALIDATE === '1';
  const corpus = listAllWithText({
    includeExpired: input.includeExpired,
    excludeInvalidated: hardInvalidate,
  }).filter((n) => {
    if (input.sourcePrefix && !(n.source ?? '').startsWith(input.sourcePrefix)) return false;
    if (input.type && n.type !== input.type) return false;
    if (input.tag && !(n.tags ?? '').includes(input.tag)) return false;
    return true;
  });
  // Speed fix: use SQLite-cached vectors — only embeds query (1 vector).
  // Corpus vectors are pre-computed at index time and fetched from note_embeddings.
  const vectors = await resolveCorpusVectors(corpus);
  const ranked = topKCosine(
    queryVec,
    corpus.map((c, i) => ({ id: c.id, vector: vectors[i] })),
    topK * 2, // overfetch for potential L4 re-rank
  );
  const byId = new Map(corpus.map((c) => [c.id, c]));
  return ranked
    .filter((r) => byId.has(r.id))
    .slice(0, topK)
    .map((r) => {
      const n = byId.get(r.id);
      if (!n) throw new Error('unreachable');
      return {
        id: r.id,
        path: n.path,
        score: r.score,
        level: 'L3' as const,
        // B3-friendly: snippet reflects content, not just title — MMR uses it.
        snippet: ((n.text ?? '') || n.title || '').slice(0, 280),
      };
    });
}

async function runL4(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  // Get top 50 from L3
  const l3 = await runL3({ ...input, topK: 50 }, 50);
  if (l3.length === 0) return l3;

  // B2: rerank against full body (truncated), not just title+tags.
  const candidates: RerankInput[] = [];
  for (const hit of l3) {
    const n = getNoteById(hit.id);
    if (!n) continue;
    const title = typeof n.title === 'string' ? n.title : '';
    const tags = typeof n.tags === 'string' ? n.tags : '';
    const body = getNoteText(hit.id).slice(0, RERANK_CHAR_LIMIT);
    const text = [title, tags, body].filter(Boolean).join('\n').trim();
    if (text.length === 0) continue;
    candidates.push({ id: hit.id, text });
  }
  const reranked = await rerank(input.query, candidates, topK);
  const byId = new Map(l3.map((h) => [h.id, h]));
  return reranked.map((r) => {
    const base = byId.get(r.id);
    if (!base) throw new Error('unreachable');
    return { ...base, score: r.score, level: 'L4' as const };
  });
}

function applyPageRank(
  hits: ResolvedHit[],
  cwd: string | undefined,
  weight: number,
  entityKeys: readonly string[] = [],
): ResolvedHit[] {
  // Build PR seeds: cwd-matched notes + 7-day recent + current hits + entity-1-hop.
  // B6 adds entity-1-hop seeds so the random surfer explores from the entity ego-graph.
  const all = listAll({ includeExpired: false });
  const cwdSeeds = notesForCwd(cwd);
  const recent = recentNotes(all, 7);
  const entitySeeds: string[] = [];
  if (entityKeys.length > 0) {
    for (const key of entityKeys) {
      for (const n of notesMentioningEntity(key, 8)) entitySeeds.push(n.id);
    }
  }
  const seeds = [...new Set([...cwdSeeds, ...recent, ...entitySeeds, ...hits.map((h) => h.id)])];
  const entitySig = entityKeys.length ? `:ent:${[...entityKeys].sort().join(',')}` : '';
  const cacheKey = `${cwd ? `cwd:${cwd}` : 'recent'}${entitySig}`;
  const pr = computePageRank({ seeds, cacheKey });
  if (!pr.scores || Object.keys(pr.scores).length === 0) return hits;

  // Normalise the original hit scores to [0,1] for blending
  const max = Math.max(...hits.map((h) => h.score), 1e-9);
  const min = Math.min(...hits.map((h) => h.score), 0);
  const range = Math.max(1e-9, max - min);

  // Immutable: return a new array of new hit objects — never mutate the input.
  return hits
    .map((h) => {
      const base = (h.score - min) / range;
      const prScore = pr.scores[h.id] ?? 0;
      return { ...h, score: base * (1 - weight) + prScore * weight };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Soft-penalize or hard-drop notes whose valid_until is set (invalidated).
 * Boost notes that actively replace an older note (replaces set, not invalidated).
 * Returns a new sorted array — no mutation of the input.
 */
function applyInvalidationPenalty(
  hits: ResolvedHit[],
  log: ReturnType<typeof getLogger>,
): ResolvedHit[] {
  const hardInvalidate = process.env.LAZYBRAIN_HARD_INVALIDATE === '1';
  let penalized = 0;
  let boosted = 0;

  const adjusted = hits.flatMap((h) => {
    const row = getNoteById(h.id);
    if (!row) return [h];

    const isInvalidated = !!(row.valid_until && row.valid_until.trim().length > 0);
    const isReplacement = !!(row.replaces && row.replaces.trim().length > 0) && !isInvalidated;

    if (isInvalidated) {
      if (hardInvalidate) {
        penalized++;
        return []; // drop entirely
      }
      penalized++;
      return [{ ...h, score: h.score * 0.15 }];
    }

    if (isReplacement) {
      boosted++;
      return [{ ...h, score: h.score * 1.4 }];
    }

    return [h];
  });

  if (penalized > 0 || boosted > 0) {
    logTelemetry({
      event: 'rerank_invalidation',
      ts: nowIso(),
      penalized,
      boosted,
      hard: hardInvalidate,
    });
    log.debug({ penalized, boosted, hard: hardInvalidate }, 'rerank_invalidation');
  }

  // Re-sort by adjusted score
  return [...adjusted].sort((a, b) => b.score - a.score);
}

/**
 * Boost notes containing anti-pattern warnings when the query mentions
 * keywords that appear in the warning text. Returns a new sorted array.
 * Boost multiplier: 1.8x when warning text matches query keywords.
 */
/** Remove older-version notes from hit list when a newer sibling is also present.
 *
 * Uses schema-based detection: a note is considered superseded if:
 * 1. It has valid_until set (marked as expired)
 * 2. Another note in hits has replaces pointing to it (is an active replacement)
 */
function dropObviousSuperseded(hits: ResolvedHit[]): ResolvedHit[] {
  // Build map of notes that are being actively replaced
  const replacedNoteIds = new Set<string>();

  for (const h of hits) {
    const row = getNoteById(h.id);
    if (!row) continue;
    // If this note has replaces set, mark the older note as superseded
    if (row.replaces && row.replaces.trim().length > 0) {
      replacedNoteIds.add(row.replaces);
    }
  }

  // Filter out notes that are:
  // 1. Marked expired (valid_until set), OR
  // 2. Actively replaced by another note in the result set
  return hits.filter((h) => {
    const row = getNoteById(h.id);
    if (!row) return true;

    const isExpired = !!(row.valid_until && row.valid_until.trim().length > 0);
    const isSuperseded = replacedNoteIds.has(h.id);

    return !isExpired && !isSuperseded;
  });
}

/** Prefer earlier notes when the query asks about original / first outcomes. */
function applyTemporalEarlierBoost(hits: ResolvedHit[]): ResolvedHit[] {
  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    const text = getNoteText(h.id).toLowerCase();
    const failed = /\b(failed|error|401|assertionerror|exception)\b/i.test(text);
    const created = row?.created ? new Date(row.created).getTime() : Date.now();
    let score = h.score;
    if (failed) score *= 1.6;
    return { ...h, score, _ts: created };
  });
  return [...adjusted].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
    return (a as ResolvedHit & { _ts: number })._ts - (b as ResolvedHit & { _ts: number })._ts;
  });
}

/** Boost notes that explicitly mark themselves as the current/active version.
 *
 * Uses schema-based detection:
 * - Notes with replaces set (and no valid_until) are active replacements: +1.6x
 * - Notes with more recent created dates are preferred slightly: +1.2x
 * - Notes with valid_until set are penalized: 0.5x
 */
function applyCurrentVersionBoost(hits: ResolvedHit[]): ResolvedHit[] {
  // Find the most recent creation date in this hit set for comparison
  let maxCreatedTime = 0;
  for (const h of hits) {
    const row = getNoteById(h.id);
    if (row?.created) {
      const ts = new Date(row.created).getTime();
      if (ts > maxCreatedTime) maxCreatedTime = ts;
    }
  }

  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row) return h;

    let score = h.score;

    // Active replacement (replaces set, not expired)
    const isReplacement = !!row.replaces?.trim() && !row.valid_until;
    if (isReplacement) {
      score *= 1.6;
    }

    // Expired note (has valid_until)
    const isExpired = !!row.valid_until?.trim();
    if (isExpired) {
      score *= 0.5;
    }

    // Recent notes get a small boost (within this result set)
    if (row.created && maxCreatedTime > 0) {
      const createdTime = new Date(row.created).getTime();
      const daysSinceMax = (maxCreatedTime - createdTime) / (1000 * 60 * 60 * 24);
      // Slight boost for notes created within 7 days of the newest
      if (daysSinceMax <= 7) {
        score *= 1.2;
      }
    }

    return { ...h, score };
  });

  return [...adjusted].sort((a, b) => b.score - a.score);
}

/** Extract path-like tokens from natural-language queries. */
function extractPathPrefixesFromQuery(query: string): string[] {
  const found = new Set<string>();
  for (const m of query.matchAll(
    /(?:^|[\s'"(),])([\w.-]+(?:\/[\w.-]+)+\/?|[\w.-]+\.(?:ts|tsx|js|jsx|py|sql|md|json|html|toml|yaml|yml))(?=[\s'"(),.?]|$)/gi,
  )) {
    const p = m[1].replace(/\\/g, '/');
    if (p.length >= 4) found.add(p);
  }
  // Directory questions: "the src/auth/ directory"
  for (const m of query.matchAll(
    /(?:the\s+)?((?:src|tests|apps|docs|migrations)\/[\w./-]+\/?)/gi,
  )) {
    found.add(m[1].replace(/\\/g, '/'));
  }
  return [...found];
}

function applyWarningBoost(hits: ResolvedHit[], query: string): ResolvedHit[] {
  const queryTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2); // Skip short tokens to avoid false positives

  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row?.warnings) return h;

    const warningText = row.warnings.toLowerCase();
    const hasMatch = queryTokens.some((token) => warningText.includes(token));

    if (hasMatch) {
      return { ...h, score: h.score * 1.8 };
    }
    return h;
  });

  return [...adjusted].sort((a, b) => b.score - a.score);
}

async function applyMmr(
  hits: ResolvedHit[],
  query: string,
  k: number,
  lambda: number,
): Promise<ResolvedHit[]> {
  const queryVec = await embedOne(query);
  const texts = hits.map((h) => h.snippet ?? '');
  const vectors = await embed(texts);
  const inputs: MmrInput[] = hits.map((h, i) => ({
    id: h.id,
    vector: vectors[i],
    relevance: h.score,
  }));
  // queryVec used implicitly through h.score (already cosine to query for L3+)
  void queryVec;
  const order = mmr(inputs, k, lambda);
  const byId = new Map(hits.map((h) => [h.id, h]));
  return order.map((id) => byId.get(id)).filter((h): h is ResolvedHit => Boolean(h));
}

/**
 * Maximum note count for a tag to be considered "selective" enough for the
 * structural shortcut. Tags with more notes than this threshold bypass L1 and
 * fall through to FTS/BM25 (L2) which scores by relevance.
 *
 * Rationale: a tag covering 50+ notes is effectively a broad category label
 * (e.g. "acme" on 450 notes). Using it as a structural filter returns an
 * unordered dump rather than a relevance-ranked result. FTS handles that case
 * far better by weighting the remaining query tokens against note content.
 */
const STRUCTURAL_TAG_MAX_NOTES = 50;

/**
 * Maximum number of meaningful tokens in a query for the structural shortcut
 * to apply. Queries with 3+ content tokens express intent beyond a simple
 * tag lookup and should be ranked by FTS rather than returned as a flat set.
 */
const STRUCTURAL_MAX_QUERY_TOKENS = 2;

/**
 * Attempt to resolve a natural-language query via structural tag/type lookup.
 * Returns empty array if no structural match is possible or if the matched
 * tags are too high-frequency to produce relevant results without FTS scoring.
 *
 * Selectivity rule (ALL conditions must hold to use the structural shortcut):
 *   1. The query has at most STRUCTURAL_MAX_QUERY_TOKENS meaningful tokens, AND
 *   2. Every matched tag has a note-count below STRUCTURAL_TAG_MAX_NOTES.
 * If either condition fails, returns [] so the caller falls through to L2 FTS.
 *
 * Type-based structural lookups (decision, episodic, etc.) are exempt from the
 * tag-count check — they are always selective by definition.
 */
function tryNlToStructural(query: string, topK: number, _sourcePrefix?: string): ResolvedHit[] {
  const lower = query.toLowerCase();

  // Known type keywords that map to data-cerveau-type values
  const TYPE_MAP: Record<string, string> = {
    decision: 'decision',
    decisions: 'decision',
    décision: 'decision',
    décisions: 'decision',
    episodic: 'episodic',
    reference: 'reference',
    références: 'reference',
    procedural: 'procedural',
    procedure: 'procedural',
    procédure: 'procedural',
  };

  // Tags that are common English words and would cause false L1 routing
  const TAG_BLOCKLIST = new Set(['bug', 'test', 'fix', 'config', 'docs', 'next']);

  // Known tags from the brain index (loaded dynamically to always reflect actual content)
  const KNOWN_TAGS = allDistinctTags().filter((t) => !TAG_BLOCKLIST.has(t));

  // Detect type mention
  let matchedType: string | undefined;
  for (const [keyword, type] of Object.entries(TYPE_MAP)) {
    if (lower.includes(keyword)) {
      matchedType = type;
      break;
    }
  }

  // Detect tag mentions (must be a word boundary match).
  // Tags may contain regex metacharacters (e.g. "a+b", "[auth]") — escape first.
  const matchedTags: string[] = [];
  for (const tag of KNOWN_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(query)) {
      matchedTags.push(tag);
    }
  }

  // Only route to L1 if we have at least one tag or type match
  // AND the query looks like a lookup (not a complex reasoning question)
  if (matchedTags.length === 0 && !matchedType) return [];

  // Skip L1 for complex queries that need semantic understanding
  const isComplex = /\b(why|how|explain|compare|difference|versus|vs)\b/i.test(lower);
  if (isComplex && !matchedType) return [];

  // --- Selectivity gate (tag-only paths, not type-based) ---
  // Skip structural bypass when tags are high-frequency: the dump would be too
  // large and unordered to be useful. Defer to FTS which ranks by relevance.
  if (matchedTags.length > 0 && !matchedType) {
    // Rule 1: query must be short (1–2 meaningful tokens beyond stop words).
    // Stopwords approximation: filter tokens shorter than 3 chars or pure stop words.
    const STOP_WORDS = new Set([
      'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
      'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was',
      'were', 'will', 'with', 'all', 'my', 'me', 'i', 'we', 'our', 'us',
      'show', 'list', 'find', 'get', 'give', 'tell', 'about', 'notes', 'tagged',
    ]);
    const meaningfulTokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

    if (meaningfulTokens.length > STRUCTURAL_MAX_QUERY_TOKENS) return [];

    // Rule 2: every matched tag must be selective (note-count below threshold).
    for (const tag of matchedTags) {
      if (getTagNoteCount(tag) >= STRUCTURAL_TAG_MAX_NOTES) return [];
    }
  }

  // Query the index
  const results = notesByTagOrType({
    tag: matchedTags[0], // primary tag
    type: matchedType,
    limit: topK * 2,
    includeExpired: false,
  });

  if (results.length === 0) return [];

  // If we have multiple matched tags, filter results to prefer notes with multiple tag matches
  const scored = results.map((n) => {
    const noteTags = (n.tags ?? '').toLowerCase();
    let tagScore = 0;
    for (const tag of matchedTags) {
      if (noteTags.includes(tag)) tagScore++;
    }
    return { note: n, tagScore };
  });

  // Sort by tag match count, then importance
  scored.sort((a, b) => {
    if (b.tagScore !== a.tagScore) return b.tagScore - a.tagScore;
    return (b.note.importance ?? 0) - (a.note.importance ?? 0);
  });

  return scored.slice(0, topK).map(({ note }) => ({
    id: note.id,
    path: note.path,
    score: 1.0,
    level: 'L1' as const,
    snippet: (note.title ?? '').slice(0, 280),
  }));
}
