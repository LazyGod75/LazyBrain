import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface LazyBrainConfig {
  brainPath: string;
  cachePath: string;
  modelsPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  telemetry: boolean;
}

let cached: LazyBrainConfig | null = null;

/**
 * Brain path discovery — checked in priority order:
 *
 * 1. LAZYBRAIN_BRAIN_PATH env var (highest priority)
 * 2. --brain <path> CLI flag  → passed via process.env.LAZYBRAIN_BRAIN_PATH_CLI
 *    (set by bin/lazybrain.ts before getConfig() is called)
 * 3. Walk up from cwd() looking for a .lazybrain/ directory
 * 4. Scan ~/Documents/ for a Lazy-Brain* folder containing brain/notes/
 * 5. Fall back to ~/.lazybrain/brain/ (created if it does not exist)
 */
function discoverBrainPath(): string {
  // 1. Explicit env var
  if (process.env.LAZYBRAIN_BRAIN_PATH) {
    return process.env.LAZYBRAIN_BRAIN_PATH;
  }

  // 2. --brain CLI flag forwarded through env
  if (process.env.LAZYBRAIN_BRAIN_PATH_CLI) {
    return process.env.LAZYBRAIN_BRAIN_PATH_CLI;
  }

  // 3. Walk up from cwd looking for .lazybrain/
  const lazybrainDir = walkUpForDotDir(process.cwd(), '.lazybrain');
  if (lazybrainDir !== null) {
    return join(lazybrainDir, 'brain');
  }

  // 4. ~/Documents/Lazy-Brain*/ containing brain/notes/
  const docsMatch = findInDocuments();
  if (docsMatch !== null) {
    return docsMatch;
  }

  // 5. Fallback: ~/.lazybrain/brain/
  return join(homedir(), '.lazybrain', 'brain');
}

/**
 * Walk up from startDir toward filesystem root, looking for a directory
 * named dotDirName. Returns the absolute path of the dotDirName directory
 * if found, or null if the root is reached without a match.
 */
function walkUpForDotDir(startDir: string, dotDirName: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, dotDirName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}

/**
 * Scan ~/Documents/ for a directory starting with "Lazy-Brain" that
 * contains a brain/notes/ subdirectory. Returns the brain/ path or null.
 */
function findInDocuments(): string | null {
  const docs = join(homedir(), 'Documents');
  if (!existsSync(docs)) return null;
  try {
    const match = readdirSync(docs).find(
      (d) => d.startsWith('Lazy-Brain') && existsSync(join(docs, d, 'brain', 'notes')),
    );
    return match ? join(docs, match, 'brain') : null;
  } catch {
    return null;
  }
}

export function getConfig(): LazyBrainConfig {
  if (cached) return cached;

  const brainPath = discoverBrainPath();
  const resolvedBrain = resolve(brainPath);

  if (!existsSync(resolvedBrain)) {
    // Fallback path may not exist yet — create it rather than throwing
    const isFallback =
      resolvedBrain === resolve(join(homedir(), '.lazybrain', 'brain')) ||
      process.env.LAZYBRAIN_BRAIN_PATH !== undefined ||
      process.env.LAZYBRAIN_BRAIN_PATH_CLI !== undefined;

    if (!isFallback) {
      throw new Error(`Brain path does not exist: ${resolvedBrain}`);
    }
    mkdirSync(resolvedBrain, { recursive: true });
  }

  const cachePath = process.env.LAZYBRAIN_CACHE_PATH
    ? resolve(process.env.LAZYBRAIN_CACHE_PATH)
    : resolve(dirname(resolvedBrain), '_cache');

  const modelsPath = process.env.LAZYBRAIN_MODELS_PATH
    ? resolve(process.env.LAZYBRAIN_MODELS_PATH)
    : join(homedir(), '.lazybrain', 'models');

  if (!existsSync(cachePath)) mkdirSync(cachePath, { recursive: true });
  if (!existsSync(modelsPath)) mkdirSync(modelsPath, { recursive: true });

  const logLevel = (process.env.LAZYBRAIN_LOG_LEVEL ?? 'info') as LazyBrainConfig['logLevel'];
  const telemetry = process.env.LAZYBRAIN_TELEMETRY !== '0';

  cached = { brainPath: resolvedBrain, cachePath, modelsPath, logLevel, telemetry };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
