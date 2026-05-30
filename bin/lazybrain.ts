import { Command } from 'commander';
import { runBuildClusters } from '../src/commands/build-clusters.js';
import { runBuildIndex } from '../src/commands/build-index.js';
import { runSynthesizeNodes } from '../src/commands/synthesize-nodes.js';
import { runCapture } from '../src/commands/capture.js';
import { runPrune } from '../src/commands/prune.js';
import { runCompress } from '../src/commands/compress.js';
import { runDaemonStatus, runDaemonStop, startDaemonForeground } from '../src/commands/daemon.js';
import { runDream } from '../src/commands/dream.js';
import { runExtract } from '../src/commands/extract.js';
import { runGraph } from '../src/commands/graph.js';
import { runIndexRebuild } from '../src/commands/index-rebuild.js';
import { runInjectContext } from '../src/commands/inject-context.js';
import { runInterlink } from '../src/commands/interlink.js';
import { runInvalidate } from '../src/commands/invalidate.js';
import { runLink } from '../src/commands/link.js';
import { runNeighbours } from '../src/commands/neighbours.js';
import { runProfileUpdate } from '../src/commands/profile-update.js';
import { runPublish } from '../src/commands/publish.js';
import { runQuery } from '../src/commands/query.js';
import { runSearch } from '../src/commands/search.js';
import { runServe, stopServe } from '../src/commands/serve.js';
import { runStats } from '../src/commands/stats.js';
import { runStore } from '../src/commands/store.js';

const program = new Command();
program
  .name('lazybrain')
  .description('HTML-first persistent memory for LLM agents.')
  .version('0.1.0')
  .option('--brain <path>', 'override brain path (sets LAZYBRAIN_BRAIN_PATH_CLI)', (p) => {
    process.env.LAZYBRAIN_BRAIN_PATH_CLI = p;
    return p;
  });

