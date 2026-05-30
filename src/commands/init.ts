/**
 * init: zero-config bootstrap for a new LazyBrain user.
 * Creates .lazybrain/ in the current directory (or user-provided path),
 * initializes the brain directory structure, and writes a config file.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getLogger } from '../util/logger.js';

export interface InitOptions {
  path?: string;    // explicit path, defaults to ./.lazybrain/
  force?: boolean;  // overwrite if exists
  pretty?: boolean;
}

export interface InitReport {
  brainPath: string;
  created: boolean;
  notes: string;
  cache: string;
  knowledgeNodes: string;
  configWritten: boolean;
}

const CONFIG_FILENAME = '.lazybrain-config.json';

/**
 * Create a directory if it does not exist. Throws if mkdir fails.
 */
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

export async function runInit(opts: InitOptions): Promise<InitReport> {
  const log = getLogger();

  // Resolve base: .lazybrain/ inside the provided path (or cwd)
  const base = resolve(opts.path ?? process.cwd(), '.lazybrain');

  const brainPath = join(base, 'brain');
  const notesPath = join(brainPath, 'notes');
  const knowledgeNodesPath = join(brainPath, 'knowledge-nodes');
  const cachePath = join(brainPath, '_cache');
  const metaPath = join(brainPath, 'meta');
  const configPath = join(base, CONFIG_FILENAME);

  // Guard: refuse to overwrite an existing init unless --force
  const alreadyExists = existsSync(configPath);
  if (alreadyExists && !opts.force) {
    throw new Error(
      `LazyBrain already initialized at ${base}. Use --force to overwrite.`,
    );
  }

  // Create directory structure
  ensureDir(notesPath);
  ensureDir(knowledgeNodesPath);
  ensureDir(cachePath);
  ensureDir(metaPath);

  // Write config file
  const config = {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  log.info({ brainPath, force: !!opts.force }, 'lazybrain init complete');

  return {
    brainPath,
    created: !alreadyExists,
    notes: notesPath,
    cache: cachePath,
    knowledgeNodes: knowledgeNodesPath,
    configWritten: true,
  };
}
