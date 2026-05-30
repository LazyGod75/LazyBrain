/**
 * Dream command: offline brain maintenance.
 *
 * Like the brain consolidating memories during sleep, this command runs offline to:
 *   1. Process ALL unread Claude Code conversations (no arbitrary limit)
 *   2. Expand stub notes (quality='stub') using Haiku to generate proper summaries
 *   3. Generate missing TLDRs for notes without section[data-section="tldr"]
 *   4. Detect contradictions between decision notes with same tags
 *   5. Find potential duplicates via embedding similarity
 *
 * Idempotent by design: always returns a report even if no work was done.
 * Uses SHA-256 fingerprints to skip unchanged conversations (incremental processing).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { annotateSession } from '../annotator/heuristic.js';
import { embed } from '../indexer/embeddings.js';
import { listAll } from '../indexer/fts.js';
import { stripNote } from '../retrieval/strip.js';
import { brainRoot } from '../store/paths.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { callClaudeCliJsonArray, isClaudeCliAvailable } from '../util/claude-cli.js';
import {
  loadFingerprints,
  saveFingerprints,
  hasChanged,
  recordProcessed,
  type FingerprintStore,
} from '../util/fingerprints.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { runSynthesize } from './synthesize.js';
import { extractToolTraceFiles } from './dream-tool-trace.js';

/**
 * Derive a deterministic, collision-resistant session id from a conversation
 * file path. Using the file path as the identity source guarantees:
 *
 * - Two DIFFERENT conversations (different paths) → different session ids
 *   → different note ids even when the summary text is identical.
 * - The SAME conversation re-processed → identical session id every run
 *   → same note id → fingerprint-skip and idempotent re-runs still work.
 *
 * Format: "dream-<8hex>" where <8hex> = first 8 chars of SHA-256(filePath).
 * The 8-char hex suffix gives 4 billion buckets — collision probability for
 * the typical ~1000-conversation corpus is ~1.2 × 10^-4 (negligible).
 */
export function makeConversationSessionId(filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 8);
  return `dream-${hash}`;
}

export interface DreamOptions {
  dryRun?: boolean;
  maxNotes?: number;
  enrich?: boolean;
  pretty?: boolean;
  synthesizeOnly?: boolean;
  topic?: string;
  /** When true, ignore fingerprints and reprocess all conversations. */
  force?: boolean;
}

interface DreamReport {
  startedAt: string;
  duration_ms: number;
  conversationsProcessed: number;
  conversationsSkipped: number;
  noiseCleanedUp: number;
  stubsExpanded: number;
  tldrsGenerated: number;
  contradictionsFound: number;
  duplicatesMerged: number;
}

interface TldrOutput {
  tldr: string;
  topic?: string;
}

interface DuplicatePair {
  id1: string;
  id2: string;
  similarity: number;
}

interface EmbeddingEntry {
  id: string;
  embedding: Float32Array;
}

// Legacy tracking file path — kept only for one-time migration during first fingerprint run
function legacyTrackingFilePath(): string {
  try {
    const root = brainRoot();
    const cacheDir = join(root, '..', '_cache');
    return join(cacheDir, 'dream-processed.json');
  } catch {
    return join(
      process.env.USERPROFILE ?? process.env.HOME ?? '.',
      '.lazybrain-dream-processed.json',
    );
  }
}

/**
 * Migrate legacy dream-processed.json (Set<string>) into the fingerprint store.
 * This is a one-shot migration: after the first fingerprint-enabled run the legacy
 * file is irrelevant but is left in place to avoid breaking older LazyBrain versions.
 */
function migrateLegacyTrackedFiles(store: FingerprintStore): FingerprintStore {
  const legacyPath = legacyTrackingFilePath();
  if (!existsSync(legacyPath)) return store;

  let legacyPaths: string[] = [];
  try {
    const data = JSON.parse(readFileSync(legacyPath, 'utf-8')) as unknown;
    if (Array.isArray(data)) legacyPaths = data as string[];
  } catch {
    return store;
  }

  // Import each legacy path as a fingerprint with an unknown hash so hasChanged
  // will trigger a slow-path hash check on the next run and only skip files that
  // have not changed since they were last seen.
  let migrated = store;
  for (const fp of legacyPaths) {
    if (migrated.files[fp]) continue; // already fingerprinted
    if (!existsSync(fp)) continue;
    try {
      const s = statSync(fp);
      // Store a placeholder with an empty hash so the slow path always re-hashes
      // on the very next run, but at least the fast path recognises the file.
      migrated = {
        ...migrated,
        files: {
          ...migrated.files,
          [fp]: {
            filePath: fp,
            contentHash: '',         // empty → slow path will rehash
            mtimeMs: s.mtimeMs,
            size: s.size,
            processedAt: new Date().toISOString(),
            notesCreated: [],
          },
        },
      };
    } catch {
      // Skip unreadable files
    }
  }
  return migrated;
}

