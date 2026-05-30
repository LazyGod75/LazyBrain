import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAll } from '../indexer/fts.js';
import { scrubForPublic } from '../schema/scrubber.js';
import { batchesDir, brainRoot, notesDir } from '../store/paths.js';
import { readAllNotes } from '../store/reader.js';

export interface PublishCliOptions {
  outDir?: string;
  dryRun?: boolean;
  confirm?: boolean;
  excludeTier?: 'archival' | 'working';
  pretty?: boolean;
}

/**
 * Publish a scrubbed copy of the brain into a public/ folder ready for GitHub Pages.
 * NEVER pushes anything — that's left to the user.
 * Refuses if any note triggers the secret scanner.
 */
export function runPublish(opts: PublishCliOptions): string {
  const target = opts.outDir ?? join(brainRoot(), '..', 'public');
  const notes = readAllNotes();
  const allIndex = listAll({ includeExpired: false });

  const failures: { id: string; reason: string }[] = [];
  const accepted: { id: string; path: string; cleaned: string; warnings: string[] }[] = [];

  for (const note of notes) {
    const indexEntry = allIndex.find((n) => n.id === note.id);
    if (
      opts.excludeTier &&
      indexEntry?.path.includes(opts.excludeTier === 'archival' ? 'batches' : 'notes')
    ) {
      continue;
    }
    const result = scrubForPublic(note.html);
    if (result.blockedReason) {
      failures.push({ id: note.id, reason: result.blockedReason });
      continue;
    }
    accepted.push({
      id: note.id,
      path: note.path,
      cleaned: result.cleaned,
      warnings: result.warnings,
    });
  }

  if (failures.length > 0) {
    return JSON.stringify({
      status: 'blocked',
      message: `${failures.length} note(s) blocked. Fix or pass --exclude flags.`,
      failures,
    });
  }

  if (opts.dryRun || !opts.confirm) {
    return JSON.stringify({
      status: 'dry-run',
      out_dir: target,
      would_publish: accepted.length,
      warnings_total: accepted.reduce((s, a) => s + a.warnings.length, 0),
      preview: accepted.slice(0, 3).map((a) => ({ id: a.id, warnings: a.warnings })),
    });
  }

  // Real publish
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const indexEntries: string[] = [];
  for (const a of accepted) {
    const relPath = a.path.startsWith(notesDir())
      ? a.path.slice(notesDir().length + 1)
      : a.path.startsWith(batchesDir())
        ? join('batches', a.path.slice(batchesDir().length + 1))
        : `${a.id}.html`;
    const outFile = join(target, relPath);
    mkdirSync(join(outFile, '..'), { recursive: true });
    writeFileSync(outFile, wrapPage(a.id, a.cleaned), 'utf8');
    indexEntries.push(`  <li><a href="${relPath.replace(/\\/g, '/')}">${a.id}</a></li>`);
  }

  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Brain — public index</title>
  <meta name="generator" content="LazyBrain">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self';">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Brain — index</h1>
  <ul>
${indexEntries.join('\n')}
  </ul>
</body>
</html>`;
  writeFileSync(join(target, 'index.html'), indexHtml, 'utf8');
  writeFileSync(join(target, 'style.css'), defaultCss(), 'utf8');

  return opts.pretty
    ? `Published ${accepted.length} notes to ${target}`
    : JSON.stringify({ status: 'ok', out_dir: target, published: accepted.length });
}

function wrapPage(id: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${id}</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self';">
  <link rel="stylesheet" href="../style.css">
</head>
<body>
${body}
</body>
</html>`;
}

function defaultCss(): string {
  return `body { max-width: 760px; margin: 2em auto; padding: 0 1em; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #222; background: #fafafa; }
h1, h2, h3 { line-height: 1.2; }
a { color: #036; }
[data-cerveau-fact] { padding-left: 1em; border-left: 3px solid #ccc; }
[data-cerveau-fact][data-cerveau-confidence="1.00"] { border-color: #2a2; }
memory-batch { display: block; background: #fff; border: 1px solid #ddd; padding: 1em; }
`;
}
