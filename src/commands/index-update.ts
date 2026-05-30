/**
 * Incremental index update command.
 *
 * Compares the SHA/mtime fingerprints of all note files against the stored
 * fingerprint store, then:
 *   - Re-indexes notes whose file changed (indexNote upsert).
 *   - Removes notes that no longer exist on disk (deleteNote).
 *   - Skips unchanged notes entirely.
 *
 * On a 1631-note brain this typically updates < 10 notes in a few seconds,
 * instead of the 15-minute full rebuild that was blocking the Stop hook.
 */

import { existsSync } from 'node:fs';
import { deleteNote, indexNote } from '../indexer/fts.js';
import { readAllNotes } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import {
  getChangedFiles,
  getOrphanedFingerprints,
  loadFingerprints,
  recordProcessed,
  saveFingerprints,
  type FingerprintStore,
} from '../util/fingerprints.js';

export interface IndexUpdateResult {
  indexed: number;
  deleted: number;
  skipped: number;
  failed: number;
  failures: string[];
}

export interface IndexUpdateCliOptions {
  pretty?: boolean;
}

/** Error codes / substrings that indicate SQLite file-lock contention. */
const SQLITE_LOCK_PATTERNS = [
  'SQLITE_BUSY',
  'database is locked',
  'disk I/O error',
  'SQLITE_IOERR',
];

function isLockedDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SQLITE_LOCK_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Core incremental update logic.
 *
 * 1. Load fingerprints from disk.
 * 2. Scan all note files on disk.
 * 3. For each file whose fingerprint is missing or stale → re-index.
 * 4. For each file tracked but no longer on disk → delete from index.
 * 5. Persist updated fingerprints.
 */
export function runIncrementalUpdate(): IndexUpdateResult {
  const log = getLogger();
  let store: FingerprintStore = loadFingerprints();

  const allNotes = readAllNotes();
  const allPaths = allNotes.map((n) => n.path);

  // Determine which files need (re-)indexing
  const changedPaths = new Set(getChangedFiles(allPaths, store));

  // Determine which tracked paths no longer exist on disk
  const orphanedPaths = getOrphanedFingerprints(store).filter((p) => !existsSync(p));

  let indexed = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  // Delete notes for files that are gone
  for (const orphanPath of orphanedPaths) {
    // Extract the note id from the stored fingerprint's notesCreated list,
    // or fall back to deriving it from the filename.
    const noteIds = store.files[orphanPath]?.notesCreated ?? [];
    const idsToDelete = noteIds.length > 0
      ? noteIds
      : [idFromPath(orphanPath)].filter((id): id is string => id !== null);

    for (const id of idsToDelete) {
      try {
        deleteNote(id);
        deleted += 1;
        log.debug({ id, path: orphanPath }, 'incremental: deleted orphaned note');
      } catch (err) {
        failed += 1;
        failures.push(`${orphanPath} (delete ${id}): ${(err as Error).message}`);
      }
    }

    // Remove orphaned entry from fingerprint store (immutable update)
    const { [orphanPath]: _removed, ...remaining } = store.files;
    store = { ...store, files: remaining };
  }

  // Re-index changed and new notes
  for (const note of allNotes) {
    if (!changedPaths.has(note.path)) {
      skipped += 1;
      continue;
    }
    try {
      const result = indexNote(note);
      store = recordProcessed(note.path, [result.id], store);
      indexed += 1;
      log.debug({ id: note.id, path: note.path }, 'incremental: indexed');
    } catch (err) {
      failed += 1;
      failures.push(`${note.path}: ${(err as Error).message}`);
    }
  }

  saveFingerprints(store);
  log.info({ indexed, deleted, skipped, failed }, 'incremental index update complete');

  return { indexed, deleted, skipped, failed, failures };
}

export function runIndexUpdate(opts: IndexUpdateCliOptions): string {
  try {
    const result = runIncrementalUpdate();
    if (opts.pretty) {
      let out =
        `Incremental update: ${result.indexed} indexed, ${result.deleted} deleted, ` +
        `${result.skipped} skipped, ${result.failed} failed.`;
      if (result.failures.length > 0) {
        out += `\n\nFailures:\n${result.failures.map((f) => `  - ${f}`).join('\n')}`;
      }
      return out;
    }
    return JSON.stringify(result, null, 2);
  } catch (err) {
    if (isLockedDbError(err)) {
      const hint =
        'The SQLite index is locked by another process.\n' +
        'A running `lazybrain serve` or daemon may be holding a write lock.\n' +
        'Stop it first:  lazybrain serve --stop\n' +
        '                lazybrain daemon stop\n' +
        'Then retry:     lazybrain index-update';
      throw new Error(hint);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function idFromPath(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const id = base.replace(/\.html$/, '');
  return id || null;
}