/**
 * Show progress bar on stderr (not stdout).
 * Format: [████████░░░░░░░░░░] 40% [4/10] label text
 */
function showProgress(current: number, total: number, label: string): void {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const barLen = 20;
  const filled = Math.floor(pct / (100 / barLen));
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
  const labelStr = label.slice(0, 40).padEnd(40);
  process.stderr.write(
    `\r  ${bar} ${pct.toString().padStart(3)}% [${current}/${total}] ${labelStr}`,
  );
}

/**
 * Clear the progress bar line from stderr.
 */
function clearProgress(): void {
  process.stderr.write(`\r${' '.repeat(80)}\r`);
}

/**
 * Decode project directory name back to a path hint.
 *
 * Claude encodes project cwd into the directory name by replacing each
 * path separator with a single dash:
 *   "C:\Users\..." → "C--Users-..." (colon→dash, backslash→dash)
 *
 * The leading two-dash sequence is the Windows drive letter encoding:
 *   "C--" means "C:" + "\" (colon + backslash) → decoded as "C:/"
 *
 * Using "^([A-Za-z])-" (one dash) was wrong: it consumed only the first dash,
 * leaving a second leading dash that became an extra "/" after the global
 * replace, producing "C://Users/..." instead of "C:/Users/...".
 *
 * Examples:
 *   "C--Users-David-Projects-myapp" → "C:/Users/David/Projects/myapp"
 *   "home-user-projects-myapp-myapp-" → "home/user/projects/myapp/myapp/"
 */
function decodeProjectPath(dirName: string): string {
  return dirName
    // Windows drive letter: "X--" → "X:/" (two dashes = colon + path separator)
    .replace(/^([A-Za-z])--/, '$1:/')
    // All remaining dashes are path separators
    .replace(/-/g, '/');
}

/**
 * Process ALL unread Claude Code conversations from ~/.claude/projects/
 * Creates brain notes using heuristic annotation ($0, no LLM).
 *
 * Uses SHA-256 fingerprints for incremental processing:
 * - Fast path: mtime+size match → skip (no I/O beyond stat)
 * - Slow path: hash mismatch → reprocess
 * - --force flag: ignore fingerprints, reprocess everything
 *
 * Returns [notesCreated, filesSkipped].
 */
