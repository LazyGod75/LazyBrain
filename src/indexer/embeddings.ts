import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, pipeline } from '@xenova/transformers';
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';

const MODEL_ID = 'Xenova/bge-base-en-v1.5';
const DIM = 768; // bge-base output dimension

let pipe: FeatureExtractionPipeline | null = null;
let cache: Map<string, Float32Array> | null = null;
let cachePath: string | null = null;
/** Set to true after the first load failure so the warning is logged only once. */
let embedderUnavailable = false;

env.allowLocalModels = true;
env.allowRemoteModels = true;

/**
 * Load the feature-extraction pipeline.
 *
 * Returns `null` (instead of throwing) when the ONNX models are absent or
 * fail to load — callers must handle the null case and degrade gracefully
 * (e.g. fall back to FTS/L2 search).  The warning is logged only once to
 * avoid flooding the log on every query.
 */
export async function getEmbedder(): Promise<FeatureExtractionPipeline | null> {
  if (pipe) return pipe;
  if (embedderUnavailable) return null;
  const cfg = getConfig();
  env.localModelPath = cfg.modelsPath;
  env.cacheDir = cfg.modelsPath;
  try {
    pipe = (await pipeline('feature-extraction', MODEL_ID, {
      quantized: true,
    })) as FeatureExtractionPipeline;
    return pipe;
  } catch (err) {
    embedderUnavailable = true;
    getLogger().warn(
      { err: (err as Error).message, modelsPath: cfg.modelsPath },
      'lazybrain: ONNX embedding model unavailable — L3/L4 search will fall back to FTS (L2). ' +
        'Run `npm run download-models` to enable semantic search.',
    );
    return null;
  }
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const log = getLogger();
  const cacheMap = loadCache();
  const start = Date.now();
  const result: Float32Array[] = new Array(texts.length);
  const todo: { idx: number; text: string; key: string }[] = [];

  let hits = 0;
  for (let i = 0; i < texts.length; i++) {
    const key = hashKey(texts[i]);
    const cached = cacheMap.get(key);
    if (cached) {
      result[i] = cached;
      hits += 1;
    } else {
      todo.push({ idx: i, text: texts[i], key });
    }
  }

  if (todo.length > 0) {
    const embedder = await getEmbedder();
    if (!embedder) {
      // Model unavailable: fill missing slots with zero vectors so callers that
      // rely on embed() for optional features (e.g. MMR diversity) degrade
      // gracefully rather than crashing.
      for (const { idx } of todo) {
        result[idx] = new Float32Array(DIM);
      }
    } else {
      for (const { idx, text, key } of todo) {
        const tensor = await embedder(text, { pooling: 'mean', normalize: true });
        const arr = new Float32Array(tensor.data as Float32Array);
        result[idx] = arr;
        cacheMap.set(key, arr);
      }
      saveCache(cacheMap);
    }
  }

  const duration = Date.now() - start;
  log.debug({ texts: texts.length, todo: todo.length, hits, duration_ms: duration }, 'embed batch');
  logTelemetry({
    event: 'embed',
    ts: nowIso(),
    texts: texts.length,
    duration_ms: duration,
    cache_hit: hits,
    cache_miss: todo.length,
  });
  return result;
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embed([text]);
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Vectors are already L2-normalized → dot product = cosine
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export interface VectorHit {
  id: string;
  score: number; // cosine similarity in [-1, 1]
}

export function topKCosine(
  query: Float32Array,
  corpus: { id: string; vector: Float32Array }[],
  k: number,
): VectorHit[] {
  const heap: VectorHit[] = [];
  for (const { id, vector } of corpus) {
    const score = cosine(query, vector);
    if (heap.length < k) {
      heap.push({ id, score });
      heap.sort((a, b) => a.score - b.score);
    } else if (score > heap[0].score) {
      heap[0] = { id, score };
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.reverse();
}

export function hashKey(text: string): string {
  // FNV-1a 32-bit, fast and stable
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function loadCache(): Map<string, Float32Array> {
  if (cache) return cache;
  const cfg = getConfig();
  cachePath = join(cfg.cachePath, 'embeddings.bin');
  cache = new Map();
  if (existsSync(cachePath)) {
    try {
      const buf = readFileSync(cachePath);
      // Format: [u32 count] [for each: u8 keyLen, keyBytes, DIM * f32 LE]
      let offset = 0;
      const count = buf.readUInt32LE(offset);
      offset += 4;
      for (let i = 0; i < count; i++) {
        const keyLen = buf.readUInt8(offset);
        offset += 1;
        const key = buf.subarray(offset, offset + keyLen).toString('utf8');
        offset += keyLen;
        const vec = new Float32Array(DIM);
        for (let j = 0; j < DIM; j++) {
          vec[j] = buf.readFloatLE(offset);
          offset += 4;
        }
        cache.set(key, vec);
      }
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, 'corrupt embedding cache, ignoring');
      cache = new Map();
    }
  }
  return cache;
}

function saveCache(map: Map<string, Float32Array>): void {
  if (!cachePath) return;
  // Estimate size
  let size = 4; // count u32
  for (const [k] of map) size += 1 + Buffer.byteLength(k, 'utf8') + DIM * 4;
  const buf = Buffer.alloc(size);
  let offset = 0;
  buf.writeUInt32LE(map.size, offset);
  offset += 4;
  for (const [key, vec] of map) {
    const keyBytes = Buffer.from(key, 'utf8');
    buf.writeUInt8(keyBytes.length, offset);
    offset += 1;
    keyBytes.copy(buf, offset);
    offset += keyBytes.length;
    for (let j = 0; j < DIM; j++) {
      buf.writeFloatLE(vec[j] ?? 0, offset);
      offset += 4;
    }
  }
  writeFileSync(cachePath, buf);
}

export function resetEmbedderForTests(): void {
  pipe = null;
  cache = null;
  cachePath = null;
  embedderUnavailable = false;
}

/**
 * Returns true when the embedding model has already failed to load.
 * Callers can use this to skip the L3 path without triggering another
 * load attempt (which would also fail and produce the warning again).
 */
export function isEmbedderUnavailable(): boolean {
  return embedderUnavailable;
}

/** Force the "model unavailable" state for unit tests that exercise L3→L2 fallback. */
export function forceEmbedderUnavailableForTests(): void {
  pipe = null;
  embedderUnavailable = true;
}
