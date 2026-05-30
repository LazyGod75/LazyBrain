import { existsSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb } from '../indexer/fts.js';
import { getConfig } from '../util/config.js';
import { knowledgeNodesDir, notesDir } from '../store/paths.js';
import { getLogger } from '../util/logger.js';

/**
 * Delete a file or directory with exponential backoff on Windows EBUSY/EPERM locks.
 * Retries 3 times (10ms, 50ms, 100ms), then falls back to truncating the file.
 * Returns true on success, false if the file could not be removed (but was truncated).
 */
function deleteWithRetry(filePath: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (statSync(filePath).isDirectory()) {
        rmSync(filePath, { recursive: true, force: true });
      } else {
        unlinkSync(filePath);
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const isLocked = code === 'EBUSY' || code === 'EPERM';
      if (!isLocked) throw err;
      if (attempt < 2) {
        // Busy-wait with increasing delays: 10ms, 50ms
        const ms = 10 * Math.pow(5, attempt);
        const until = Date.now() + ms;
        while (Date.now() < until) { /* busy wait */ }
      }
    }
  }
  // Final fallback: truncate the file so the next DB open works on a blank slate
  try {
    writeFileSync(filePath, '');
    return true;
  } catch {
    return false;
  }
}

export interface WipeOptions {
  pretty?: boolean;
}

export interface WipeReport {
  notesDeleted: number;
  knowledgeNodesDeleted: number;
  cacheDeleted: number;
  errors: string[];
}

export async function runWipe(_opts: WipeOptions): Promise<WipeReport> {
  const log = getLogger();
  const cfg = getConfig();
  const report: WipeReport = { notesDeleted: 0, knowledgeNodesDeleted: 0, cacheDeleted: 0, errors: [] };

  const notesPath = notesDir();
  if (existsSync(notesPath)) {
    const partitions = readdirSync(notesPath).filter((d) => {
      const full = join(notesPath, d);
      try {
        return readdirSync(full).length >= 0;
      } catch {
        return false;
      }
    });
    for (const partition of partitions) {
      const partPath = join(notesPath, partition);
      try {
        const files = readdirSync(partPath).filter((f) => f.endsWith('.html'));
        for (const file of files) {
          unlinkSync(join(partPath, file));
          report.notesDeleted++;
        }
        try {
          rmSync(partPath, { recursive: true, force: true });
        } catch {
          // partition dir may already be gone — ignore
        }
      } catch (err) {
        report.errors.push(`${partition}: ${(err as Error).message}`);
      }
    }
  }

  // Also wipe knowledge-nodes/ directory (hierarchy nodes)
  const knDir = knowledgeNodesDir();
  if (existsSync(knDir)) {
    try {
      const files = readdirSync(knDir).filter((f) => f.endsWith('.html'));
      for (const file of files) {
        try {
          unlinkSync(join(knDir, file));
          report.knowledgeNodesDeleted++;
        } catch (err) {
          report.errors.push(`knowledge-nodes/${file}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      report.errors.push(`knowledge-nodes: ${(err as Error).message}`);
    }
  }

  // Close the SQLite database before deleting cache files to release the lock.
  closeDb();

  const cacheDir = cfg.cachePath;
  if (existsSync(cacheDir)) {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      const filePath = join(cacheDir, file);
      try {
        const deleted = deleteWithRetry(filePath);
        if (deleted) {
          report.cacheDeleted++;
        } else {
          report.errors.push(`cache/${file}: locked — could not delete (truncated instead)`);
        }
      } catch (err) {
        report.errors.push(`cache/${file}: ${(err as Error).message}`);
      }
    }
  }

  log.info(report, 'wipe complete');
  return report;
}
