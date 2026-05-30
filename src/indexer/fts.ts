import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { parseHTML } from 'linkedom';
import { stripTags } from '../retrieval/strip.js';
import { indexPath } from '../store/paths.js';
import { type NoteFile, readAllNotes } from '../store/reader.js';
import { noteQuality } from '../util/quality.js';
import { augmentTextForIndex, expandQuery, extractConcepts } from '../util/tokenize.js';

let cachedDb: DB | null = null;
let cachedReadonlyDb: DB | null = null;

export interface IndexedNote {
  id: string;
  path: string;
  text: string;
  title: string;
  type: string | null;
  tags: string; // space-separated
  source: string | null;
  created: string | null;
  importance: number | null;
  valid_from: string | null;
  valid_until: string | null;
  mtime_ms: number;
  // P1 — heuristic relations (nullable; populated on indexNote)
  triples: string | null; // "subj|pred|obj;subj|pred|obj"
  causes: string | null; // "<reason>|<reason>"
  replaces: string | null; // "X,Y"
  replaced_by: string | null; // "X,Y"
  supersedes: string | null; // "X,Y"
  // P2 — entity discovery
  entities: string | null; // "db:postgres-prod,lib:react"
  // B4 — retrieval-time access stats (nullable until first access)
  access_count?: number | null;
  last_accessed?: string | null;
  // Wikipedia: extracted concepts (Repository, Service, Pattern…)
  concepts?: string | null;
  // Quality flag (stub/start/good/featured)
  quality?: string | null;
  // Saliency kind
  saliency_kind?: string | null;
  // Phase 3: pre-computed cosine neighbours
  related?: string | null;
  // Multi-axis indexing (Haiku #8)
  questions?: string | null; // "why question 1|how question 2|..."
  error_patterns?: string | null; // "hash1|hash2|..."
  aliases?: string | null; // "postgres,postgresql,pg"
  section_summary?: string | null; // textContent of <section data-section="summary">
  section_reasoning?: string | null; // textContent of <section data-section="reasoning">
  section_qa?: string | null; // textContent of <section data-section="qa">
  section_tool_trace?: string | null; // textContent of <section data-section="tool_trace">
  section_tldr?: string | null; // textContent of <section data-section="tldr">
  // Anti-pattern warnings: extracted text from <aside role="doc-warning">
  warnings?: string | null; // "text of warning 1|text of warning 2"
  // Topic hierarchy for navigation
  topic?: string | null; // "myproject/auth/oauth"
  // TLDR: 1-sentence summary
  tldr?: string | null; // "One sentence summary"
}

export interface FtsHit {
  id: string;
  path: string;
  title: string;
  snippet: string;
  bm25: number; // higher is better (negated rank)
}

export function getDb(): DB {
  if (cachedDb) return cachedDb;
  const path = indexPath();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Give concurrent readers (serve) up to 5 s to release their read lock
  // before the writer gives up. Eliminates SQLITE_BUSY on typical workloads.
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  cachedDb = db;
  return db;
}

/**
 * Open the FTS database in read-only mode.
 * Used by `lazybrain serve` so a long-running process never holds a write lock
 * and never blocks the incremental index writer (Stop hook / index-update).
 *
 * WAL mode allows concurrent readers + one writer without locking conflicts.
 * The connection is cached for the lifetime of the process.
 */
export function getReadonlyDb(): DB {
  if (cachedReadonlyDb) return cachedReadonlyDb;
  const path = indexPath();
  // If the DB file does not exist yet, return null-signalling by throwing —
  // callers (serve) handle this gracefully.
  const db = new Database(path, { readonly: true });
  db.pragma('journal_mode = WAL');
  cachedReadonlyDb = db;
  return db;
}

export function closeDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
  if (cachedReadonlyDb) {
    cachedReadonlyDb.close();
    cachedReadonlyDb = null;
  }
}

/**
 * Count active notes in the index. Fast O(1) SQLite query.
 * Returns 0 when the DB or table does not exist yet.
 */
