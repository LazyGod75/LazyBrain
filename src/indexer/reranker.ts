import { env, pipeline } from '@xenova/transformers';
import { getConfig } from '../util/config.js';

const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

type CrossEncoderPipeline = (
  inputs: { text: string; text_pair: string }[],
  opts?: { top_k?: number },
) => Promise<{ label: string; score: number }[]>;

let pipe: CrossEncoderPipeline | null = null;

export async function getReranker(): Promise<CrossEncoderPipeline> {
  if (pipe) return pipe;
  const cfg = getConfig();
  env.localModelPath = cfg.modelsPath;
  env.cacheDir = cfg.modelsPath;
  // text-classification with no pooling = cross-encoder relevance score
  pipe = (await pipeline('text-classification', MODEL_ID, {
    quantized: true,
  })) as unknown as CrossEncoderPipeline;
  return pipe;
}

export interface RerankInput {
  id: string;
  text: string;
}

export interface RerankHit {
  id: string;
  score: number;
}

/**
 * Cross-encoder re-rank: takes top-N from cheap retrieval, returns top-K by relevance.
 * 30-50ms per pair on CPU with quantized ONNX, batched.
 */
export async function rerank(
  query: string,
  candidates: RerankInput[],
  topK: number,
): Promise<RerankHit[]> {
  if (candidates.length === 0) return [];
  // Maximum-paranoia coercion: the @xenova/transformers tokenizer throws cryptic
  // "text.split is not a function" errors when ANY pair has a non-string value.
  const safeQuery = typeof query === 'string' && query.length > 0 ? query : ' ';
  const filtered = candidates
    .filter((c) => typeof c.text === 'string' && c.text.length > 0)
    .map((c) => ({ id: c.id, text: String(c.text) }));
  if (filtered.length === 0) return [];
  const reranker = await getReranker();
  const pairs = filtered.map((c) => ({ text: safeQuery, text_pair: c.text }));
  let scores: { label: string; score: number }[];
  try {
    scores = await reranker(pairs, { top_k: 1 });
  } catch (_err) {
    // Fall back to identity ranking — better to return BM25 hits than fail.
    return filtered.slice(0, topK).map((c, i) => ({ id: c.id, score: 1 - i / filtered.length }));
  }
  const out: RerankHit[] = filtered.map((c, i) => ({
    id: c.id,
    score: scores[i]?.score ?? 0,
  }));
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}

export function resetRerankerForTests(): void {
  pipe = null;
}