async function processUnreadConversations(opts: DreamOptions): Promise<{ created: number; skipped: number }> {
  const log = getLogger();
  const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const claudeDir = join(userProfile, '.claude', 'projects');

  if (!existsSync(claudeDir)) {
    if (opts.pretty) {
      process.stderr.write('  No Claude projects directory found.\n');
    } else {
      log.info('No Claude projects directory found, skipping conversation scan');
    }
    return { created: 0, skipped: 0 };
  }

  // Load fingerprint store and migrate legacy tracking file (one-time)
  let store: FingerprintStore = opts.force ? { version: '1.0.0', generatedAt: new Date().toISOString(), files: {} } : loadFingerprints();
  if (!opts.force) {
    store = migrateLegacyTrackedFiles(store);
  }

  // Collect ALL conversation files (no pre-filter by fingerprint yet)
  const allFiles: Array<{ path: string; mtime: number; project: string }> = [];
  try {
    const projects = readdirSync(claudeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const proj of projects) {
      // Skip own project directories to prevent self-referential ingestion (case-insensitive)
      if (/cerveau|lazybrain/i.test(proj.name)) continue;

      const projPath = join(claudeDir, proj.name);
      for (const f of findConversationFiles(projPath)) {
        try {
          const stat = statSync(f);
          allFiles.push({ path: f, mtime: stat.mtimeMs, project: proj.name });
        } catch {
          /* skip unreadable files */
        }
      }
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'dream: conversation scan failed');
    return { created: 0, skipped: 0 };
  }

  if (allFiles.length === 0) {
    if (opts.pretty) {
      process.stderr.write('  No conversations found.\n');
    }
    return { created: 0, skipped: 0 };
  }

  // Split into changed vs unchanged using fingerprints
  const changedFiles = opts.force
    ? allFiles
    : allFiles.filter((f) => hasChanged(f.path, store));
  const skippedCount = allFiles.length - changedFiles.length;

  // Sort most recent first
  changedFiles.sort((a, b) => b.mtime - a.mtime);

  if (opts.pretty) {
    process.stderr.write(
      `\n  Found ${allFiles.length} conversations: ${changedFiles.length} new/changed, ${skippedCount} unchanged (skipped)\n\n`,
    );
  }

  if (changedFiles.length === 0) {
    if (!opts.force) {
      // Still save the store in case of migration updates
      if (!opts.dryRun) saveFingerprints(store);
    }
    return { created: 0, skipped: skippedCount };
  }

  let created = 0;

  // Result of processing one conversation file.
  interface ConvResult {
    filePath: string;
    noteIds: string[];
  }

  /**
   * Process a single conversation file and return the note IDs created.
   * Pure function: reads file, extracts summary, writes note to its own path.
   * Safe to run concurrently because each file maps to a distinct note path.
   */
  async function processOneConversation(
    file: { path: string; mtime: number; project: string },
  ): Promise<ConvResult> {
    const noteIds: string[] = [];
    try {
      const content = await readFile(file.path, 'utf-8');
      const projectRoot = decodeProjectPath(file.project);
      const summary = extractConversationSummary(content, projectRoot);

      if (summary.text && summary.text.length > 50) {
        const result = annotateSession({
          sessionId: makeConversationSessionId(file.path),
          text: summary.text.slice(0, 4000),
          timestamp: new Date(file.mtime).toISOString(),
          cwd: projectRoot,
          filesModified: summary.filesModified.length > 0 ? summary.filesModified : undefined,
          filesRead: summary.filesRead.length > 0 ? summary.filesRead : undefined,
        });

        if (result.html && result.factCount > 0) {
          writeNote(result.html);
          noteIds.push(result.id);
          log.debug(
            { id: result.id, facts: result.factCount, filesModified: summary.filesModified.length, filesRead: summary.filesRead.length },
            'dream: created note from conversation',
          );
        }
      }
    } catch (err) {
      log.warn(
        { file: file.path, err: (err as Error).message },
        'dream: conversation processing failed',
      );
      // Return empty noteIds — we still record the file as processed below
      // to avoid infinite retry on permanently broken files.
    }
    return { filePath: file.path, noteIds };
  }

  // Bounded concurrency pool: process up to DREAM_CONCURRENCY files at a time.
  // Each worker is independent (distinct output paths), so concurrent execution is safe.
  // Shared mutable state (store, created counter) is updated AFTER each batch,
  // in input order, to preserve determinism identical to the sequential version.
  const DREAM_CONCURRENCY = 12;

  if (opts.dryRun) {
    // Dry-run: no I/O needed — just count and record in order.
    for (const file of changedFiles) {
      store = recordProcessed(file.path, [], store);
      created++;
    }
  } else {
    let progressCount = 0;

    for (let batchStart = 0; batchStart < changedFiles.length; batchStart += DREAM_CONCURRENCY) {
      const batch = changedFiles.slice(batchStart, batchStart + DREAM_CONCURRENCY);

      // Launch all workers in this batch concurrently.
      const results = await Promise.all(batch.map((file) => processOneConversation(file)));

      // Fold results back into shared state IN INPUT ORDER (deterministic).
      for (const result of results) {
        store = recordProcessed(result.filePath, result.noteIds, store);
        if (result.noteIds.length > 0) created++;
      }

      // Progress reporting (approximate position — middle of batch shown).
      progressCount += batch.length;
      if (opts.pretty) {
        const lastFile = batch[batch.length - 1];
        showProgress(progressCount, changedFiles.length, lastFile.project);
      }
    }
  }

  if (opts.pretty) {
    clearProgress();
  }

  // Persist fingerprints
  if (!opts.dryRun) {
    try {
      saveFingerprints(store);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'dream: fingerprint save failed');
    }
  }

  return { created, skipped: skippedCount };
}

/**
 * Find JSONL conversation files in a project directory (shallow 2-level scan).
 */
function findConversationFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
        files.push(full);
      } else if (entry.isDirectory()) {
        // Limit recursion depth to subdirs
        try {
          for (const sub of readdirSync(full, { withFileTypes: true })) {
            if (sub.isFile() && (sub.name.endsWith('.jsonl') || sub.name.endsWith('.json'))) {
              files.push(join(full, sub.name));
            }
          }
        } catch {
          /* skip unreadable subdirs */
        }
      }
    }
  } catch {
    /* skip unreadable dirs */
  }
  return files;
}

/**
 * Extract text from a message object (supports both string and structured content).
 */
function extractTextFromMessage(obj: Record<string, unknown>): string | null {
  if (typeof obj.content === 'string') return obj.content;
  if (!Array.isArray(obj.content)) return null;

  const texts: string[] = [];
  for (const block of obj.content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
    }
  }
  return texts.join(' ').trim() || null;
}

interface ConversationSummary {
  /** Prose text — up to 4000 chars of the most valuable conversation content. */
  text: string;
  /** Project-relative forward-slash paths touched by Edit / Write calls. */
  filesModified: string[];
  /** Project-relative forward-slash paths touched by Read calls. */
  filesRead: string[];
}

/**
 * Conservative filter for obvious agent meta-commentary that should never enter
 * the knowledge store.
 *
 * Matches generic structural markers emitted by agent frameworks and orchestration
 * systems (progress summaries, XML-style observation blocks, memory-agent headers,
 * memory-observer instruction templates, bare XML schema-tag residue).
 * Only drops text that is unambiguously meta — not regular prose that happens to
 * contain these words in passing. When in doubt, keep the text (false negatives are
 * cheaper than false positives that destroy real knowledge).
 *
 * @param text Raw text chunk to evaluate (may be trimmed or untrimmed).
 * @returns true if the chunk is agent/framework scaffolding that should be discarded.
 */
