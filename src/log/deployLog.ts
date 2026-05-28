// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — Deploy Log
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployLogEntry, ReadinessSnapshot, Verdict, CheckOptions } from '../types.js';

const LOG_FILE = join(process.cwd(), 'harbourmaster.log.json');

// ─── Append to Log ──────────────────────────────────────────

export function appendDeployLog(
  snapshot: ReadinessSnapshot,
  verdict: Verdict,
  options: CheckOptions
): void {
  const entry: DeployLogEntry = {
    timestamp: verdict.timestamp,
    service: options.service || 'default-service',
    release: options.release || 'latest',
    branch: options.branch || 'main',
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    riskScore: verdict.riskScore,
    reasoning: verdict.reasoning,
    checks: {
      github: {
        passing: snapshot.github.status === 'pass',
        summary: snapshot.github.summary,
      },
      sentry: {
        passing: snapshot.sentry.status === 'pass',
        summary: snapshot.sentry.summary,
      },
      datadog: {
        passing: snapshot.datadog.status === 'pass',
        summary: snapshot.datadog.summary,
      },
      pagerduty: {
        passing: snapshot.pagerduty.status === 'pass',
        summary: snapshot.pagerduty.summary,
      },
      statusgator: {
        passing: snapshot.statusgator.status === 'pass',
        summary: snapshot.statusgator.summary,
      },
      linear: {
        passing: snapshot.linear.status === 'pass',
        summary: snapshot.linear.summary,
      },
    },
  };

  const history = getDeployHistory();
  history.push(entry);

  // Keep last 100 entries
  const trimmed = history.slice(-100);

  try {
    writeFileSync(LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to write deploy log: ${(error as Error).message}`);
  }
}

// ─── Read History ───────────────────────────────────────────

export function getDeployHistory(limit?: number): DeployLogEntry[] {
  if (!existsSync(LOG_FILE)) return [];

  try {
    const raw = readFileSync(LOG_FILE, 'utf-8');
    const entries: DeployLogEntry[] = JSON.parse(raw);
    return limit ? entries.slice(-limit) : entries;
  } catch {
    return [];
  }
}
