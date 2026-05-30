import { join } from 'node:path';
import { getConfig } from '../util/config.js';

export function brainRoot(): string {
  return getConfig().brainPath;
}

export function notesDir(): string {
  return join(brainRoot(), 'notes');
}

export function batchesDir(): string {
  return join(brainRoot(), 'batches');
}

export function knowledgeNodesDir(): string {
  return join(brainRoot(), 'knowledge-nodes');
}

export function metaDir(): string {
  return join(brainRoot(), 'meta');
}

export function indexPath(): string {
  return join(getConfig().cachePath, 'fts.sqlite');
}

/**
 * Build canonical filesystem path for a note ID.
 * Notes are organized by YYYY-MM partition for git-friendly small folders.
 */
export function notePath(id: string, createdISO?: string): string {
  const date = createdISO ? new Date(createdISO) : new Date();
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  return join(notesDir(), `${yyyy}-${mm}`, `${slug(id)}.html`);
}

/**
 * Build filesystem path for a synthesized knowledge-node.
 * Knowledge-nodes live in their own directory to avoid collisions with source notes.
 */
export function knowledgeNodePath(nodeId: string): string {
  return join(knowledgeNodesDir(), `${slug(nodeId)}.html`);
}

export function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
