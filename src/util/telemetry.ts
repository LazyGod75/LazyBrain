import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';

export type TelemetryEvent =
  | {
      event: 'capture';
      ts: string;
      session?: string;
      tool?: string;
      tokens_in?: number;
      tokens_out_html?: number;
      strip_ratio?: number;
      duration_ms?: number;
    }
  | { event: 'capture_skipped'; ts: string; session?: string; reason: string; tokens_in?: number }
  | { event: 'cache_hit'; ts: string; endpoint: string; key_hash: string }
  | {
      event: 'query';
      ts: string;
      level: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4' | 'L5';
      latency_ms: number;
      results: number;
      query_hash?: string;
    }
  | { event: 'inject'; ts: string; tokens: number; sections: number; duration_ms: number }
  | { event: 'store'; ts: string; note_id: string; size_bytes: number; attrs_count: number }
  | {
      event: 'compress';
      ts: string;
      session?: string;
      in_count: number;
      out_size_bytes: number;
      compression_ratio: number;
      model?: string;
    }
  | { event: 'error'; ts: string; where: string; message: string }
  | {
      event: 'embed';
      ts: string;
      texts: number;
      duration_ms: number;
      cache_hit: number;
      cache_miss: number;
    }
  | { event: 'rerank_invalidation'; ts: string; penalized: number; boosted: number; hard: boolean };

export function logTelemetry(event: TelemetryEvent): void {
  const cfg = getConfig();
  if (!cfg.telemetry) return;
  try {
    const path = join(cfg.cachePath, 'telemetry.jsonl');
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Telemetry never throws
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