export function countAllNotes(): number {
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT,
      type TEXT,
      tags TEXT,
      source TEXT,
      created TEXT,
      importance REAL,
      valid_from TEXT,
      valid_until TEXT,
      mtime_ms REAL NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      id UNINDEXED,
      title,
      text,
      tags,
      tokenize = "porter unicode61"
    );

    CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
    CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created);
    CREATE INDEX IF NOT EXISTS idx_notes_valid_until ON notes(valid_until);
  `);
  // P1 additive columns — added with try/catch so older DBs upgrade lazily.
  for (const col of ['triples', 'causes', 'replaces', 'replaced_by', 'supersedes', 'entities']) {
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN ${col} TEXT`);
    } catch {
      /* exists */
    }
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_entities ON notes(entities)');
  } catch {
    /* */
  }
  // B4: access tracking — incremented by retrieval router on hits.
  try {
    db.exec('ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0');
  } catch {
    /* */
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN last_accessed TEXT');
  } catch {
    /* */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_access ON notes(access_count, last_accessed)');
  } catch {
    /* */
  }
  // Wikipedia model: concepts extracted from identifiers, used for spreading
  // activation across notes sharing the same engineering abstraction.
  try {
    db.exec('ALTER TABLE notes ADD COLUMN concepts TEXT');
  } catch {
    /* */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_concepts ON notes(concepts)');
  } catch {
    /* */
  }
  // Quality flag and saliency kind — lazy migration.
  try {
    db.exec('ALTER TABLE notes ADD COLUMN quality TEXT');
  } catch {
    /* */
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN saliency_kind TEXT');
  } catch {
    /* */
  }
  // Phase 3: pre-computed cosine neighbours (comma-separated ids).
  try {
    db.exec('ALTER TABLE notes ADD COLUMN related TEXT');
  } catch {
    /* */
  }
  // Haiku #8: Multi-axis indexing for 100% accuracy
  for (const col of [
    'questions',
    'error_patterns',
    'aliases',
    'section_summary',
    'section_reasoning',
    'section_qa',
    'section_tool_trace',
  ]) {
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN ${col} TEXT`);
    } catch {
      /* exists */
    }
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_questions ON notes(questions)');
  } catch {
    /* */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_error_patterns ON notes(error_patterns)');
  } catch {
    /* */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_aliases ON notes(aliases)');
  } catch {
    /* */
  }
  // Anti-pattern warnings: extracted from <aside role="doc-warning">
  try {
    db.exec('ALTER TABLE notes ADD COLUMN warnings TEXT');
  } catch {
    /* exists */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_warnings ON notes(warnings)');
  } catch {
    /* */
  }
  // TLDR and topic: critical for efficient injection and hierarchical navigation
  try {
    db.exec('ALTER TABLE notes ADD COLUMN section_tldr TEXT');
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN topic TEXT');
  } catch {
    /* exists */
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN tldr TEXT');
  } catch {
    /* exists */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic)');
  } catch {
    /* */
  }
  // Speed fix: pre-computed note embeddings stored as raw Float32 blobs.
  // Schema: note_embeddings(id TEXT PK, embed_text_hash TEXT, vector BLOB)
  // embed_text_hash = FNV-1a 32-bit hex of the text used to compute the vector.
  // When the hash matches the current buildEmbedText output, the stored vector is used
  // directly — no WASM model invocation at query time.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_embeddings (
        id TEXT PRIMARY KEY,
        embed_text_hash TEXT NOT NULL,
        vector BLOB NOT NULL
      )
    `);
  } catch {
    /* */
  }
}