export function isAgentMetaText(text: string): boolean {
  const trimmed = text.trim();

  // Fenced progress/mode-switch banners: "--- SOME HEADING ---"
  // These are emitted by agent orchestrators to mark phase transitions and
  // are never substantive prose.
  if (/^-{3,}\s*[A-Z][A-Z\s:]+[A-Z]\s*-{3,}/.test(trimmed)) return true;

  // XML-style agent observation/thinking blocks (opening tags).
  // These open structural sections inside claude-mem / memory-observer frameworks;
  // the tag itself — or a chunk starting with it — is scaffolding, not knowledge.
  if (/^<\/?(observation|thinking|reflection|memory[_-]?update|fact|status|title|summary|entry|note)\s*[\s>\/]/i.test(trimmed)) return true;

  // Chunks that are NOTHING but XML schema-tag residue (closing-tag fragments left
  // after HTML stripping), optionally followed by punctuation/whitespace.
  // Example: "</fact>." or "</status>." or "<observation>".
  // We only drop the chunk when the ENTIRE trimmed content is such a tag — not when
  // a real sentence merely contains an XML word somewhere.
  if (/^[<>/\s.]*<\/?\s*(fact|status|title|observation|thinking|note|summary|entry)\s*>[.\s]*$/i.test(trimmed)) return true;

  // Memory-observer instruction templates (claude-mem-style system prompts).
  // "CRITICAL: Record what was LEARNED/BUILT/fixed/deployed/configured" is the
  // canonical phrasing of a memory-observer prompt injected by agent harnesses.
  // It is never real prose: no human or LLM response says "record what was built"
  // as a factual claim about the domain.
  if (/record\s+what\s+was\s+(?:learned|built|fixed|deployed|configured)/i.test(trimmed)) return true;

  // Memory-agent self-introduction patterns: "hello memory agent", "observing the primary".
  if (/\bhello\s+(memory|brain|agent)\b/i.test(trimmed)) return true;
  if (/\bobserving\s+the\s+primary\b/i.test(trimmed)) return true;

  // Claude Code / agent-harness output: Stop hook feedback line.
  // This is the literal harness-generated phrase prepended to hook failure messages
  // and never appears in legitimate domain prose.
  if (/\bStop hook feedback\b/i.test(trimmed)) return true;

  // Claude Code / agent-harness mandatory-tool instruction.
  // The full harness phrase "call the StructuredOutput tool to complete" is unique
  // to the harness scaffolding; bare "StructuredOutput" alone is intentionally
  // NOT matched because it can legitimately appear in LLM-tooling prose.
  if (/call the StructuredOutput tool to complete/i.test(trimmed)) return true;

  // Placeholder / template residue from retrieval-augmented generation prompts.
  // These patterns originate from a prompt-injection attack where a recall prompt
  // ("You write a short fictional memory note…") leaked into conversation text and
  // was stored as a real brain note. They are self-referential meta-instructions,
  // never domain knowledge.
  if (isPlaceholderNoise(trimmed)) return true;

  // LazyBrain note infobox residue — machine-format metadata that leaked into text.
  // These patterns mirror isNoteMetadataResidue() in enrich.ts (kept inline here to
  // avoid a circular import: enrich.ts already imports from dream.ts).
  //
  // Pattern 1: "Source session:<word>-<6+hex>" — unique LazyBrain session id.
  if (/Source\s+session:[a-z]+-[0-9a-f]{6,}/i.test(trimmed)) return true;
  // Pattern 2: "Type <kind> Status <state>" infobox — strict adjacency, known kinds.
  if (
    /^(?:\d{4}-\d{2}-\d{2}\s+)?Type\s+(?:episodic|reference|semantic|decision|architecture|feature|feature-set)\s+Status\s+(?:active|deprecated|draft)\b/i.test(
      trimmed,
    )
  )
    return true;
  // Pattern 3: "Type <word> Status <word> Tags" triplet — general infobox form.
  if (/^\s*Type\s+\w[\w-]*\s+Status\s+\w[\w-]*\s+Tags\b/i.test(trimmed)) return true;
  // Pattern 4: "Kind <x> Files <n> Lines <n>" — file-neuron / aggregate-neuron infobox.
  if (/\bKind\s+\w[\w-]*\s+Files\s+\d+\s+Lines\s+\d+\b/i.test(trimmed)) return true;

  return false;
}