program
  .command('search <query>')
  .description('Adaptive retrieval (router L1-L4). Default mode is auto.')
  .option('-t, --top <n>', 'top K results', (v) => Number.parseInt(v, 10), 5)
  .option('-m, --mode <mode>', 'l1|l2|l3|l4|auto', 'auto')
  .option('--strip', 'output stripped text only (for LLM injection)')
  .option('--pretty', 'human-readable output')
  .option('--diversity <lambda>', 'MMR lambda [0..1]', Number.parseFloat)
  .option('--include-expired', 'include invalidated notes')
  .option('--type <type>', 'filter by data-cerveau-type')
  .option('--tag <tag>', 'filter by tag')
  .option('--cwd <path>', 'bias PageRank toward notes captured in this working directory')
  .option('--page-rank-weight <w>', 'blend factor for PageRank in [0..1]', Number.parseFloat)
  .action(async (query, opts) => {
    try {
      const out = await runSearch({ query, ...opts });
      process.stdout.write(`${out}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('query <selector>')
  .description('CSS selector query (L1, deterministic, < 5ms).')
  .option('-a, --attribute <name>', 'extract a specific attribute')
  .option('-l, --limit <n>', 'limit results', (v) => Number.parseInt(v, 10), 50)
  .option('--strip', 'output stripped text only')
  .option('--pretty', 'human-readable output')
  .action((selector, opts) => {
    try {
      process.stdout.write(`${runQuery({ selector, ...opts })}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('store')
  .description('Store a new HTML note. Reads from stdin or --from-file.')
  .option('--from-file <path>')
  .option('--from-stdin', 'read HTML from stdin (default)')
  .option('--overwrite')
  .option('--pretty')
  .action(async (opts) => {
    try {
      const out = await runStore(opts);
      process.stdout.write(`${out}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('link <fromId> <toId>')
  .description('Create a bidirectional link with optional type and strength.')
  .option('-t, --type <type>', 'refines|contradicts|generalizes|cites|replaces|follows-from')
  .option('-s, --strength <value>', 'link strength 0..1', Number.parseFloat)
  .option('--pretty')
  .action((fromId, toId, opts) => {
    try {
      process.stdout.write(`${runLink({ fromId, toId, ...opts })}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('invalidate <id>')
  .description('Mark a note as invalidated (sets data-cerveau-valid-until).')
  .option('--replaced-by <id>')
  .option('--reason <text>')
  .option('--pretty')
  .action((id, opts) => {
    try {
      process.stdout.write(`${runInvalidate({ id, ...opts })}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('capture')
  .description('Capture a session transcript into the brain.')
  .option('--from-file <path>')
  .option('--from-stdin')
  .option('--session <id>')
  .option('--cwd <path>')
  .option('--async', 'queue without processing (PostToolUse)')
  .option('--flush-sync', 'flush queued captures synchronously (PreCompact)')
  .option('--use-llm', 'use LLM augmentation when heuristic confidence is low')
  .option('--pretty')
  .action(async (opts) => {
    try {
      const out = await runCapture(opts);
      process.stdout.write(`${out}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('compress')
  .description('Consolidate working-tier notes into a <memory-batch>.')
  .option('--session <id>')
  .option(
    '--older-than-days <n>',
    'compress notes older than N days',
    (v) => Number.parseInt(v, 10),
    7,
  )
  .option('--dry-run')
  .option('--purge-noise', 'retroactively invalidate notes that fail the capture validator')
  .option(
    '--purge-source <prefix>',
    'hard-delete notes whose data-cerveau-source starts with prefix (e.g. "bench:locomo")',
  )
  .option('--pretty')
  .action((opts) => {
    try {
      process.stdout.write(`${runCompress(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('neighbours')
  .description('1-hop graph neighbours for a note id (supersession, triples, shared entities).')
  .argument('<id>', 'note id (with or without leading #)')
  .option('--pretty')
  .action((id, opts) => {
    try {
      process.stdout.write(`${runNeighbours({ id, ...opts })}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('extract')
  .description(
    'Batch LLM extraction (Haiku) for low-quality notes. Opt-in via LAZYBRAIN_EXTRACTOR=haiku.',
  )
  .option('--batch-size <n>', 'max notes per call', (v) => Number.parseInt(v, 10), 10)
  .option('--dry-run')
  .option('--pretty')
  .action(async (opts) => {
    try {
      const out = await runExtract(opts);
      process.stdout.write(`${out}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('inject-context')
  .description('Generate stripped context for SessionStart / UserPromptSubmit injection.')
  .option('--max-tokens <n>', 'token budget', (v) => Number.parseInt(v, 10), 3000)
  .option('--prefer-recent')
  .option('--prefer-important')
  .option('--mode <mode>', 'session | turn | marker | highlights', 'session')
  .option('--format <fmt>', 'full (default) or compact (headline+index)', 'full')
  .option('--query <q>', 'query (required when --mode=turn)')
  .option('--min-score <n>', 'relevance threshold for turn mode', (v) => Number.parseFloat(v))
  .option('--cwd <path>', 'working directory hint')
  .option('--pretty')
  .action(async (opts) => {
    try {
      const out = await runInjectContext(opts);
      process.stdout.write(`${out}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('index-rebuild')
  .description('Rebuild FTS5 index from the HTML files.')
  .option('--pretty')
  .action((opts) => {
    try {
      process.stdout.write(`${runIndexRebuild(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('publish')
  .description('Publish a scrubbed copy of the brain (dry-run by default).')
  .option('--out-dir <path>')
  .option('--dry-run')
  .option('--confirm', 'actually write the public/ folder')
  .option('--exclude-tier <tier>', 'archival|working')
  .option('--pretty')
  .action((opts) => {
    try {
      process.stdout.write(`${runPublish(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('stats')
  .description('Show live telemetry stats.')
  .option('--window-hours <n>', 'window size in hours', (v) => Number.parseInt(v, 10), 24)
  .option('--pretty')
  .action((opts) => {
    try {
      process.stdout.write(`${runStats(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('init [path]')
  .description('Bootstrap a new LazyBrain at the given path (or ./.lazybrain/)')
  .option('--force', 'Overwrite if already initialized')
  .option('--pretty', 'Human-readable output')
  .action(async (path: string | undefined, opts: { force?: boolean; pretty?: boolean }) => {
    try {
      const { runInit } = await import('../src/commands/init.js');
      const report = await runInit({ ...opts, path });
      if (opts.pretty) {
        console.log(`LazyBrain initialized at ${report.brainPath}`);
        console.log('Next steps:');
        console.log('  npx lazybrain dream --enrich');
        console.log('  npx lazybrain index-rebuild');
        console.log('  npx lazybrain graph --format both');
        console.log('  npx lazybrain build-hierarchy --force');
        console.log('  npx lazybrain enrich-hierarchy --force');
        console.log('  npx lazybrain serve');
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle(err);
    }
  });

program
  .command('wipe')
  .description('Delete all brain notes and cache for a clean slate')
  .option('--pretty', 'Pretty output')
  .action(async (opts: { pretty?: boolean }) => {
    try {
      const { runWipe } = await import('../src/commands/wipe.js');
      const report = await runWipe(opts);
      if (opts.pretty) {
        console.log(`Wiped: ${report.notesDeleted} notes, ${report.knowledgeNodesDeleted} hierarchy nodes, ${report.cacheDeleted} cache files`);
        if (report.errors.length > 0) console.log(`Errors: ${report.errors.join('; ')}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle(err);
    }
  });

program
  .command('profile-update')
  .description('Rebuild the auto-generated user profile note from recent activity.')
  .option(
    '--min-occurrences <n>',
    'min note count for a tag to be considered stable',
    (v) => Number.parseInt(v, 10),
    3,
  )
  .option('--force')
  .option('--pretty')
  .action((opts) => {
    try {
      process.stdout.write(`${runProfileUpdate(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('interlink')
  .description('Wikipedia layer: inject wikilinks + see-also into all notes (sleep-time job).')
  .option('--dry-run', 'preview changes without writing')
  .option('--limit <n>', 'max notes to process per run', (v) => Number.parseInt(v, 10), 200)
  .option('--pretty', 'human-readable output')
  .action(async (opts) => {
    try {
      const out = await runInterlink(opts);
      process.stdout.write(`${out}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('dream')
  .description(
    'Offline brain maintenance: read conversations, expand stubs, enrich with Haiku, detect contradictions.',
  )
  .option('--dry-run', 'preview what would be done without writing', false)
  .option(
    '--enrich',
    'use Haiku to generate better TLDRs and topics (uses your Claude subscription)',
    false,
  )
  .option(
    '--max-notes <n>',
    'max notes to process per enrichment phase',
    (v) => Number.parseInt(v, 10),
    200,
  )
  .option('--pretty', 'human-readable output with progress bars', false)
  .option('--synthesize', 'Only run the synthesize phase (generate wiki overview pages)')
  .option('--topic <name>', 'Synthesize only this topic')
  .option('--force', 'ignore fingerprints and reprocess all conversations', false)
  .action(async (opts) => {
    try {
      const report = await runDream({
        dryRun: opts.dryRun,
        enrich: opts.enrich,
        maxNotes: opts.maxNotes,
        pretty: opts.pretty,
        synthesizeOnly: !!opts.synthesize,
        topic: opts.topic,
        force: opts.force,
      });
      if (!opts.pretty) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      }
    } catch (err) {
      handle(err);
    }
  });

program
  .command('synthesize-nodes')
  .description('[RETIRED] Previously created knowledge-node HTML files from brain-graph.json. Use `graph` + `build-hierarchy` instead.')
  .option('--topic <prefix>', 'no-op (pipeline retired)')
  .option('--force', 'no-op (pipeline retired)')
  .option('--dry-run', 'preview without writing (dry-run still supported)')
  .option('--pretty', 'human-readable output')
  .action(async (opts) => {
    try {
      const report = await runSynthesizeNodes(opts);
      if (opts.pretty) {
        console.log('[RETIRED] synthesize-nodes: no files written. Use `lazybrain graph` + `lazybrain build-hierarchy` instead.');
        console.log(`Skipped ${report.skipped} graph nodes.`);
        if (report.errors.length) console.log(`Errors: ${report.errors.join(', ')}`);
      } else {
        console.log(JSON.stringify(report, null, 2));
      }
    } catch (err) {
      handle(err);
    }
  });

program
  .command('enrich')
  .description('Enrich canonical code-first neurons (file-neuron, concept-neuron) from conversation tool-traces')
  .option('--topic <name>', 'Only enrich neurons for this topic (no-op: enrichment is file-trace driven)')
  .option('--force', 'Re-enrich already populated neurons')
  .option('--pretty', 'Pretty output')
  .action(async (opts) => {
    try {
      const { runEnrich } = await import('../src/commands/enrich.js');
      const report = await runEnrich(opts);
      if (opts.pretty) {
        console.log(
          `File-neurons enriched: ${report.fileNeuronsEnriched ?? 0}, concept neurons created: ${report.conceptNeuronsCreated ?? 0}`,
        );
        if (report.errors.length > 0)
          console.log(`Errors: ${report.errors.slice(0, 5).join('; ')}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle(err);
    }
  });

program
  .command('graph')
  .description(
    'Build the brain graph: auto-link mentions, backlinks index, clusters, view HTML + text.',
  )
  .option('--skip-autolink')
  .option('--skip-clusters')
  .option('--skip-view')
  .option('--format <fmt>', 'html|text|both (default: both)', 'both')
  .option('--topic <name>', 'filter sub-graph generation to this topic')
  .option('--pretty')
  .action(async (opts) => {
    try {
      process.stdout.write(`${await runGraph(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('build-index')
  .description('Regenerate brain/_index.html (atlas, metadata, JSON-LD global graph).')
  .option('--pretty')
  .action(async (opts) => {
    try {
      const out = await runBuildIndex(opts);
      process.stdout.write(`${JSON.stringify(out, null, opts.pretty ? 2 : 0)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('build-clusters')
  .description('Generate brain/clusters/<slug>/_cluster.html for each cwd.')
  .option('--pretty')
  .action(async (opts) => {
    try {
      const out = await runBuildClusters(opts);
      process.stdout.write(`${JSON.stringify(out, null, opts.pretty ? 2 : 0)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('build-hierarchy')
  .description('Build hierarchical knowledge-nodes (root → projects → modules → features)')
  .option('--force', 'Overwrite existing nodes')
  .option('--pretty', 'Pretty output')
  .action(async (opts) => {
    try {
      const { runBuildHierarchy } = await import('../src/commands/build-hierarchy.js');
      const report = await runBuildHierarchy(opts);
      if (opts.pretty) {
        console.log(
          `Built hierarchy: 1 root + ${report.projectsCreated} projects + ${report.modulesCreated} modules + ${report.featuresCreated} features = ${report.totalCreated} nodes`,
        );
        if (report.errors.length > 0) console.log(`Errors: ${report.errors.slice(0, 5).join('; ')}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle(err);
    }
  });

program
  .command('enrich-hierarchy')
  .description('Aggregate conversation content into hierarchy knowledge-nodes')
  .option('--force', 'Re-enrich all nodes')
  .option('--topic <name>', 'Only enrich nodes under this topic')
  .option('--pretty', 'Pretty output')
  .action(async (opts) => {
    try {
      const { runEnrichHierarchy } = await import('../src/commands/enrich-hierarchy.js');
      const report = await runEnrichHierarchy(opts);
      if (opts.pretty) {
        console.log(
          `Enriched ${report.nodesEnriched} hierarchy nodes, ${report.sectionsPopulated} sections from ${report.conversationsScanned} convs`,
        );
        if (report.errors.length > 0) console.log(`Errors: ${report.errors.slice(0, 5).join('; ')}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle(err);
    }
  });

const daemon = program
  .command('daemon')
  .description('Long-running HTTP daemon for ultra-fast hook calls (claude-mem-style).');

daemon
  .command('start')
  .description('Start the daemon (foreground by default; auto-spawned from hooks).')
  .option('--foreground', 'block until shutdown (default for hook-spawned daemons)')
  .option('-p, --port <n>', 'port', (v) => Number.parseInt(v, 10), 37788)
  .option(
    '--idle-timeout-ms <ms>',
    'auto-shutdown after this many ms idle',
    (v) => Number.parseInt(v, 10),
    30 * 60 * 1000,
  )
  .action(async (opts) => {
    try {
      await startDaemonForeground(opts);
    } catch (err) {
      handle(err);
    }
  });

daemon
  .command('status')
  .description('Show daemon status (pid, port, alive).')
  .option('--pretty')
  .action((opts) => {
    try {
      process.stdout.write(`${runDaemonStatus(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon.')
  .option('--pretty')
  .action(async (opts) => {
    try {
      process.stdout.write(`${await runDaemonStop(opts)}\n`);
    } catch (err) {
      handle(err);
    }
  });

program
  .command('serve')
  .description('Local HTTP server for the brain (read-only). Use --stop to stop a running server.')
  .option('-p, --port <n>', 'port', (v) => Number.parseInt(v, 10), 4242)
  .option('--bind <host>', 'bind address', '127.0.0.1')
  .option('--token <token>', 'require Bearer auth')
  .option('--stop', 'stop a running lazybrain serve instance and exit')
  .action(async (opts: { port?: number; bind?: string; token?: string; stop?: boolean }) => {
    try {
      if (opts.stop) {
        const result = await stopServe();
        if (result === 'no-server') {
          process.stdout.write('lazybrain serve: no running server found (no serve.port file)\n');
        } else if (result === 'stopped') {
          process.stdout.write('lazybrain serve: server stopped\n');
        } else {
          process.stderr.write(`lazybrain serve --stop: ${result}\n`);
          process.exit(1);
        }
        return;
      }
      await runServe(opts);
    } catch (err) {
      handle(err);
    }
  });

// ---------------------------------------------------------------------------
// fingerprints command
// ---------------------------------------------------------------------------

const fingerprintsCmd = program
  .command('fingerprints')
  .description('Manage the fingerprint store used for incremental dream processing.');

fingerprintsCmd
  .command('stats')
  .description('Show fingerprint store statistics.')
  .option('--pretty', 'human-readable output')
  .action(async (opts: { pretty?: boolean }) => {
    try {
      const { loadFingerprints, getOrphanedFingerprints } = await import('../src/util/fingerprints.js');
      const { statSync, existsSync } = await import('node:fs');
      const store = loadFingerprints();
      const tracked = Object.keys(store.files).length;
      const orphaned = getOrphanedFingerprints(store).length;

      // Compute store file size
      let storeSize = 0;
      try {
        const { getConfig } = await import('../src/util/config.js');
        const { join } = await import('node:path');
        const { cachePath } = getConfig();
        const storePath = join(cachePath, '.fingerprints.json');
        if (existsSync(storePath)) {
          storeSize = statSync(storePath).size;
        }
      } catch {
        /* best-effort */
      }

      const sizeFmt = storeSize >= 1024
        ? `${(storeSize / 1024).toFixed(1)} KB`
        : `${storeSize} B`;

      if (opts.pretty) {
        const w = (s: string) => process.stdout.write(s);
        w('\n  Fingerprint Store\n');
        w('  ══════════════════════════════════\n');
        w(`  Tracked files:  ${tracked}\n`);
        w(`  Orphaned:       ${orphaned}\n`);
        w(`  Last updated:   ${store.generatedAt}\n`);
        w(`  Store size:     ${sizeFmt}\n`);
        w('  ══════════════════════════════════\n\n');
      } else {
        process.stdout.write(JSON.stringify({ tracked, orphaned, generatedAt: store.generatedAt, storeSizeBytes: storeSize }) + '\n');
      }
    } catch (err) {
      handle(err);
    }
  });

fingerprintsCmd
  .command('clean')
  .description('Remove orphaned fingerprints (for files that no longer exist).')
  .option('--pretty', 'human-readable output')
  .option('--dry-run', 'show what would be removed without writing')
  .action(async (opts: { pretty?: boolean; dryRun?: boolean }) => {
    try {
      const { loadFingerprints, saveFingerprints, getOrphanedFingerprints } = await import('../src/util/fingerprints.js');
      const store = loadFingerprints();
      const orphans = getOrphanedFingerprints(store);
      if (!opts.dryRun && orphans.length > 0) {
        const cleaned: typeof store = {
          ...store,
          files: Object.fromEntries(
            Object.entries(store.files).filter(([k]) => !orphans.includes(k)),
          ),
        };
        saveFingerprints(cleaned);
      }
      if (opts.pretty) {
        process.stdout.write(`  ${opts.dryRun ? '[dry-run] Would remove' : 'Removed'} ${orphans.length} orphaned fingerprints.\n`);
      } else {
        process.stdout.write(JSON.stringify({ removed: orphans.length, dryRun: !!opts.dryRun }) + '\n');
      }
    } catch (err) {
      handle(err);
    }
  });

// ---------------------------------------------------------------------------
// prune command
// ---------------------------------------------------------------------------

program
  .command('prune')
  .description(
    'Remove noise notes and backup directories from the brain. Dry-run by default — use --apply to actually delete.',
  )
  .option(
    '--policy <policies>',
    'comma-separated list of policies: claude-mem-observer,session-dream,empty-tldr,backup-dirs (default: all)',
  )
  .option('--dry-run', 'preview candidates without deleting (default)')
  .option('--apply', 'actually delete the matched files and directories')
  .option('--pretty', 'human-readable output')
  .action((opts: { policy?: string; dryRun?: boolean; apply?: boolean; pretty?: boolean }) => {
    try {
      // --apply is the explicit opt-in to delete; default is dry-run
      const dryRun = !opts.apply;

      const report = runPrune({
        policy: opts.policy,
        dryRun,
      });

      if (opts.pretty) {
        const w = (s: string) => process.stdout.write(s);
        w('\n');
        w('  Prune report\n');
        w('  ════════════════════════════════════════════\n');
        w(`  Mode:              ${report.dryRun ? 'dry-run (no files deleted)' : 'APPLY (files deleted)'}\n`);
        w(`  Policies:          ${report.policies.join(', ')}\n`);
        w('\n  Candidates by policy:\n');
        for (const policy of report.policies) {
          w(`    ${policy.padEnd(24)} ${report.counts[policy]}\n`);
        }
        w('\n');
        w(`  Total file candidates: ${report.totalFiles}\n`);
        w(`  Total dir candidates:  ${report.totalDirs}\n`);
        if (!report.dryRun) {
          w(`  Deleted:               ${report.deleted}\n`);
        }
        w('  ════════════════════════════════════════════\n');

        if (report.candidates.length > 0 && report.dryRun) {
          w('\n  Candidates (dry-run — nothing deleted):\n');
          for (const c of report.candidates.slice(0, 50)) {
            w(`    [${c.policy}] ${c.path}\n`);
            w(`      Reason: ${c.reason}\n`);
          }
          if (report.candidates.length > 50) {
            w(`    ... and ${report.candidates.length - 50} more\n`);
          }
          w('\n  Run with --apply to delete these files.\n');
        }
        w('\n');
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
    } catch (err) {
      handle(err);
    }
  });

program.parseAsync(process.argv).catch(handle);

function handle(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}\n`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === 'debug' && err instanceof Error) {
    process.stderr.write(`${err.stack}\n`);
  }
  const code = msg.includes('Schema validation') ? 4 : msg.includes('not found') ? 5 : 1;
  process.exit(code);
}
