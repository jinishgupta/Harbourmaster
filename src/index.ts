#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — CLI Entry Point
//  Deploy readiness intelligence agent
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Command } from 'commander';
import { executeAllQueries } from './coral/query.js';
import { parseAllResults } from './coral/parser.js';
import { synthesizeVerdict } from './gemini/verdict.js';
import {
  renderFullCheck,
  renderJSON,
  renderHistory,
  renderWatchHeader,
  renderError,
  createSpinner,
} from './output/terminal.js';
import { postSlackNotification } from './output/slack.js';
import { appendDeployLog, getDeployHistory } from './log/deployLog.js';
import type { CheckOptions, WatchOptions } from './types.js';

// ─── CLI Setup ──────────────────────────────────────────────

const program = new Command();

program
  .name('harbourmaster')
  .description(
    '⚓ Deploy readiness intelligence agent — 6 sources, one verdict, under 10 seconds.'
  )
  .version('1.0.0');

// ─── Check Command ──────────────────────────────────────────

program
  .command('check')
  .description('Run a deploy readiness check across all 6 sources')
  .option('-s, --service <name>', 'Service name to check', 'payments-service')
  .option('-r, --release <version>', 'Release version/milestone', 'v2.4.1')
  .option('-b, --branch <name>', 'Git branch to check', 'main')
  .option('--no-slack', 'Skip Slack notification')
  .option('--json', 'Output as JSON instead of formatted terminal output')
  .action(async (opts: CheckOptions) => {
    await runCheck(opts);
  });

// ─── Watch Command ──────────────────────────────────────────

program
  .command('watch')
  .description('Continuously monitor deploy readiness')
  .option('-s, --service <name>', 'Service name to check', 'payments-service')
  .option('-r, --release <version>', 'Release version/milestone', 'v2.4.1')
  .option('-b, --branch <name>', 'Git branch to check', 'main')
  .option(
    '-i, --interval <seconds>',
    'Check interval in seconds',
    '30'
  )
  .option('--no-slack', 'Skip Slack notifications')
  .action(async (opts: WatchOptions & { interval?: string }) => {
    const interval = parseInt(String(opts.interval || '30'), 10);
    await runWatch({ ...opts, interval });
  });

// ─── History Command ────────────────────────────────────────

program
  .command('history')
  .description('Show deploy check history')
  .option('-n, --limit <count>', 'Number of entries to show', '10')
  .action((opts: { limit?: string }) => {
    const limit = parseInt(opts.limit || '10', 10);
    const entries = getDeployHistory(limit);
    renderHistory(
      entries.map((e) => ({
        timestamp: e.timestamp,
        service: e.service,
        release: e.release,
        verdict: e.verdict,
        riskScore: e.riskScore,
      }))
    );
  });

// ─── Parse & Run ────────────────────────────────────────────

program.parse();

// ─── Check Logic ────────────────────────────────────────────

async function runCheck(options: CheckOptions): Promise<void> {
  const startTime = Date.now();

  // Step 1: Query all sources via Coral
  const spinner = createSpinner('Querying 6 sources via Coral...');
  spinner.start();

  let results;
  try {
    results = await executeAllQueries(options);
    spinner.succeed('All 6 sources queried successfully');
  } catch (error) {
    spinner.fail('Failed to query sources');
    renderError(
      (error as Error).message,
      'Make sure Coral is installed and all sources are configured.\nRun: coral source discover'
    );
    process.exit(1);
  }

  // Step 2: Parse results into snapshot
  const parseSpinner = createSpinner('Parsing source data...');
  parseSpinner.start();
  const snapshot = parseAllResults(results, options);
  parseSpinner.succeed('Data parsed');

  // Step 3: Synthesize verdict via Gemini
  const verdictSpinner = createSpinner(
    process.env.GEMINI_API_KEY
      ? 'Synthesizing verdict with Gemini...'
      : 'Computing verdict (local rules — set GEMINI_API_KEY for AI reasoning)...'
  );
  verdictSpinner.start();

  let verdict;
  try {
    verdict = await synthesizeVerdict(snapshot);
    verdictSpinner.succeed(
      process.env.GEMINI_API_KEY
        ? 'Gemini verdict received'
        : 'Local verdict computed'
    );
  } catch (error) {
    verdictSpinner.fail('Verdict synthesis failed');
    renderError((error as Error).message);
    process.exit(1);
  }

  const durationMs = Date.now() - startTime;

  // Step 4: Render output
  if (options.json) {
    renderJSON(snapshot, verdict);
  } else {
    renderFullCheck(snapshot, verdict, options, durationMs);
  }

  // Step 5: Slack notification
  if (options.noSlack !== true) {
    try {
      await postSlackNotification(snapshot, verdict, options);
    } catch {
      // Silently skip Slack errors
    }
  }

  // Step 6: Append to deploy log
  appendDeployLog(snapshot, verdict, options);
}

// ─── Watch Logic ────────────────────────────────────────────

async function runWatch(options: WatchOptions): Promise<void> {
  const interval = (options.interval || 30) * 1000;

  renderWatchHeader(options.interval || 30);

  let lastVerdict: string | null = null;

  const runOnce = async () => {
    const startTime = Date.now();

    try {
      const results = await executeAllQueries(options);
      const snapshot = parseAllResults(results, options);
      const verdict = await synthesizeVerdict(snapshot);
      const durationMs = Date.now() - startTime;

      // Clear screen for clean updates
      console.clear();
      renderWatchHeader(options.interval || 30);
      renderFullCheck(snapshot, verdict, options, durationMs);

      // Detect state transitions
      if (lastVerdict && lastVerdict !== verdict.verdict) {
        const transition = `${lastVerdict} → ${verdict.verdict}`;
        console.log(`\n  🔔 State change detected: ${transition}\n`);
      }
      lastVerdict = verdict.verdict;

      // Log and notify
      appendDeployLog(snapshot, verdict, options);
      if (options.noSlack !== true && lastVerdict !== verdict.verdict) {
        await postSlackNotification(snapshot, verdict, options);
      }
    } catch (error) {
      renderError(
        `Watch cycle failed: ${(error as Error).message}`,
        `Next check in ${options.interval || 30}s...`
      );
    }
  };

  // Run immediately, then on interval
  await runOnce();

  setInterval(runOnce, interval);

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\n\n  ⚓ Harbourmaster watch stopped.\n');
    process.exit(0);
  });
}
