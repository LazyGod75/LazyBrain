/**
 * Q3 — Differential injection.
 *
 * Tracks, per Claude Code session, the note ids already injected via
 * UserPromptSubmit. The next turn's inject excludes them so we don't pay for
 * the same fact twice in the same conversation. Memory-only (daemon process),
 * LRU-bounded by session count, and each session entry expires after an idle
 * window so abandoned sessions don't leak.
 *
 * The trade-off: skipping previously-injected notes risks Claude forgetting
 * mid-session. Mitigations:
 *   - Re-injection happens automatically at SessionStart (different code path)
 *   - User can clear with `lazybrain session-cache clear`
 *   - Idle eviction caps the lifetime
 */

interface SessionEntry {
  injected: Set<string>;
  lastSeenMs: number;
}

const MAX_SESSIONS = 32;
const IDLE_TTL_MS = 6 * 3_600_000; // 6 hours

const sessions: Map<string, SessionEntry> = new Map();

function evictIdle(nowMs: number): void {
  if (sessions.size === 0) return;
  for (const [id, entry] of sessions) {
    if (nowMs - entry.lastSeenMs > IDLE_TTL_MS) sessions.delete(id);
  }
  // LRU cap — drop oldest first.
  if (sessions.size > MAX_SESSIONS) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
    const overflow = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < overflow; i++) sessions.delete(sorted[i][0]);
  }
}

export function alreadyInjected(sessionId: string | undefined): Set<string> {
  if (!sessionId) return new Set();
  return sessions.get(sessionId)?.injected ?? new Set();
}

export function recordInjected(sessionId: string | undefined, ids: readonly string[]): void {
  if (!sessionId || ids.length === 0) return;
  const now = Date.now();
  evictIdle(now);
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { injected: new Set(), lastSeenMs: now };
    sessions.set(sessionId, entry);
  }
  for (const id of ids) entry.injected.add(id);
  entry.lastSeenMs = now;
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export function sessionCacheStats(): { sessions: number; totalInjected: number } {
  let totalInjected = 0;
  for (const entry of sessions.values()) totalInjected += entry.injected.size;
  return { sessions: sessions.size, totalInjected };
}