export function indexNote(note: NoteFile): IndexedNote {
  const { document } = parseHTML(`<!doctype html><body>${note.html}</body>`);
  const root = document.querySelector('article, section');
  if (!root) {
    throw new Error(`No root element in note ${note.path}`);
  }
  const title = root.querySelector('h1, h2, h3')?.textContent?.trim() ?? note.id;
  const rawText = stripTags(root.outerHTML);
  // Spreading activation: enrich indexed text with sub-tokens so identifiers
  // like UserRepository expose "User" and "Repository" to BM25. Wikipedia
  // pattern — a query about "OrderRepository" now activates the "Repository"
  // concept and surfaces other Repository instances even without a direct
  // surface match. The augmented column is for FTS only; the structured
  // attributes (concepts, entities) remain canonical.
  const text = augmentTextForIndex(rawText);
  const conceptList = extractConcepts(rawText);
  const concepts = conceptList.length > 0 ? conceptList.join(',') : null;

  // Compute quality from fact count, mean confidence, access stats, relations
  const allFacts = Array.from(root.querySelectorAll('[data-cerveau-fact]'));
  const factCount = allFacts.length;
  const meanConfidence =
    factCount > 0
      ? allFacts.reduce(
          (sum, el) =>
            sum + (Number.parseFloat(el.getAttribute('data-cerveau-confidence') ?? '1') || 1),
          0,
        ) / factCount
      : 0;
  const hasRelations = !!(
    root.getAttribute('data-cerveau-triples') ||
    root.getAttribute('data-cerveau-causes') ||
    root.getAttribute('data-cerveau-replaces')
  );
  const quality = noteQuality({
    factCount,
    meanConfidence,
    accessCount: 0, // access_count not yet set at index time
    inboundWikilinks: 0, // backlink graph not consulted here (too expensive)
    hasRelations,
  });

  const saliencyKind = root.getAttribute('data-cerveau-saliency-kind') ?? null;

  // Haiku #8: Extract multi-axis indexing data from HTML balises
  const questions = extractQuestionsFromHtml(document);
  const errorPatterns = extractErrorPatternsFromHtml(document);
  const aliases = extractAliasesFromHtml(document);
  const sectionSummary = extractSectionTextContent(root, 'summary', 1500);
  const sectionReasoning = extractSectionTextContent(root, 'reasoning', 1500);
  const sectionQa = extractSectionTextContent(root, 'qa', 1500);
  const sectionToolTrace = extractSectionTextContent(root, 'tool_trace', 1500);
  const sectionTldr = extractSectionTextContent(root, 'tldr', 1500);
  const warnings = extractWarningsFromHtml(root);
  // Extract topic and tldr from data attributes
  const topic = root.getAttribute('data-cerveau-topic');
  const tldr = root.getAttribute('data-cerveau-tldr');

  const indexed: IndexedNote = {
    id: note.id,
    path: note.path,
    text,
    title,
    type: root.getAttribute('data-cerveau-type'),
    tags: root.getAttribute('data-cerveau-tags') ?? '',
    source: root.getAttribute('data-cerveau-source'),
    created: root.getAttribute('data-cerveau-created'),
    importance: parseOptionalFloat(root.getAttribute('data-cerveau-importance')),
    valid_from: root.getAttribute('data-cerveau-valid-from'),
    valid_until: root.getAttribute('data-cerveau-valid-until'),
    mtime_ms: note.mtimeMs,
    triples: root.getAttribute('data-cerveau-triples'),
    causes: root.getAttribute('data-cerveau-causes'),
    replaces: root.getAttribute('data-cerveau-replaces'),
    replaced_by: root.getAttribute('data-cerveau-replaced-by'),
    supersedes: root.getAttribute('data-cerveau-supersedes'),
    entities: root.getAttribute('data-cerveau-entities'),
    concepts,
    quality,
    saliency_kind: saliencyKind,
    related: root.getAttribute('data-cerveau-related') ?? null,
    questions,
    error_patterns: errorPatterns,
    aliases,
    section_summary: sectionSummary,
    section_reasoning: sectionReasoning,
    section_qa: sectionQa,
    section_tool_trace: sectionToolTrace,
    section_tldr: sectionTldr,
    warnings,
    topic,
    tldr,
  };

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO notes (id, path, title, type, tags, source, created, importance,
                       valid_from, valid_until, mtime_ms,
                       triples, causes, replaces, replaced_by, supersedes, entities,
                       concepts, quality, saliency_kind, related,
                       questions, error_patterns, aliases, section_summary, section_reasoning,
                       section_qa, section_tool_trace, section_tldr, warnings, topic, tldr)
    VALUES (@id, @path, @title, @type, @tags, @source, @created, @importance,
            @valid_from, @valid_until, @mtime_ms,
            @triples, @causes, @replaces, @replaced_by, @supersedes, @entities,
            @concepts, @quality, @saliency_kind, @related,
            @questions, @error_patterns, @aliases, @section_summary, @section_reasoning,
            @section_qa, @section_tool_trace, @section_tldr, @warnings, @topic, @tldr)
    ON CONFLICT(id) DO UPDATE SET
      path=@path, title=@title, type=@type, tags=@tags, source=@source,
      created=@created, importance=@importance, valid_from=@valid_from,
      valid_until=@valid_until, mtime_ms=@mtime_ms,
      triples=@triples, causes=@causes, replaces=@replaces,
      replaced_by=@replaced_by, supersedes=@supersedes, entities=@entities,
      concepts=@concepts, quality=@quality, saliency_kind=@saliency_kind,
      related=@related,
      questions=@questions, error_patterns=@error_patterns, aliases=@aliases,
      section_summary=@section_summary, section_reasoning=@section_reasoning,
      section_qa=@section_qa, section_tool_trace=@section_tool_trace, section_tldr=@section_tldr,
      warnings=@warnings, topic=@topic, tldr=@tldr
  `);
  upsert.run(indexed);

  // Refresh FTS row
  db.prepare('DELETE FROM notes_fts WHERE id = ?').run(note.id);
  db.prepare('INSERT INTO notes_fts (id, title, text, tags) VALUES (?, ?, ?, ?)').run(
    note.id,
    title,
    text,
    indexed.tags,
  );

  return indexed;
}

export interface SearchOptions {
  limit?: number;
  includeExpired?: boolean;
  type?: string;
  tag?: string;
  /** Only notes whose source attribute starts with this prefix (CSMB per-fixture scope). */
  sourcePrefix?: string;
}

function sourceFilterClause(opts: SearchOptions): {
  clause: string;
  params: Record<string, string>;
} {
  if (!opts.sourcePrefix) return { clause: '', params: {} };
  return {
    clause: 'AND n.source LIKE @sourcePrefix',
    params: { sourcePrefix: `${opts.sourcePrefix}%` },
  };
}

export interface ListAllOptions {
  includeExpired?: boolean;
  excludeInvalidated?: boolean;
}

export function searchFts(query: string, opts: SearchOptions = {}): FtsHit[] {
  const db = getDb();
  const limit = opts.limit ?? 10;
  const where: string[] = [];
  const q = ftsQuery(query);
  if (!q) return [];
  const src = sourceFilterClause(opts);
  const params: Record<string, unknown> = { q, limit, ...src.params };
  if (!opts.includeExpired) where.push(`(n.valid_until IS NULL OR n.valid_until = '')`);
  if (opts.type) {
    where.push('n.type = @type');
    params.type = opts.type;
  }
  if (opts.tag) {
    where.push('n.tags LIKE @tagLike');
    params.tagLike = `%${opts.tag}%`;
  }
  if (src.clause) where.push(src.clause.replace(/^AND /, ''));
  const whereClause = where.length ? `AND ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      n.id AS id,
      n.path AS path,
      n.title AS title,
      snippet(notes_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet,
      -bm25(notes_fts) AS bm25
    FROM notes_fts
    JOIN notes n ON n.id = notes_fts.id
    WHERE notes_fts MATCH @q
      ${whereClause}
    ORDER BY bm25 DESC
    LIMIT @limit
  `;
  try {
    return db.prepare(sql).all(params) as FtsHit[];
  } catch {
    // Malformed FTS5 query — fall back to token-only OR query
    const fallback = ftsQueryFallback(query);
    if (!fallback) return [];
    try {
      return db.prepare(sql).all({ ...params, q: fallback }) as FtsHit[];
    } catch {
      return [];
    }
  }
}

/**
 * RRF-fused spread search.
 *
 * Expands the query into variants (original, split-token, concept-only) using
 * expandQuery(), runs searchFts() on each, then fuses results via Reciprocal
 * Rank Fusion with linearly decreasing variant weights:
 *   original = 1.0, split-token = 0.8, concept-only = 0.5
 *
 * Returns a deduped, score-sorted FtsHit list of at most `opts.limit` entries.
 */
export function searchFtsSpread(query: string, opts: SearchOptions = {}): FtsHit[] {
  const limit = opts.limit ?? 10;
  const variants = expandQuery(query);

  // Assign weights per variant position (decreasing)
  const weights: number[] = [];
  for (let i = 0; i < variants.length; i++) {
    if (i === 0) weights.push(1.0);
    else if (i === 1) weights.push(0.8);
    else weights.push(0.5);
  }

  const RRF_K = 60;
  // Map: id → fused RRF score
  const fused = new Map<string, number>();
  // Map: id → best FtsHit (for snippet / path data)
  const best = new Map<string, FtsHit>();

  for (let vi = 0; vi < variants.length; vi++) {
    const variant = variants[vi];
    const weight = weights[vi] ?? 0.5;
    const variantHits = searchFts(variant, { ...opts, limit: limit * 2 });
    for (let rank = 0; rank < variantHits.length; rank++) {
      const h = variantHits[rank];
      const contrib = weight / (RRF_K + rank);
      fused.set(h.id, (fused.get(h.id) ?? 0) + contrib);
      // Keep the hit with the highest individual bm25 score for display
      const existing = best.get(h.id);
      if (!existing || h.bm25 > existing.bm25) {
        best.set(h.id, h);
      }
    }
  }

  // Sort by fused RRF score descending, then map back to FtsHit with fused score
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const hit = best.get(id);
      if (!hit) return null;
      return { ...hit, bm25: score } satisfies FtsHit;
    })
    .filter((h): h is FtsHit => h !== null);
}

export function listAll(opts: ListAllOptions = {}): IndexedNote[] {
  const db = getDb();
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  const where = shouldExcludeInvalidated ? `WHERE (valid_until IS NULL OR valid_until = '')` : '';
  return db.prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`).all() as IndexedNote[];
}

