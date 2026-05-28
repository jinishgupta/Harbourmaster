// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — Coral SQL Query Builder
// ═══════════════════════════════════════════════════════════════

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CheckOptions } from '../types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ─── Individual Source Queries ───────────────────────────────
// Coral joins work best as individual queries per source,
// then we combine results in TypeScript.

// GitHub config from env (defaults to withcoral/coral as a demo repo)
const GH_OWNER = process.env.GITHUB_OWNER || 'withcoral';
const GH_REPO = process.env.GITHUB_REPO || 'coral';
// StatusGator board ID from env
const SG_BOARD_ID = process.env.STATUSGATOR_BOARD_ID || '';

export function buildGitHubQuery(options: CheckOptions): string {
  return `
    SELECT
      title,
      state,
      merged_at,
      user__login,
      head__ref AS branch,
      created_at,
      updated_at
    FROM github.pulls
    WHERE owner = '${GH_OWNER}' AND repo = '${GH_REPO}'
    ORDER BY updated_at DESC
    LIMIT 10
  `.trim();
}

export function buildGitHubWorkflowQuery(options: CheckOptions): string {
  const branch = options.branch || 'main';
  return `
    SELECT
      name AS check_name,
      status,
      conclusion,
      ref,
      started_at,
      completed_at
    FROM github.check_runs
    WHERE owner = '${GH_OWNER}' AND repo = '${GH_REPO}' AND ref = '${branch}'
    ORDER BY completed_at DESC
    LIMIT 5
  `.trim();
}

export function buildSentryQuery(options: CheckOptions): string {
  return `
    SELECT
      title,
      level,
      status,
      first_seen,
      last_seen,
      count
    FROM sentry.issues
    ORDER BY last_seen DESC
    LIMIT 20
  `.trim();
}

export function buildDatadogMonitorQuery(): string {
  return `
    SELECT
      name,
      type,
      status,
      query,
      message
    FROM datadog.monitors
    ORDER BY name ASC
    LIMIT 20
  `.trim();
}

export function buildPagerDutyIncidentQuery(): string {
  return `
    SELECT
      title,
      status,
      urgency,
      created_at
    FROM pagerduty.incidents
    WHERE status = 'triggered' OR status = 'acknowledged'
    ORDER BY created_at DESC
    LIMIT 10
  `.trim();
}

export function buildPagerDutyOncallQuery(): string {
  return `
    SELECT
      user__summary AS user_name,
      escalation_policy__summary AS service
    FROM pagerduty.oncalls
    LIMIT 10
  `.trim();
}

export function buildStatusGatorQuery(): string {
  if (!SG_BOARD_ID) {
    // Return a query that will return empty results gracefully
    return `SELECT display_name AS service_name, filtered_status AS status FROM statusgator.boards LIMIT 0`.trim();
  }
  return `
    SELECT
      display_name AS service_name,
      filtered_status AS status,
      last_message
    FROM statusgator.monitors
    WHERE board_id = '${SG_BOARD_ID}'
    ORDER BY display_name ASC
    LIMIT 20
  `.trim();
}

export function buildLinearQuery(options: CheckOptions): string {
  const labelFilter = options.release
    ? `WHERE label_names LIKE '%${options.release}%'`
    : '';

  return `
    SELECT
      title,
      state_name AS state,
      assignee_name AS assignee,
      label_names AS label,
      priority,
      updated_at
    FROM linear.issues
    ${labelFilter}
    ORDER BY updated_at DESC
    LIMIT 20
  `.trim();
}

// ─── Combined 6-Source Query (for demo) ─────────────────────
// This is the showcase query that queries all 6 sources via Coral.
// NOTE: UNION ALL across sources may not work in Coral — use individual queries instead.
export function buildCombinedQuery(options: CheckOptions): string {
  return 'SELECT 1'; // Placeholder — we use individual queries in executeAllQueries
}

// ─── Query Execution ────────────────────────────────────────

export async function executeCoralQuery(query: string): Promise<string> {
  // Homebrew paths needed for non-interactive shells
  const pathPrefix = 'PATH="/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:$PATH"';
  // Collapse multi-line SQL to a single line — newlines inside double quotes
  // break when passed through wsl to bash (EOF while looking for matching '"').
  const singleLineQuery = query.replace(/\s+/g, ' ').trim();
  const escapedQuery = singleLineQuery.replace(/"/g, '\\"');

  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // On Windows, use execFile to bypass cmd.exe's quoting issues
    try {
      const { stdout, stderr } = await execFileAsync('wsl', [
        '--',
        'bash',
        '-c',
        `${pathPrefix} coral sql "${escapedQuery}"`
      ], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 10,
      });

      if (stderr && !stdout) {
        throw new Error(`Coral error: ${stderr}`);
      }

      return stdout;
    } catch (error: any) {
      throw new Error(
        `Coral query failed via WSL: ${error.message}\n` +
        `STDOUT: ${error.stdout}\n` +
        `STDERR: ${error.stderr}\n` +
        'Make sure Coral is installed in WSL (brew install withcoral/tap/coral) and sources are configured.'
      );
    }
  }

  // On Linux/macOS, try coral directly
  try {
    const { stdout, stderr } = await execAsync(
      `${pathPrefix} coral sql "${escapedQuery}"`,
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 10,
      }
    );

    if (stderr && !stdout) {
      throw new Error(`Coral error: ${stderr}`);
    }

    return stdout;
  } catch (error: unknown) {
    const err = error as Error & { code?: string };

    if (err.code === 'ENOENT' || err.message?.includes('not found') || err.message?.includes('not recognized')) {
      throw new Error(
        'Coral CLI not found. Install Coral (brew install withcoral/tap/coral).'
      );
    }

    throw error;
  }
}

// ─── Execute Individual Queries ─────────────────────────────

export interface SourceQueryResults {
  github: { prs: string; workflows: string };
  sentry: string;
  datadog: string;
  pagerduty: { incidents: string; oncalls: string };
  statusgator: string;
  linear: string;
}

export async function executeAllQueries(
  options: CheckOptions
): Promise<SourceQueryResults> {
  // Execute queries sequentially to prevent overloading WSL concurrency on Windows,
  // which can cause random wsl.exe crashes or silent empty returns.
  const githubPRs = await executeCoralQuery(buildGitHubQuery(options));
  const githubWorkflows = await executeCoralQuery(buildGitHubWorkflowQuery(options));
  const sentry = await executeCoralQuery(buildSentryQuery(options));
  const datadog = await executeCoralQuery(buildDatadogMonitorQuery());
  const pdIncidents = await executeCoralQuery(buildPagerDutyIncidentQuery());
  const pdOncalls = await executeCoralQuery(buildPagerDutyOncallQuery());
  const statusgator = await executeCoralQuery(buildStatusGatorQuery());
  const linear = await executeCoralQuery(buildLinearQuery(options));

  return {
    github: { prs: githubPRs, workflows: githubWorkflows },
    sentry,
    datadog,
    pagerduty: { incidents: pdIncidents, oncalls: pdOncalls },
    statusgator,
    linear,
  };
}
