/**
 * Pre-download WASM ONNX models so the first run isn't slow.
 *
 * Models:
 *   - Xenova/bge-base-en-v1.5  (~440 MB quantized, embeddings)
 *   - Xenova/ms-marco-MiniLM-L-6-v2  (~90 MB quantized, cross-encoder)
 */
import { pipeline, env } from '@xenova/transformers';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const modelsPath = process.env.LAZYBRAIN_MODELS_PATH ?? join(homedir(), '.lazybrain', 'models');
if (!existsSync(modelsPath)) mkdirSync(modelsPath, { recursive: true });

env.cacheDir = modelsPath;
env.localModelPath = modelsPath;

async function main(): Promise<void> {
  console.log(`Downloading models into: ${modelsPath}`);
  console.log('1/2 — bge-base-en-v1.5 (~440 MB, embeddings)');
  await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { quantized: true });
  console.log('2/2 — ms-marco-MiniLM-L-6-v2 (~90 MB, cross-encoder)');
  await pipeline('text-classification', 'Xenova/ms-marco-MiniLM-L-6-v2', { quantized: true });
  console.log('Done.');
}

main().catch((err) => {
  console.error('Model download failed:', err);
  process.exit(1);
});