/**
 * Same as listAll() but uses the read-only database connection.
 * Safe to call from a long-running serve process without blocking the writer.
 * Returns an empty array when the index database does not exist yet.
 */
export function listAllReadonly(opts: ListAllOptions = {}): IndexedNote[] {
  let db: DB;
  try {
    db = getReadonlyDb();
  } catch {
    return [];
  }
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  const where = shouldExcludeInvalidated ? `WHERE (valid_until IS NULL OR valid_until = '')` : '';
  try {
    return db.prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`).all() as IndexedNote[];
  } catch {
    return [];
  }
}

/**
 * B1/B2: same as listAll but joins notes_fts.text so retrieval levels can embed
 * and rerank against the full stripped body, not just title+tags. Falls back to
 * empty text if FTS row is missing (defensive; FTS sync issues shouldn't crash
 * retrieval).
 *
 * When excludeInvalidated is true, filters out notes with valid_until set,
 * BEFORE embedding scoring (critical for avoiding contamination in L3/L4).
 */
export function listAllWithText(opts: ListAllOptions = {}): Array<IndexedNote & { text: string }> {
  const db = getDb();
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  const where = shouldExcludeInvalidated
    ? `WHERE (n.valid_until IS NULL OR n.valid_until = '')`
    : '';
  const rows = db
    .prepare(`
    SELECT n.*, COALESCE(fts.text, '') AS text
    FROM notes n
    LEFT JOIN notes_fts fts ON fts.id = n.id
    ${where}
    ORDER BY n.created DESC
  `)
    .all() as Array<IndexedNote & { text: string }>;
  return rows;
}

/**
 * B1/B2: fetch the indexed full text for a single note, useful for the reranker.
 */
export function getNoteText(id: string): string {
  const row = getDb().prepare('SELECT text FROM notes_fts WHERE id = ?').get(id) as
    | { text?: string }
    | undefined;
  return row?.text ?? '';
}

/**
 * B4: register a retrieval hit. Tracks access_count + last_accessed for
 * Ebbinghaus-style decay scoring downstream. No-op on missing id.
 */
export function recordAccess(id: string, isoTs?: string): void {
  const ts = isoTs ?? new Date().toISOString();
  try {
    getDb()
      .prepare(
        'UPDATE notes SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ? WHERE id = ?',
      )
      .run(ts, id);
  } catch {
    // never block retrieval on access tracking failure
  }
}

export function recordAccessMany(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const ts = new Date().toISOString();
  const db = getDb();
  try {
    const stmt = db.prepare(
      'UPDATE notes SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ? WHERE id = ?',
    );
    const tx = db.transaction((batch: readonly string[]) => {
      for (const id of batch) stmt.run(ts, id);
    });
    tx(ids);
  } catch {
    // best-effort
  }
}

export function getNoteById(id: string): IndexedNote | undefined {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as IndexedNote | undefined;
}

export function notesByTagOrType(opts: {
  tag?: string;
  type?: string;
  limit?: number;
  includeExpired?: boolean;
}): IndexedNote[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.tag) {
    // Use word boundary matching for space-separated tags
    where.push(`(' ' || tags || ' ') LIKE @tagPattern`);
    params.tagPattern = `% ${opts.tag} %`;
  }
  if (opts.type) {
    where.push('type = @type');
    params.type = opts.type;
  }
  if (!opts.includeExpired) {
    where.push(`(valid_until IS NULL OR valid_until = '')`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts.limit ?? 10;

  return db
    .prepare(
      `SELECT * FROM notes ${whereClause} ORDER BY importance DESC, created DESC LIMIT @limit`,
    )
    .all({ ...params, limit }) as IndexedNote[];
}

/**
 * Return all distinct tags used across active notes.
 * Cached for 60 seconds to avoid repeated SQL on hot paths.
 */
let _tagCache: { tags: string[]; ts: number } | null = null;
const TAG_CACHE_TTL = 60_000;

export function allDistinctTags(): string[] {
  const now = Date.now();
  if (_tagCache && now - _tagCache.ts < TAG_CACHE_TTL) return _tagCache.tags;

  const db = getDb();
  const rows = db
    .prepare(`
    SELECT DISTINCT tags FROM notes
    WHERE (valid_until IS NULL OR valid_until = '')
      AND tags IS NOT NULL AND tags != ''
  `)
    .all() as Array<{ tags: string }>;

  const tagSet = new Set<string>();
  for (const row of rows) {
    for (const tag of row.tags.split(/\s+/).filter(Boolean)) {
      tagSet.add(tag.toLowerCase());
    }
  }

  const tags = [...tagSet].sort();
  _tagCache = { tags, ts: now };
  return tags;
}

/**
 * Return the number of active notes carrying the given tag.
 * Used by the retrieval router to determine whether a tag-based structural
 * lookup is selective enough to be trusted as a shortcut.
 *
 * Counts notes where the space-separated tags column contains the exact tag
 * as a whole word. Cached for 60 seconds alongside the tag list.
 */
let _tagCountCache: { counts: Map<string, number>; ts: number } | null = null;

export function getTagNoteCount(tag: string): number {
  const now = Date.now();
  if (_tagCountCache && now - _tagCountCache.ts < TAG_CACHE_TTL) {
    return _tagCountCache.counts.get(tag.toLowerCase()) ?? 0;
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT tags FROM notes
       WHERE (valid_until IS NULL OR valid_until = '')
         AND tags IS NOT NULL AND tags != ''`,
    )
    .all() as Array<{ tags: string }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const t of row.tags.split(/\s+/).filter(Boolean)) {
      const key = t.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  _tagCountCache = { counts, ts: now };
  return counts.get(tag.toLowerCase()) ?? 0;
}

