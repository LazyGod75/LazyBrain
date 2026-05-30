import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { batchesDir, knowledgeNodesDir, notesDir } from './paths.js';

export interface NoteFile {
  path: string;
  id: string;
  html: string;
  sizeBytes: number;
  mtimeMs: number;
}

export function readAllNotes(): NoteFile[] {
  return [...readDir(notesDir()), ...readDir(batchesDir())];
}

export function readAllWithKnowledgeNodes(): NoteFile[] {
  return [...readDir(notesDir()), ...readDir(batchesDir()), ...readDir(knowledgeNodesDir())];
}

export function readAllKnowledgeNodes(): NoteFile[] {
  return readDir(knowledgeNodesDir());
}

export function readNote(path: string): NoteFile {
  const html = readFileSync(path, 'utf8');
  const stats = statSync(path);
  return {
    path,
    id: idFromHtml(html) ?? '',
    html,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function readDir(root: string): NoteFile[] {
  const out: NoteFile[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // directory may not exist yet
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...readDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(readNote(full));
    }
  }
  return out;
}

function idFromHtml(html: string): string | null {
  const m = html.match(/<article\b[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  return m?.[1] ?? null;
}
