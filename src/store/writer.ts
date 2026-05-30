import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateNote } from '../schema/validator.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { notePath, slug } from './paths.js';

export interface WriteOptions {
  overwrite?: boolean;
}

export interface WriteResult {
  id: string;
  path: string;
  sizeBytes: number;
  attrsCount: number;
}

/**
 * Persist a note. The note HTML is validated against the cerveau schema.
 * Throws if validation fails (exit code 4 from CLI).
 */
export function writeNote(html: string, opts: WriteOptions = {}): WriteResult {
  const validation = validateNote(html);
  if (!validation.ok) {
    const msgs = validation.issues
      .filter((i) => i.level === 'error')
      .map((i) => `[${i.code}] ${i.message}`)
      .join('\n');
    throw new SchemaError(`Schema validation failed:\n${msgs}`);
  }

  // Extract id + created from HTML
  const idMatch = html.match(/<(?:article|section)\b[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  if (!idMatch) throw new SchemaError('Note has no id attribute on root element.');
  const id = slug(idMatch[1]);

  const createdMatch = html.match(/data-cerveau-created\s*=\s*["']([^"']+)["']/i);
  const created = createdMatch?.[1];

  const target = notePath(id, created);
  if (existsSync(target) && !opts.overwrite) {
    throw new ConflictError(`Note already exists: ${target}. Pass overwrite to replace.`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html, 'utf8');

  const sizeBytes = Buffer.byteLength(html, 'utf8');
  logTelemetry({
    event: 'store',
    ts: nowIso(),
    note_id: id,
    size_bytes: sizeBytes,
    attrs_count: validation.attrsCount,
  });

  return { id, path: target, sizeBytes, attrsCount: validation.attrsCount };
}

export class SchemaError extends Error {
  override name = 'SchemaError';
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}
