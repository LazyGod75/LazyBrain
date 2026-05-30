import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lazybrain-init-test-'));
}

describe('runInit', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the full directory structure in a temp dir', async () => {
    const report = await runInit({ path: tmpDir });

    const base = join(tmpDir, '.lazybrain');
    expect(report.brainPath).toBe(join(base, 'brain'));
    expect(report.notes).toBe(join(base, 'brain', 'notes'));
    expect(report.cache).toBe(join(base, 'brain', '_cache'));
    expect(report.knowledgeNodes).toBe(join(base, 'brain', 'knowledge-nodes'));
    expect(report.configWritten).toBe(true);
    expect(report.created).toBe(true);

    expect(existsSync(join(base, 'brain', 'notes'))).toBe(true);
    expect(existsSync(join(base, 'brain', 'knowledge-nodes'))).toBe(true);
    expect(existsSync(join(base, 'brain', '_cache'))).toBe(true);
    expect(existsSync(join(base, 'brain', 'meta'))).toBe(true);
    expect(existsSync(join(base, '.lazybrain-config.json'))).toBe(true);
  });

  it('config file is valid JSON with version and createdAt', async () => {
    await runInit({ path: tmpDir });

    const configPath = join(tmpDir, '.lazybrain', '.lazybrain-config.json');
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as { version: string; createdAt: string };

    expect(config.version).toBe('1.0.0');
    expect(typeof config.createdAt).toBe('string');
    expect(() => new Date(config.createdAt)).not.toThrow();
  });

  it('throws when already initialized and --force is not set', async () => {
    // First init
    await runInit({ path: tmpDir });

    // Second init without --force must throw
    await expect(runInit({ path: tmpDir })).rejects.toThrow(
      'LazyBrain already initialized',
    );
  });

  it('succeeds when already initialized and --force is set', async () => {
    // First init
    await runInit({ path: tmpDir });

    // Second init with --force must not throw
    const report = await runInit({ path: tmpDir, force: true });

    expect(report.configWritten).toBe(true);
    // created is false because the directory already existed
    expect(report.created).toBe(false);
  });
});