/**
 * Detect self-referential placeholder / template noise that should never be stored.
 *
 * This catches text fragments that come from prompt-injection residue where a
 * retrieval-augmented generation prompt (e.g. the "recall" skill's instruction to
 * write a fictional memory note) leaked into the conversation and was captured as
 * a real brain note.
 *
 * Patterns matched (all require a distinctive phrase, NOT individual common words):
 *  - "a real note on this topic would (mention|ment)" — canonical placeholder ending
 *  - "strings,? decisions that" — the distinctive prompt lead-in phrase
 *  - "you write a short fictional (memory )?note" — the system-prompt instruction line
 *  - "output only the note body" — canonical instruction suffix in the same prompt
 *  - "hypothetically answers the user's search query" — unique phrase in the prompt
 *  - "concrete vocabulary: include the named entities" — unique instruction phrase
 *
 * Deliberately NOT matched: "decision", "note", "strings", "topic" in isolation —
 * those are common domain words. Only the exact multi-word phrases are matched.
 *
 * @param text Already-trimmed text to test.
 * @returns true when the text is template/placeholder noise.
 */
export function isPlaceholderNoise(text: string): boolean {
  // "a real note on this topic would mention" (allow "ment" as truncated form)
  if (/a real note on this topic would\s+ment/i.test(text)) return true;

  // "strings, decisions that" — the distinctive prompt preamble
  if (/strings,?\s+decisions that/i.test(text)) return true;

  // The fictional-note instruction line from the RAG recall prompt
  if (/you write a short fictional\s+(?:memory\s+)?note/i.test(text)) return true;

  // "output only the note body" — canonical closing instruction
  if (/output\s+only\s+the\s+note\s+body/i.test(text)) return true;

  // "hypothetically answers the user's search query" — unique phrase
  if (/hypothetically\s+answers\s+the\s+user.{0,5}s\s+search\s+query/i.test(text)) return true;

  // "concrete vocabulary: include the named entities" — unique phrase
  if (/concrete\s+vocabulary:\s+include\s+the\s+named\s+entities/i.test(text)) return true;

  return false;
}

/**
 * Extract conversation summary from JSONL transcript.
 * Extracts BOTH human AND assistant messages, categorizing by decision/error/fact/general.
 * Also scans tool_use blocks to extract file paths (AUTHORITATIVE via parseToolPayload).
 *
 * @param content     Raw JSONL content of the conversation file.
 * @param projectRoot Absolute path to the project (used to relativise tool paths).
 */
function extractConversationSummary(content: string, projectRoot: string): ConversationSummary {
  const lines = content.split('\n').filter(Boolean);
  const decisions: string[] = [];
  const errors: string[] = [];
  const facts: string[] = [];
  const general: string[] = [];

  function categorizeMessage(
    text: string,
    decisions: string[],
    errors: string[],
    facts: string[],
    general: string[],
  ): void {
    if (
      /\b(decided|decision|chose|choosing|switched|migration|use .+ instead|we('ll| will) use|going with|opted for)\b/i.test(
        text,
      )
    ) {
      decisions.push(text);
    } else if (/\b(error|bug|fix|broken|failed|crash|issue|exception|traceback)\b/i.test(text)) {
      errors.push(text);
    } else if (
      /\b(because|reason|important|always|never|warning|careful|don't|avoid|must|should|need to|has to)\b/i.test(
        text,
      )
    ) {
      facts.push(text);
    } else if (text.length > 40) {
      general.push(text);
    }
  }

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      const msgType = (obj.type as string) ?? (obj.role as string) ?? '';
      const isUser = msgType === 'user' || msgType === 'human';
      const isAssistant = msgType === 'assistant';

      if (!isUser && !isAssistant) continue;

      const message = obj.message as Record<string, unknown> | undefined;
      const textSource = message ?? obj;
      const text = extractTextFromMessage(textSource);
      if (!text || text.length < 20) continue;

      // Drop obvious agent meta-commentary before any further processing.
      if (isAgentMetaText(text)) continue;

      if (isUser) {
        categorizeMessage(text.slice(0, 500), decisions, errors, facts, general);
      }

      if (isAssistant) {
        if (text.startsWith('{') || text.startsWith('[') || text.startsWith('```')) continue;
        if (/^(Running|Reading|Searching|Checking|Let me)/i.test(text)) continue;
        categorizeMessage(text.slice(0, 600), decisions, errors, facts, general);
      }
    } catch {
      /* skip malformed lines */
    }
  }

  const parts = [
    ...decisions.slice(0, 8),
    ...errors.slice(0, 5),
    ...facts.slice(0, 5),
    ...general.slice(-3),
  ];

  const text = parts.join('\n\n').slice(0, 4000);

  // Extract tool-trace file paths via parseToolPayload (authoritative, no reimplementation).
  const { filesModified, filesRead } = extractToolTraceFiles(content, projectRoot);

  return { text, filesModified, filesRead };
}

/**
 * Extract text from HTML for processing.
 */
function extractText(html: string): string {
  try {
    return stripNote(html).text;
  } catch {
    return '';
  }
}

/**
 * Check if a note has a TLDR section.
 */
function hasTldr(html: string): boolean {
  return html.includes('data-section="tldr"') || html.includes('data-cerveau-tldr');
}