/**
 * P2: entity-graph lookup. Returns all notes whose `entities` column contains
 * the given canonical key (e.g. "db:postgres-prod"). Used by query expansion
 * and the `/graph #id` endpoint.
 */
export function notesMentioningEntity(entityKey: string, limit = 20): IndexedNote[] {
  const db = getDb();
  const sql = `
    SELECT * FROM notes
    WHERE entities LIKE @needle
      AND (valid_until IS NULL OR valid_until = '')
    ORDER BY created DESC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all({ needle: `%${entityKey}%`, limit }) as IndexedNote[];
  // Re-filter to avoid LIKE false positives on substring collisions
  return rows.filter((r) => {
    const list = (r.entities ?? '').split(',').filter(Boolean);
    return list.includes(entityKey);
  });
}

export function deleteNote(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
  try {
    db.prepare('DELETE FROM note_embeddings WHERE id = ?').run(id);
  } catch {
    /* best-effort */
  }
}

export function rebuildAll(): { indexed: number; failed: number; failures: string[] } {
  const db = getDb();
  db.exec('DELETE FROM notes; DELETE FROM notes_fts;');
  const notes = readAllNotes();
  let indexed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const n of notes) {
    try {
      indexNote(n);
      indexed += 1;
    } catch (err) {
      failed += 1;
      failures.push(`${n.path}: ${(err as Error).message}`);
    }
  }
  return { indexed, failed, failures };
}

function parseOptionalFloat(v: string | null): number | null {
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// Haiku #8: Multi-axis extraction helpers
// ============================================================

/**
 * Extract Q patterns from <details data-q="..."> elements and <meta name="answers">.
 * Returns pipe-separated questions, or null if empty.
 */
function extractQuestionsFromHtml(document: Document): string | null {
  const questions: string[] = [];

  // Extract from <meta name="answers">
  const answersMeta = document.querySelector('meta[name="answers"]');
  if (answersMeta) {
    const content = answersMeta.getAttribute('content') ?? '';
    if (content) {
      for (const answer of content
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)) {
        questions.push(`Why/How ${answer}?`);
      }
    }
  }

  // Extract from <details data-q="...">
  for (const detail of Array.from(document.querySelectorAll('details[data-q]'))) {
    const attr = detail.getAttribute('data-q');
    if (attr) questions.push(attr.replace(/-/g, ' '));
  }

  return questions.length > 0 ? questions.join('|') : null;
}

/**
 * Extract error patterns from <details data-error="..."> elements.
 * Returns pipe-separated error hashes, or null if empty.
 */
function extractErrorPatternsFromHtml(document: Document): string | null {
  const patterns: string[] = [];
  for (const detail of Array.from(document.querySelectorAll('details[data-error]'))) {
    const attr = detail.getAttribute('data-error');
    if (attr) patterns.push(attr);
  }
  return patterns.length > 0 ? patterns.join('|') : null;
}

/**
 * Extract aliases from <meta name="aliases">.
 * Returns comma-separated aliases, or null if empty.
 */
function extractAliasesFromHtml(document: Document): string | null {
  const aliasMeta = document.querySelector('meta[name="aliases"]');
  if (aliasMeta) {
    const content = aliasMeta.getAttribute('content') ?? '';
    return content.trim() ? content : null;
  }
  return null;
}

/**
 * Extract textContent from <section data-section="X">, capped at maxChars.
 * Returns the content or null if section not found.
 */
function extractSectionTextContent(
  root: Element,
  sectionName: string,
  maxChars: number,
): string | null {
  const section = root.querySelector(`section[data-section="${sectionName}"]`);
  if (!section) return null;
  const text = section.textContent ?? '';
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

/**
 * Extract warning text from <aside role="doc-warning"> elements.
 * Returns pipe-separated warning texts, or null if empty.
 */
function extractWarningsFromHtml(root: Element): string | null {
  const warnings: string[] = [];
  for (const aside of Array.from(root.querySelectorAll('aside[role="doc-warning"]'))) {
    const text = (aside.textContent ?? '').trim();
    if (text) warnings.push(text);
  }
  return warnings.length > 0 ? warnings.join('|') : null;
}

// ============================================================
// Haiku #8: Multi-axis retrieval helpers
// ============================================================

/**
 * Retrieve notes that answer a given question.
 * Matches against questions column using LIKE with ranking.
 */
export function notesAnsweringQuestion(
  query: string,
  limit = 10,
  sourcePrefix?: string,
): IndexedNote[] {
  const db = getDb();
  const needle = `%${query.toLowerCase()}%`;
  const src = sourcePrefix ? 'AND source LIKE @sourcePrefix' : '';
  const rows = db
    .prepare(
      `
    SELECT n.*, COALESCE(fts.text, '') AS text
    FROM notes n
    LEFT JOIN notes_fts fts ON fts.id = n.id
    WHERE questions LIKE @needle
      AND (n.valid_until IS NULL OR n.valid_until = '')
      ${src}
    ORDER BY
      CASE WHEN questions LIKE @exact THEN 0 ELSE 1 END,
      n.created DESC
    LIMIT @limit
  `,
    )
    .all({
      needle,
      exact: `%${query}%`,
      limit,
      ...(sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}),
    }) as IndexedNote[];
  return rows;
}

/**
 * Retrieve notes for a given error pattern.
 * Normalizes the error text (strips line numbers, stack addresses) and matches.
 */
export function notesForErrorPattern(
  errorText: string,
  limit = 5,
  sourcePrefix?: string,
): IndexedNote[] {
  const db = getDb();
  // Normalize: strip line numbers and common stack address patterns
  const normalized = errorText
    .replace(/:\d+/g, '')
    .replace(/0x[0-9a-f]+/g, '')
    .toLowerCase();

  // Distinctive slice: after "fix this error:" or the exception name
  const afterColon = normalized.split(/fix this error:\s*/i).pop() ?? normalized;
  const key =
    afterColon
      .match(
        /(?:operationalerror|typeerror|referenceerror|syntaxerror|eresolve|deadlock|assertionerror|cors)[^?]*/i,
      )?.[0]
      ?.slice(0, 80) ?? afterColon.slice(0, 80);
  const needle = `%${key.trim()}%`;

  const src = sourcePrefix ? 'AND n.source LIKE @sourcePrefix' : '';
  const rows = db
    .prepare(
      `
    SELECT n.*, COALESCE(fts.text, '') AS text
    FROM notes n
    LEFT JOIN notes_fts fts ON fts.id = n.id
    WHERE (
      n.error_patterns LIKE @needle
      OR n.title LIKE @needle
      OR n.section_summary LIKE @needle
      OR fts.text LIKE @needle
    )
    AND (n.valid_until IS NULL OR n.valid_until = '')
    ${src}
    ORDER BY
      CASE WHEN fts.text LIKE '%fix%' OR fts.text LIKE '%Fix%' THEN 0 ELSE 1 END,
      n.created DESC
    LIMIT @limit
  `,
    )
    .all({
      needle,
      limit,
      ...(sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}),
    }) as IndexedNote[];
  return rows;
}


// ============================================================
// Wikipedia layer helpers — used by inject-context highlights
// ============================================================

/**
 * Top concept tokens across all active notes, sorted by frequency.
 * Returns up to `limit` entries with their note counts.
 */
export function topConcepts(limit: number): Array<{ concept: string; count: number }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT concepts FROM notes WHERE (valid_until IS NULL OR valid_until = '') AND concepts IS NOT NULL AND concepts != ''`,
    )
    .all() as Array<{ concepts: string }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const c of row.concepts.split(',').filter(Boolean)) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([concept, count]) => ({ concept, count }));
}

