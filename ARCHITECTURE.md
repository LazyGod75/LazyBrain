# LazyBrain — Architecture

## Pillars

### 1. HTML as storage format

A note is an `<article>` (or `<section>`) annotated with `data-cerveau-*` attributes (spec: [spec/cerveau-attributes.md](./spec/cerveau-attributes.md)). The note lives in a flat file on disk; git tracks it as text; any browser can render it.

### 2. CSS as query language

The browser's CSS engine is 30 years old and optimised in C++. We treat it as a free, ultra-fast index for structural queries:

```
article[data-cerveau-type="decision"]
[data-cerveau-tags~="auth"]:not([data-cerveau-valid-until])
a[data-cerveau-link-type="contradicts"]
```

Each cerveau attribute is a sortable/filterable column in zero extra infrastructure.

### 3. Strip-tags for LLM injection

When a result has to land in the LLM's context, we **strip the HTML to `textContent`** with structural hints (paragraph breaks, list dashes, external href URLs preserved as suffix). Cost: the raw HTML compresses down to ~30-40% of its byte size, and the LLM sees clean prose.

### 4. Adaptive retrieval router

Five levels of escalation, cheapest first:

| Level | What | Cost | Latency | When |
|-------|------|-----:|--------:|------|
| L1 | CSS selector (structural) | $0 | < 5 ms | query looks like a selector or matches filters exactly |
| L2 | SQLite FTS5 (BM25) | $0 | < 30 ms | short keyword query |
| L3 | WASM bi-encoder bge-base | $0 | ~150 ms | longer / fuzzy query |
| L4 | WASM cross-encoder ms-marco | $0 | +50 ms | top-K > 5 or quality-critical |
| L5 | LLM re-rank (optional) | ~$0 with cache | ~200 ms | explicit `--quality` flag |

The router heuristic (`src/retrieval/router.ts:pickLevel`) is intentionally simple. Replace with a learned classifier later.

### 5. Two-tier memory (working / archival)

`data-cerveau-tier="working"` for fresh notes. After N days, `lazybrain compress` rolls them into a `<memory-batch>` (tier=archival) that keeps pointers to the originals — never destructive, always reversible.

### 6. Temporal facts

`data-cerveau-valid-from` / `data-cerveau-valid-until` / `data-cerveau-invalidated-by` give every fact a lifecycle. Time-travel queries become trivial CSS selectors. Inspired by Graphiti's bi-temporal model, but inline in the HTML — no Neo4j required.

### 7. Local-first, optional public

Default mode: brain stays in a private folder + private git repo, accessed only by the CLI on the local machine. Optional `lazybrain publish` runs a strict scrubber (secret detection, attribute whitelist, no inline JS, CSP locked down) and emits a public copy ready for GitHub Pages.

### 8. Selective strip

HTML notes are stripped intelligently before injection: `data-cerveau-section` markers let you tag content that should stay / be removed for different contexts. The stripper preserves `<ul>`, `<li>`, `<code>`, and external URLs (as suffixes) while discarding structural markup. Result: ~42% token savings vs raw HTML, no semantic loss.

### 9. Topic tree & reasoning chains

Every note records `data-cerveau-topic` (hierarchical, e.g. "auth/oauth/state-validation") and optional `data-cerveau-reasoning` (the justification). The topic tree powers the `dream` command's weekly summaries and helps cluster related decisions.

### 10. Dream command

`lazybrain dream` reads Claude Code session transcripts, auto-extracts facts + decisions, and optionally invokes Haiku (`--enrich`) to generate summaries and connect related insights. Runs in ~0.02-0.05 per session. The output is structured HTML ready to merge into the brain. Weekly maintenance consolidates the working tier and archives old facts.

### 11. Per-turn intent detection

On `UserPromptSubmit`, the hook detects intent heuristically (search vs. code vs. analysis) and tags captured notes accordingly. L1 structural routing becomes more targeted — queries route faster when notes are tagged by intent.

## Data flow

### Write path

```
session transcript → annotator (heuristic ± LLM) → HTML note
       → validator (rejects bad schema, blocks secrets)
       → writer (flat file under brain/notes/YYYY-MM/<slug>.html)
       → indexer (FTS5 row + structural attributes)
       → telemetry event
```

### Read path

```
query → router.pickLevel()
  ├─ L1: structural CSS over readAllNotes() linkedom parses
  ├─ L2: FTS5 SELECT … MATCH …
  ├─ L3: embeddings.embedOne() → topKCosine over cached vectors
  └─ L4: rerank() on L3's top-50 → top-K
        → optional MMR diversification
        → optional stripNote() for LLM injection
        → telemetry event
```

### Hooks (Claude Code)

```
SessionStart       → lazybrain inject-context --strip       (silent additionalContext)
UserPromptSubmit   → lazybrain search "<prompt>" --strip    (per-turn RAG)
PostToolUse        → lazybrain capture --async              (queue, non-blocking)
PreCompact         → lazybrain capture --flush-sync         (drain queue)
Stop               → lazybrain capture --flush-sync && lazybrain compress &  (consolidation)
```

Every hook has a hard timeout and swallows errors. Claude never blocks on us.

## Index design (SQLite)

Two tables side-by-side:

```sql
CREATE TABLE notes (
  id PRIMARY KEY, path UNIQUE, title, type, tags, source,
  created, importance, valid_from, valid_until, mtime_ms
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  id UNINDEXED, title, text, tags,
  tokenize = "porter unicode61"
);
```

Both kept in sync by `indexer/fts.ts`. The structural attribute table is intentionally simple — no triggers, no FKs — because the HTML files are the source of truth. Rebuilding the index from disk is always safe (`lazybrain index-rebuild`).

## Embedding cache

Embeddings live in `_cache/embeddings.bin`. Format:

```
u32 count
for each:
  u8 keyLen
  utf8(keyBytes)
  f32 × 768  (LE)
```

Keys are FNV-1a 32-bit hashes of the input text. Cache hit rate is logged via `embed` telemetry events.

## Telemetry

JSONL stream at `_cache/telemetry.jsonl`. Schema in `src/util/telemetry.ts`. Events: `capture`, `query`, `inject`, `store`, `compress`, `error`, `embed`. The `bench/` scripts read this file to build daily reports.

## Security

- **At rest:** the brain folder is plain HTML on the filesystem. Inherit OS permissions.
- **At write:** validator rejects notes containing common secret patterns (PEM keys, GitHub tokens, OpenAI keys, etc.).
- **At publish:** scrubber strips all attributes outside a whitelist, removes forbidden tags (`<script>`, `<iframe>`, `<style>`…), redacts private paths in `data-cerveau-source` / `href` / `src`, and refuses publication outright on any secret hit. Output ships with strict CSP `default-src 'self'; script-src 'none'`.
- **Hooks:** all hook scripts have a 4-30s timeout and swallow errors. They never inject untrusted content directly — the CLI is invoked as a child process and its stdout is wrapped in JSON.

## Performance budget

| Operation | Target |
|---|---:|
| `lazybrain query` (L1) | < 5 ms |
| `lazybrain search` (L2) | < 30 ms |
| `lazybrain search` (L3) cold | < 500 ms (model load) |
| `lazybrain search` (L3) warm | < 150 ms |
| `lazybrain capture --async` | < 50 ms (queue write only) |
| `lazybrain inject-context` 3K tokens | < 30 ms |
| Index rebuild over 1000 notes | < 10 s |