/**
 * Inject a TLDR section into HTML.
 */
function injectTldr(html: string, tldr: string): string {
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  const article = document.querySelector('article');
  if (!article) return html;

  // Create a TLDR section
  const tldrSection = document.createElement('section');
  tldrSection.setAttribute('data-section', 'tldr');
  const p = document.createElement('p');
  p.textContent = tldr;
  tldrSection.appendChild(p);

  // Insert after the first heading
  const firstHeading = article.querySelector('h1, h2, h3');
  if (firstHeading?.nextSibling) {
    firstHeading.nextSibling.parentElement?.insertBefore(tldrSection, firstHeading.nextSibling);
  } else {
    article.appendChild(tldrSection);
  }

  return article.outerHTML;
}

/**
 * Detect noise patterns in note text.
 * Returns true if the note appears to be low-quality noise.
 */
function detectNoise(text: string): boolean {
  const trimmed = text.trim();

  // Too short to be useful
  if (trimmed.length < 60) return true;

  // Pure JSON/log dumps
  const lines = trimmed.split('\n').filter(Boolean);
  const jsonLines = lines.filter(
    (l) => l.trim().startsWith('{') || l.trim().startsWith('['),
  ).length;
  if (lines.length > 2 && jsonLines / lines.length > 0.5) return true;

  // Pure tool output with session metadata
  if (trimmed.includes('session_id') && trimmed.includes('transcript_path')) return true;
  if (trimmed.includes('tool_name') && trimmed.includes('tool_input')) return true;

  // Pure file path dumps
  if (/^(Edit|Write|Read|Grep|Glob|Bash):?\s+\S+\s*$/m.test(trimmed) && trimmed.length < 200)
    return true;

  // Command output with no insight
  if (/^(npx|npm|node|tsx|vitest|git)\s/m.test(trimmed) && trimmed.length < 150) return true;

  // Repetitive content (same phrase repeated)
  const uniqueLines = new Set(lines.map((l) => l.trim().slice(0, 50)));
  if (lines.length > 5 && uniqueLines.size < lines.length * 0.3) return true;

  return false;
}

/**
 * Main dream function.
 */