/**
 * Active decision notes: type='decision', valid_until empty, created within daysBack days.
 * Sorted by importance DESC.
 */
export function activeDecisions(daysBack: number, limit: number): IndexedNote[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT * FROM notes
       WHERE type = 'decision'
         AND (valid_until IS NULL OR valid_until = '')
         AND created >= ?
       ORDER BY COALESCE(importance, 0) DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as IndexedNote[];
}

export interface RecentChange {
  id: string;
  kind: 'replaced' | 'invalidated';
  targetId?: string;
  created: string;
}

/**
 * Notes with valid_until set in last daysBack days (invalidated),
 * OR notes whose replaces is non-empty created in last daysBack days (replacements).
 */
export function recentChanges(daysBack: number): RecentChange[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  const out: RecentChange[] = [];

  // Invalidated
  const invalidated = db
    .prepare(
      `SELECT id, created, valid_until FROM notes WHERE valid_until IS NOT NULL AND valid_until != '' AND valid_until >= ?`,
    )
    .all(cutoff) as Array<{ id: string; created: string; valid_until: string }>;
  for (const r of invalidated) {
    out.push({ id: r.id, kind: 'invalidated', created: r.created });
  }

  // Replacements
  const replaced = db
    .prepare(
      `SELECT id, created, replaces FROM notes WHERE replaces IS NOT NULL AND replaces != '' AND created >= ?`,
    )
    .all(cutoff) as Array<{ id: string; created: string; replaces: string }>;
  for (const r of replaced) {
    const targetId = r.replaces.split(',')[0];
    out.push({ id: r.id, kind: 'replaced', targetId, created: r.created });
  }

  // Sort by created desc
  out.sort((a, b) => b.created.localeCompare(a.created));
  return out.slice(0, 10);
}

