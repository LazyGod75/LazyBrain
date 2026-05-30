import chokidar, { type FSWatcher } from 'chokidar';
import { batchesDir, notesDir } from '../store/paths.js';
import { readNote } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import { deleteNote, indexNote } from './fts.js';

export function startWatcher(): FSWatcher {
  const log = getLogger();
  const watcher = chokidar.watch([notesDir(), batchesDir()], {
    ignored: /(^|[\\/\\\\])\../,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('add', (path) => onChange(path, 'add', log));
  watcher.on('change', (path) => onChange(path, 'change', log));
  watcher.on('unlink', (path) => onUnlink(path, log));

  return watcher;
}

function onChange(path: string, kind: string, log: ReturnType<typeof getLogger>): void {
  if (!path.endsWith('.html')) return;
  try {
    const note = readNote(path);
    if (!note.id) {
      log.warn({ path }, 'note has no id, skipped');
      return;
    }
    indexNote(note);
    log.debug({ path, kind }, 'indexed');
  } catch (err) {
    log.error({ path, err: (err as Error).message }, 'index error');
  }
}

function onUnlink(path: string, log: ReturnType<typeof getLogger>): void {
  if (!path.endsWith('.html')) return;
  const id = idFromPath(path);
  if (id) {
    deleteNote(id);
    log.debug({ id, path }, 'unindexed');
  }
}

function idFromPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.html$/, '') || null;
}
