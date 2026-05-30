import { readFileSync } from 'node:fs';
import { buildWikilinkContext, injectWikilinks } from '../annotator/wikilinks.js';
import { indexNote, listAll } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getLogger } from '../util/logger.js';

export interface StoreCliOptions {
  fromFile?: string;
  fromStdin?: boolean;
  html?: string;
  overwrite?: boolean;
  pretty?: boolean;
}

export async function runStore(opts: StoreCliOptions): Promise<string> {
  const log = getLogger();
  let html = opts.html;
  if (!html && opts.fromFile) {
    html = readFileSync(opts.fromFile, 'utf8');
  }
  if (!html) {
    html = await readStdin();
  }
  if (!html.trim()) {
    throw new Error('Empty HTML input');
  }

  // Inject wikilinks before writing: build context from existing indexed notes
  try {
    const indexedNotes = listAll({ includeExpired: false });
    if (indexedNotes.length > 0) {
      const ctx = buildWikilinkContext(
        indexedNotes.map((n) => ({
          id: n.id,
          concepts: n.concepts ?? null,
          entities: n.entities ?? null,
          tags: n.tags ?? '',
        })),
      );
      // Only inject if we have enough context (at least 2 other notes)
      if (ctx.knownNoteIds.size >= 2) {
        html = injectWikilinks(html, ctx);
        log.debug({ noteCount: ctx.knownNoteIds.size }, 'wikilinks injected during store');
      }
    }
  } catch (err) {
    // Best-effort: log but don't fail note creation
    log.warn(
      { err: (err as Error).message },
      'wikilinks injection failed, continuing without it',
    );
  }

  const result = writeNote(html, { overwrite: opts.overwrite });
  // Index immediately for read-after-write consistency
  const note = readNote(result.path);
  indexNote(note);

  if (opts.pretty) {
    return `Stored: ${result.id}\n  path: ${result.path}\n  size: ${result.sizeBytes}B\n  attrs: ${result.attrsCount}`;
  }
  return JSON.stringify(result, null, 2);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve(decodeBufferAsUtf8(raw));
    });
  });
}

/**
 * Decode a buffer as UTF-8, with fallback handling for UTF-16 LE/BE BOMs.
 * PowerShell 5.1 on Windows defaults to UTF-16 LE when piping strings,
 * which mangles non-ASCII characters (e.g. French accents) if read as UTF-8.
 */
function decodeBufferAsUtf8(buf: Buffer): string {
  // UTF-16 LE BOM: FF FE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  // UTF-16 BE BOM: FE FF
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node has no built-in UTF-16 BE decoder; swap bytes then decode as LE
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length - 1; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  // UTF-8 BOM: EF BB BF — strip BOM then decode normally
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  // Default: assume UTF-8
  return buf.toString('utf8');
}