/**
 * Count notes and active decisions for a given cwd, plus top tags.
 */
export function notesForCwdCount(cwd: string): {
  count: number;
  activeDecisions: number;
  topTags: string[];
} {
  const db = getDb();
  const escaped = `%${cwd}%`;
  // `source` holds "code-scanner:<root>" for code notes and "session:<id>" for
  // conversation notes — both contain the project path. `id` and `path` also
  // carry the project path for broader coverage.
  const notes = db
    .prepare(
      `SELECT type, tags FROM notes
       WHERE source LIKE ?
         OR id LIKE ?
         OR path LIKE ?
       LIMIT 200`,
    )
    .all(escaped, escaped, escaped) as Array<{ type: string | null; tags: string | null }>;

  // Fall back to full scan when cwd not found in any column
  if (notes.length === 0) {
    const all = db
      .prepare(
        `SELECT type, tags FROM notes WHERE valid_until IS NULL OR valid_until = '' LIMIT 300`,
      )
      .all() as Array<{ type: string | null; tags: string | null }>;
    const counts = new Map<string, number>();
    let decisions = 0;
    for (const n of all) {
      if (n.type === 'decision') decisions++;
      for (const t of (n.tags ?? '').split(/\s+/).filter(Boolean)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    const topTags = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);
    return { count: all.length, activeDecisions: decisions, topTags };
  }

  const tagCounts = new Map<string, number>();
  let decisions = 0;
  for (const n of notes) {
    if (n.type === 'decision') decisions++;
    for (const t of (n.tags ?? '').split(/\s+/).filter(Boolean)) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  return { count: notes.length, activeDecisions: decisions, topTags };
}

/**
 * Tokenize a free-text query into FTS-safe terms.
 * Splits paths (test_auth.py), punctuation, and keeps alphanumerics.
 */
export function tokenizeForFts(input: string): string[] {
  return input
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u))
    .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter((t) => t.length > 1);
}

/**
 * Convert user query to FTS5 query syntax.
 * - Natural-language questions use OR (higher recall on agent queries)
 * - Short keyword queries use AND
 * - Dots/slashes in paths are split so test_auth.py → test_auth + py
 */