export async function runDream(opts: DreamOptions): Promise<DreamReport> {
  const log = getLogger();
  const start = Date.now();
  const report: DreamReport = {
    startedAt: nowIso(),
    duration_ms: 0,
    conversationsProcessed: 0,
    conversationsSkipped: 0,
    noiseCleanedUp: 0,
    stubsExpanded: 0,
    tldrsGenerated: 0,
    contradictionsFound: 0,
    duplicatesMerged: 0,
  };

  const maxNotes = opts.maxNotes ?? 20;
  const allNotes = listAll({ includeExpired: false });

  log.info({ total: allNotes.length, maxNotes }, 'dream: starting');

  if (opts.synthesizeOnly) {
    log.info({ topic: opts.topic }, 'dream: synthesize-only mode');
    const synthReport = await runSynthesize({ dryRun: opts.dryRun, topic: opts.topic });
    log.info(
      { synthesized: synthReport.synthesized.length, skipped: synthReport.skipped.length },
      'dream: synthesize done',
    );
    if (synthReport.errors.length > 0) {
      log.warn({ errors: synthReport.errors }, 'dream: synthesize errors');
    }
    report.duration_ms = Date.now() - start;
    return report;
  }

  const isCliAvailable = await isClaudeCliAvailable();

  // Phase 0: Process unread conversations (ALL, no limit)
  const { created: conversationsProcessed, skipped: conversationsSkipped } = await processUnreadConversations(opts);
  report.conversationsProcessed = conversationsProcessed;
  report.conversationsSkipped = conversationsSkipped;

  // Phase 0.5: Noise cleanup — invalidate low-quality notes
  const refreshedNotes = listAll({ includeExpired: false });
  let noiseCount = 0;

  for (let i = 0; i < refreshedNotes.length; i++) {
    const n = refreshedNotes[i];
    if (opts.pretty && i % 50 === 0) {
      showProgress(i, refreshedNotes.length, 'Checking note quality');
    }

    try {
      const note = readNote(n.path);
      const text = stripNote(note.html).text;

      // Skip notes with high importance or type=decision
      if ((n.importance ?? 0) >= 0.7 || n.type === 'decision') continue;

      // Detect noise patterns
      const isNoise = detectNoise(text);

      if (isNoise) {
        if (!opts.dryRun) {
          // Invalidate by adding valid_until
          const invalidated = note.html.replace(
            /data-cerveau-tier="working"/,
            `data-cerveau-tier="working" data-cerveau-valid-until="${nowIso()}" data-cerveau-invalidated-by="dream-noise-cleanup"`,
          );
          writeFileSync(n.path, invalidated, 'utf-8');
        }
        noiseCount++;
      }
    } catch {
      // skip unreadable notes
    }
  }

  if (opts.pretty) {
    clearProgress();
    if (noiseCount > 0) {
      process.stderr.write(`  Cleaned ${noiseCount} noise notes\n`);
    }
  }

  report.noiseCleanedUp = noiseCount;

  // Phase 1: Expand stubs
  const stubs = allNotes.filter((n) => n.quality === 'stub').slice(0, maxNotes);

  if (stubs.length > 0) {
    if (opts.pretty) {
      process.stderr.write(`\n  Expanding ${stubs.length} stubs\n\n`);
    }
    log.info({ count: stubs.length }, 'dream: processing stubs');
    for (let i = 0; i < stubs.length; i++) {
      const stub = stubs[i];
      if (opts.pretty) {
        showProgress(i + 1, stubs.length, 'Stub expansion');
      }

      try {
        const note = readNote(stub.path);
        const text = extractText(note.html);
        if (text.length < 50) continue;

        if (isCliAvailable && !opts.dryRun) {
          const result = await callClaudeCliJsonArray<TldrOutput>(
            `Summarize this note in one sentence (tldr) and infer a topic path (e.g. "project/feature/module"):\n\n${text.slice(0, 2000)}`,
            {
              system:
                'Output a JSON array with one object: {"tldr": "one sentence summary", "topic": "hierarchical/topic/path"}. No prose.',
              model: 'haiku',
              timeoutMs: 15000,
            },
          );
          if (result?.[0]?.tldr) {
            const updated = injectTldr(note.html, result[0].tldr);
            if (!opts.dryRun) {
              writeFileSync(stub.path, updated, 'utf8');
            }
            report.stubsExpanded += 1;
            log.debug({ id: stub.id, tldr: result[0].tldr }, 'dream: stub expanded');
          }
        }
      } catch (err) {
        log.warn({ id: stub.id, err: (err as Error).message }, 'dream: stub expansion failed');
      }
    }
    if (opts.pretty) {
      clearProgress();
    }
  }

  // Phase 2: Generate missing TLDRs with smart Haiku enrichment
  const noTldr = allNotes.filter((n) => {
    try {
      const note = readNote(n.path);
      return !hasTldr(note.html);
    } catch {
      return false;
    }
  });

  const enrichCount = noTldr.length;
  let shouldEnrich = opts.enrich ?? false;

  if (!shouldEnrich && enrichCount > 0 && enrichCount <= 200) {
    // Auto-enrich when manageable (< 200 notes, ~$0.05)
    shouldEnrich = true;
    if (opts.pretty) {
      process.stderr.write(
        `\n  Auto-enriching ${enrichCount} notes with Haiku (~$${(enrichCount * 0.00025).toFixed(2)})\n\n`,
      );
    }
  } else if (!shouldEnrich && enrichCount > 200) {
    if (opts.pretty) {
      process.stderr.write(
        `\n  ${enrichCount} notes need TLDRs. Run with --enrich to process (~$${(enrichCount * 0.00025).toFixed(2)})\n`,
      );
    }
  }

  if (shouldEnrich && isCliAvailable) {
    const toProcess = noTldr.slice(0, opts.maxNotes ?? 200);
    log.info({ count: toProcess.length }, 'dream: generating missing TLDRs');
    for (let i = 0; i < toProcess.length; i++) {
      const note = toProcess[i];
      if (opts.pretty) {
        showProgress(i + 1, toProcess.length, 'Enriching with Haiku');
      }

      try {
        const content = readNote(note.path);
        const text = extractText(content.html);
        if (text.length < 50) continue;

        const result = await callClaudeCliJsonArray<TldrOutput>(
          `Create a one-sentence TLDR for this note:\n\n${text.slice(0, 1500)}`,
          {
            system:
              'Output a JSON array with one object: {"tldr": "one sentence summary"}. No prose.',
            model: 'haiku',
            timeoutMs: 15000,
          },
        );
        if (result?.[0]?.tldr && !opts.dryRun) {
          const updated = injectTldr(content.html, result[0].tldr);
          writeFileSync(note.path, updated, 'utf8');
          report.tldrsGenerated += 1;
        }
      } catch (err) {
        log.warn({ id: note.id, err: (err as Error).message }, 'dream: TLDR generation failed');
      }
    }
    if (opts.pretty) {
      clearProgress();
    }
  }

  // Phase 3: Detect contradictions between decision notes
  const decisions = allNotes
    .filter((n) => n.type === 'decision' && !n.valid_until)
    .slice(0, maxNotes);

  if (decisions.length > 1) {
    const tagGroups = new Map<string, typeof decisions>();
    for (const d of decisions) {
      const tags = (d.tags ?? '').split(/\s+/).filter(Boolean);
      for (const tag of tags) {
        const group = tagGroups.get(tag) ?? [];
        group.push(d);
        tagGroups.set(tag, group);
      }
    }

    for (const [tag, group] of tagGroups) {
      if (group.length > 1) {
        report.contradictionsFound += 1;
        log.info({ tag, count: group.length }, 'dream: potential contradiction in decisions');
      }
    }
  }

  // Phase 4: Find potential duplicates via embedding similarity
  if (allNotes.length > 1) {
    try {
      const candidates = allNotes.slice(0, Math.min(maxNotes * 2, allNotes.length));
      const textsToEmbed: string[] = [];
      const candidateIndices: number[] = [];

      for (let i = 0; i < candidates.length; i++) {
        try {
          const content = readNote(candidates[i].path);
          const text = extractText(content.html);
          if (text.length >= 100) {
            textsToEmbed.push(text.slice(0, 1000));
            candidateIndices.push(i);
          }
        } catch {
          // skip
        }
      }

      if (textsToEmbed.length > 1) {
        const embeddings: EmbeddingEntry[] = [];
        const embeds = await embed(textsToEmbed);
        if (embeds && embeds.length > 0) {
          for (let i = 0; i < candidateIndices.length; i++) {
            embeddings.push({
              id: candidates[candidateIndices[i]].id,
              embedding: embeds[i],
            });
          }

          // Find pairs with high similarity
          const duplicates: DuplicatePair[] = [];
          for (let i = 0; i < embeddings.length; i++) {
            for (let j = i + 1; j < embeddings.length; j++) {
              const sim = cosineSimilarity(embeddings[i].embedding, embeddings[j].embedding);
              if (sim > 0.85) {
                duplicates.push({
                  id1: embeddings[i].id,
                  id2: embeddings[j].id,
                  similarity: sim,
                });
              }
            }
          }

          if (duplicates.length > 0) {
            report.duplicatesMerged = duplicates.length;
            log.info({ count: duplicates.length }, 'dream: found potential duplicates');
          }
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'dream: duplicate detection failed');
    }
  }

  // Phase 5 — Synthesize topic overviews + brain index
  log.info('dream: phase 5 — synthesize wiki pages');
  try {
    const synthReport = await runSynthesize({ dryRun: opts.dryRun });
    log.info(
      { synthesized: synthReport.synthesized.length, skipped: synthReport.skipped.length },
      'dream: synthesize done',
    );
    if (synthReport.errors.length > 0) {
      log.warn({ errors: synthReport.errors }, 'dream: synthesize errors');
    }
    if (opts.pretty) {
      process.stderr.write(`\n  Synthesized: ${synthReport.synthesized.length} pages`);
      process.stderr.write(`\n  Skipped (fresh): ${synthReport.skipped.length}\n`);
      if (synthReport.errors.length > 0) {
        process.stderr.write(`  Errors: ${synthReport.errors.join(', ')}\n`);
      }
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'dream: synthesize phase failed');
  }

  report.duration_ms = Date.now() - start;

  logTelemetry({
    event: 'compress',
    ts: nowIso(),
    in_count: allNotes.length,
    out_size_bytes: 0,
    compression_ratio: 0,
    model: 'dream',
  });

  // Final report (pretty mode)
  if (opts.pretty) {
    const w = (s: string) => process.stderr.write(s);
    w('\n');
    w('  Dream report\n');
    w('  ════════════════════════════════════════════\n');
    w(`  Conversations read:    ${report.conversationsProcessed}\n`);
    w(`  Conversations skipped: ${report.conversationsSkipped} (unchanged, fingerprint match)\n`);
    w(`  Noise cleaned:         ${report.noiseCleanedUp}\n`);
    w(`  Notes enriched:        ${report.tldrsGenerated}\n`);
    w(`  Stubs expanded:        ${report.stubsExpanded}\n`);
    w(`  Contradictions found:  ${report.contradictionsFound}\n`);
    w(`  Duplicates detected:   ${report.duplicatesMerged}\n`);
    w(`  Duration:              ${(report.duration_ms / 1000).toFixed(1)}s\n`);
    w('  ════════════════════════════════════════════\n');

    // Count remaining notes without TLDRs
    const remainingNoTldr = allNotes.filter((n) => {
      try {
        return !hasTldr(readNote(n.path).html);
      } catch {
        return false;
      }
    }).length;

    if (remainingNoTldr > 0 && !opts.enrich) {
      const cost = (remainingNoTldr * 0.00025).toFixed(2);
      w('\n');
      w('  Next steps:\n');
      w(`  ${remainingNoTldr} notes still need TLDRs for better recall.\n`);
      w('  Run: lazybrain dream --enrich --pretty\n');
      w(`  Cost: ~$${cost} (Haiku via your Claude subscription)\n`);
      w('  This generates 1-sentence summaries and topic paths.\n');
    }

    if (report.contradictionsFound > 0) {
      w(`\n  ${report.contradictionsFound} potential contradictions found.\n`);
      w(
        '  Run: lazybrain query \'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])\' --pretty\n',
      );
      w('  to review active decisions and resolve conflicts.\n');
    }

    w('\n');
  }

  return report;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}