function ftsQuery(input: string): string {
  const tokens = tokenizeForFts(input);
  if (tokens.length === 0) return '';
  const isQuestion =
    /^(?:what|why|how|when|where|which|who|should|can|could|is|are|do|does)\b/i.test(
      input.trim(),
    ) || tokens.length >= 6;
  const parts = tokens.map((t) => {
    const safe = t.replace(/"/g, '""');
    return t.length >= 3 ? `"${safe}"*` : `"${safe}"`;
  });
  return isQuestion ? parts.join(' OR ') : parts.join(' ');
}

/** Minimal OR query when the primary ftsQuery still fails. */
function ftsQueryFallback(input: string): string {
  const tokens = tokenizeForFts(input)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Notes whose indexed text mentions a file or directory path prefix.
 * Used for filetree-scope queries (src/auth/, tests/, package.json).
 */
export function notesMatchingPathPrefix(
  pathPrefix: string,
  limit = 10,
  sourcePrefix?: string,
): IndexedNote[] {
  const db = getDb();
  const norm = pathPrefix.replace(/\\/g, '/').toLowerCase();
  if (!norm) return [];
  const needle = `%${norm}%`;
  const src = sourcePrefix ? 'AND n.source LIKE @sourcePrefix' : '';
  return db
    .prepare(
      `
    SELECT n.*, COALESCE(fts.text, '') AS text
    FROM notes n
    LEFT JOIN notes_fts fts ON fts.id = n.id
    WHERE (
      n.title LIKE @needle
      OR n.section_summary LIKE @needle
      OR n.section_tool_trace LIKE @needle
      OR fts.text LIKE @needle
    )
    AND (n.valid_until IS NULL OR n.valid_until = '')
    ${src}
    ORDER BY n.created DESC
    LIMIT @limit
  `,
    )
    .all({
      needle,
      limit,
      ...(sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}),
    }) as IndexedNote[];
}

// ---------------------------------------------------------------------------
// Structural field boost — Item 2
// ---------------------------------------------------------------------------

/**
 * Input element for applyStructuralFieldBoost.
 * Carries the scored note id and the structural fields used for boosting.
 */
export interface StructuralBoostHit {
  id: string;
  score: number;
  /** Value of the data-cerveau-topic attribute (e.g. "myproject/auth/oauth"). */
  topic: string | null | undefined;
  /** Space-separated tags from the notes.tags column. */
  tags: string | null | undefined;
  /** Value of the data-code-file attribute (e.g. "src/retrieval/router.ts"). */
  codeFile: string | null | undefined;
}

/**
 * Post-process BM25 / cosine hits by boosting notes whose structural fields
 * (`data-cerveau-topic`, `data-code-file`, or module-level tags) contain an
 * exact word-boundary match for any token in the query.
 *
 * Design rationale:
 *   A 3-char module token (e.g. "fts") matches equally in body text of many
 *   notes. Structural fields are authoritative identifiers: a note whose
 *   topic IS "myproject/fts" or codeFile IS "src/indexer/fts.ts" is almost
 *   certainly the file the user means. Rewarding that with a multiplier
 *   moves exact-module notes above near-miss body matches.
 *
 * Boost factor: STRUCTURAL_EXACT_BOOST (1.5×). Multiplicative, so a note
 * that already ranks high gets an even larger absolute lift.
 *
 * No hardcoded terms — the match is purely token ↔ field-segment comparison.
 *
 * @param hits   Array of hits with scores and structural fields.
 * @param query  Raw user query string.
 * @returns New array sorted descending by boosted score.
 */
const STRUCTURAL_EXACT_BOOST = 1.5;

export function applyStructuralFieldBoost<T extends StructuralBoostHit>(
  hits: T[],
  query: string,
): T[] {
  if (hits.length === 0) return hits;

  // Extract non-trivial tokens from the query (≥ 2 chars, no pure stop-words)
  const STOP = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
    'how', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'up', 'we']);
  const queryTokens = query
    .toLowerCase()
    .split(/[\s/.,;:?!()[\]{}"'`\\]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));

  if (queryTokens.length === 0) return hits;

  const boosted = hits.map((h) => {
    // Build the set of normalized segments from structural fields
    const structuralSegments = new Set<string>();

    // topic: "myproject/auth/oauth" → ["myproject", "auth", "oauth"]
    for (const seg of (h.topic ?? '').toLowerCase().split(/[\s/._-]+/).filter(Boolean)) {
      structuralSegments.add(seg);
    }

    // codeFile: "src/retrieval/router.ts" → ["src", "retrieval", "router", "ts"]
    for (const seg of (h.codeFile ?? '').toLowerCase().split(/[\s/._-]+/).filter(Boolean)) {
      structuralSegments.add(seg);
    }

    // tags: "code typescript myproject" → ["code", "typescript", "myproject"]
    for (const seg of (h.tags ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      structuralSegments.add(seg);
    }

    const hasStructuralMatch = queryTokens.some((t) => structuralSegments.has(t));
    if (!hasStructuralMatch) return h;

    return { ...h, score: h.score * STRUCTURAL_EXACT_BOOST };
  });

  return [...boosted].sort((a, b) => b.score - a.score);
}

/**
 * Notes with anti-pattern warnings or explicit negation in body text.
 */
export function notesWithWarningsOrNegative(
  query: string,
  limit = 8,
  sourcePrefix?: string,
): IndexedNote[] {
  let candidates = listAllWithText({ includeExpired: false }).filter(
    (n) =>
      Boolean((n.warnings ?? '').trim()) ||
      /\b(do not retry|abandoned|reverted|broke streaming|tried using|do not use)\b/i.test(n.text),
  );
  if (sourcePrefix) {
    candidates = candidates.filter((n) => (n.source ?? '').startsWith(sourcePrefix));
  }
  if (candidates.length === 0) return [];
  const allowed = new Set(candidates.map((c) => c.id));
  const ftsHits = searchFts(query, { limit: limit * 4, sourcePrefix });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: IndexedNote[] = [];
  for (const h of ftsHits) {
    if (!allowed.has(h.id)) continue;
    const n = byId.get(h.id);
    if (n) out.push(n);
    if (out.length >= limit) break;
  }
  if (out.length < limit) {
    for (const c of candidates) {
      if (out.some((o) => o.id === c.id)) continue;
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ============================================================
// Speed fix: SQLite-backed note embedding store
// ============================================================

const EMB_DIM = 768; // bge-base-en-v1.5 output dimension

/**
 * Upsert a pre-computed embedding for a note.
 * Called by the indexer after each note is indexed (at build time).
 * embedTextHash: FNV-1a 32-bit hex of the exact text string that was embedded.
 * vector: Float32Array(768) from bge-base.
 */
export function upsertNoteEmbedding(
  id: string,
  embedTextHash: string,
  vector: Float32Array,
): void {
  const db = getDb();
  // Store as raw little-endian bytes (EMB_DIM * 4 bytes = 3072 bytes per note)
  const buf = Buffer.allocUnsafe(EMB_DIM * 4);
  for (let i = 0; i < EMB_DIM; i++) {
    buf.writeFloatLE(vector[i] ?? 0, i * 4);
  }
  db.prepare(`
    INSERT INTO note_embeddings (id, embed_text_hash, vector)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET embed_text_hash=excluded.embed_text_hash, vector=excluded.vector
  `).run(id, embedTextHash, buf);
}

export interface StoredNoteEmbedding {
  id: string;
  embedTextHash: string;
  vector: Float32Array;
}

/**
 * Load all stored note embeddings in one SQLite read.
 * Returns a Map<id, StoredNoteEmbedding> for O(1) lookup per note.
 * Empty Map when no embeddings have been stored yet (triggers fallback compute).
 */
export function loadAllStoredEmbeddings(): Map<string, StoredNoteEmbedding> {
  const db = getDb();
  const result = new Map<string, StoredNoteEmbedding>();
  try {
    const rows = db
      .prepare('SELECT id, embed_text_hash, vector FROM note_embeddings')
      .all() as Array<{ id: string; embed_text_hash: string; vector: Buffer }>;
    for (const row of rows) {
      const vec = new Float32Array(EMB_DIM);
      const buf = row.vector;
      for (let i = 0; i < EMB_DIM; i++) {
        vec[i] = buf.readFloatLE(i * 4);
      }
      result.set(row.id, { id: row.id, embedTextHash: row.embed_text_hash, vector: vec });
    }
  } catch {
    // table may not exist yet on a cold DB — return empty map, fallback to compute
  }
  return result;
}

/**
 * Delete stored embedding for a note (called on deleteNote).
 */
export function deleteNoteEmbedding(id: string): void {
  try {
    getDb().prepare('DELETE FROM note_embeddings WHERE id = ?').run(id);
  } catch {
    /* best-effort */
  }
}
