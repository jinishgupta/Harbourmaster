// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — Coral Output Parser
// ═══════════════════════════════════════════════════════════════

import type {
  ReadinessSnapshot,
  GitHubCheck,
  SentryCheck,
  DatadogCheck,
  PagerDutyCheck,
  StatusGatorCheck,
  LinearCheck,
  CoralRow,
  CheckOptions,
  SourceStatus,
} from '../types.js';
import type { SourceQueryResults } from './query.js';

// ─── Tabular Output Parser ──────────────────────────────────
// Coral outputs tab-separated or pipe-separated tables.
// This parser handles both formats.

export function parseCoralTable(raw: string): CoralRow[] {
  const lines = raw.trim().split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Coral outputs MySQL-style box tables:
  //   +-------+--------+
  //   | col1  | col2   |
  //   +-------+--------+
  //   | val1  | val2   |
  //   +-------+--------+
  //
  // We need to:
  // 1. Filter out border lines (+---+---+)
  // 2. Extract the header from the first pipe-delimited line
  // 3. Extract data from subsequent pipe-delimited lines

  const isBorderLine = (line: string) => /^\+[-+]+\+$/.test(line.trim());

  // Separate content lines (pipe-delimited) from border lines
  const contentLines = lines.filter((l) => !isBorderLine(l));

  if (contentLines.length < 1) return [];

  // Check if lines are pipe-separated or tab-separated
  const isPipeSeparated = contentLines[0].includes('|');
  const separator = isPipeSeparated ? '|' : '\t';

  // First content line is the header
  const headerLine = contentLines[0];
  const headers = headerLine
    .split(separator)
    .map((h) => h.trim())
    .filter((h) => h.length > 0 && !h.match(/^[-─]+$/));

  if (headers.length === 0) return [];

  // Remaining content lines are data rows (skip any remaining separator lines)
  const dataLines = contentLines.slice(1).filter(
    (l) => !l.match(/^[\s|─-]+$/)
  );

  // Parse rows
  const rows: CoralRow[] = [];
  for (const line of dataLines) {
    const cells = line
      .split(separator)
      .map((c) => c.trim())
      .filter((c) => !c.match(/^[-─]*$/));

    // Filter out empty rows (from leading/trailing pipe)
    const nonEmptyCells = cells.filter((c) => c.length > 0);
    if (nonEmptyCells.length === 0) continue;

    const row: CoralRow = {};
    headers.forEach((header, idx) => {
      const value = cells[idx] ?? null;
      // Try to parse numbers
      if (value !== null && !isNaN(Number(value)) && value !== '') {
        row[header] = Number(value);
      } else if (value === 'true' || value === 'false') {
        row[header] = value === 'true';
      } else {
        row[header] = value;
      }
    });
    rows.push(row);
  }

  return rows;
}

// ─── Source-Specific Parsers ────────────────────────────────

function parseGitHub(
  prsRaw: string,
  workflowsRaw: string,
  options: CheckOptions
): GitHubCheck {
  const prs = parseCoralTable(prsRaw);
  const workflows = parseCoralTable(workflowsRaw);

  const mergedPRs = prs.filter((pr) => pr.state === 'closed' && pr.merged_at);
  const openPRs = prs.filter((pr) => pr.state === 'open');
  const failedWorkflows = workflows.filter(
    (w) => w.conclusion === 'failure' || w.status === 'failure'
  );
  const latestCI = workflows[0];
  const ciPassed =
    failedWorkflows.length === 0 &&
    (latestCI?.conclusion === 'success' || workflows.length === 0);

  let status: SourceStatus = 'pass';
  let riskScore = 0;

  if (failedWorkflows.length > 0) {
    status = 'fail';
    riskScore = 80;
  } else if (openPRs.length > 0) {
    status = 'warn';
    riskScore = 20;
  }

  const ciTimeAgo = latestCI?.created_at
    ? getTimeAgo(String(latestCI.created_at))
    : 'unknown';

  return {
    source: 'github',
    status,
    summary: ciPassed
      ? `All ${mergedPRs.length} release PRs merged. CI passed on ${options.branch || 'main'} (${ciTimeAgo}).`
      : `CI failed on ${options.branch || 'main'}. ${failedWorkflows.length} workflow(s) failing.`,
    details: {
      totalPRs: prs.length,
      mergedPRs: mergedPRs.length,
      openPRs: openPRs.length,
      ciPassed,
      lastCITime: ciTimeAgo,
      failedWorkflows: failedWorkflows.map((w) => String(w.name)),
    },
    riskScore,
  };
}

function parseSentry(raw: string, _options: CheckOptions): SentryCheck {
  const issues = parseCoralTable(raw);

  // Calculate error rate vs baseline
  const recentIssues = issues.filter((i) => {
    const lastSeen = new Date(String(i.last_seen));
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return lastSeen > oneHourAgo;
  });

  const totalCount = issues.reduce(
    (sum, i) => sum + (Number(i.count) || 0),
    0
  );
  const recentCount = recentIssues.reduce(
    (sum, i) => sum + (Number(i.count) || 0),
    0
  );

  // Estimate baseline (total / 24 hours) vs recent (last hour)
  const baselineRate = totalCount / 24;
  const currentRate = recentCount;
  const ratio = baselineRate > 0 ? currentRate / baselineRate : 0;

  const newFatals = issues.filter(
    (i) =>
      i.level === 'fatal' &&
      new Date(String(i.first_seen)) >
        new Date(Date.now() - 60 * 60 * 1000)
  ).length;

  let status: SourceStatus = 'pass';
  let riskScore = 0;

  if (newFatals > 0 || ratio > 2.0) {
    status = 'fail';
    riskScore = 90;
  } else if (ratio > 1.2) {
    status = 'warn';
    riskScore = 40;
  }

  return {
    source: 'sentry',
    status,
    summary:
      status === 'pass'
        ? `Error rate normal. ${issues.length} tracked issues, no new fatals.`
        : status === 'warn'
          ? `Error rate ${ratio.toFixed(1)}× above 24h baseline. No new fatals.`
          : `Error rate ${ratio.toFixed(1)}× above baseline. ${newFatals} new fatal error(s).`,
    details: {
      errorRate: currentRate,
      baselineRate,
      ratioToBaseline: Math.round(ratio * 10) / 10,
      newFatals,
      topIssues: issues.slice(0, 3).map((i) => ({
        title: String(i.title),
        count: Number(i.count) || 0,
        level: String(i.level),
      })),
    },
    riskScore,
  };
}

function parseDatadog(raw: string): DatadogCheck {
  const monitors = parseCoralTable(raw);

  const alertingMonitors = monitors.filter(
    (m) => m.status === 'Alert' || m.status === 'Warn'
  );
  const totalMonitors = monitors.length;

  let status: SourceStatus = 'pass';
  let riskScore = 0;

  if (alertingMonitors.some((m) => m.status === 'Alert')) {
    status = 'fail';
    riskScore = 70;
  } else if (alertingMonitors.length > 0) {
    status = 'warn';
    riskScore = 30;
  }

  return {
    source: 'datadog',
    status,
    summary:
      alertingMonitors.length === 0
        ? `All ${totalMonitors} monitors green.`
        : `${alertingMonitors.length}/${totalMonitors} monitors in alert state.`,
    details: {
      monitorsInAlert: alertingMonitors.length,
      totalMonitors,
      p99Latency: 0, // Computed from metrics if available
      baselineLatency: 0,
      alertingMonitors: alertingMonitors.map((m) => String(m.name)),
    },
    riskScore,
  };
}

function parsePagerDuty(
  incidentsRaw: string,
  oncallsRaw: string
): PagerDutyCheck {
  const incidents = parseCoralTable(incidentsRaw);
  const oncalls = parseCoralTable(oncallsRaw);

  const activeIncidents = incidents.filter(
    (i) => i.status === 'triggered' || i.status === 'acknowledged'
  );

  const highestSeverity =
    activeIncidents.find((i) => i.urgency === 'high' || i.severity === 'P1')
      ? 'P1'
      : activeIncidents.find(
            (i) => i.urgency === 'medium' || i.severity === 'P2'
          )
        ? 'P2'
        : activeIncidents.length > 0
          ? 'P3'
          : null;

  const topIncident = activeIncidents[0];
  const incidentDuration = topIncident?.created_at
    ? getTimeAgo(String(topIncident.created_at))
    : null;

  const onCallList = oncalls.map((oc) => ({
    name: String(oc.user_name || oc.name || 'Unknown'),
    service: String(oc.service || oc.escalation_policy_name || 'General'),
  }));

  let status: SourceStatus = 'pass';
  let riskScore = 0;

  if (activeIncidents.length > 0) {
    status = 'fail';
    riskScore = highestSeverity === 'P1' ? 100 : highestSeverity === 'P2' ? 85 : 60;
  }

  return {
    source: 'pagerduty',
    status,
    summary:
      activeIncidents.length === 0
        ? `No active incidents. All clear.`
        : `ACTIVE INCIDENT · "${topIncident?.title}" · ${highestSeverity} · ${incidentDuration}`,
    details: {
      activeIncidents: activeIncidents.length,
      highestSeverity,
      incidentTitle: topIncident ? String(topIncident.title) : null,
      incidentDuration,
      onCall: onCallList,
    },
    riskScore,
  };
}

function parseStatusGator(raw: string): StatusGatorCheck {
  const monitors = parseCoralTable(raw);

  const degradedServices = monitors
    .filter(
      (m) =>
        m.status !== 'operational' &&
        m.status !== 'up' &&
        m.status !== 'Operational'
    )
    .map((m) => String(m.service_name));

  const operationalServices = monitors
    .filter(
      (m) =>
        m.status === 'operational' ||
        m.status === 'up' ||
        m.status === 'Operational'
    )
    .map((m) => String(m.service_name));

  let status: SourceStatus = 'pass';
  let riskScore = 0;

  if (degradedServices.length > 0) {
    status = 'warn';
    riskScore = 35;
  }

  return {
    source: 'statusgator',
    status,
    summary:
      degradedServices.length === 0
        ? `${operationalServices.map((s) => `${s} ✓`).join('  ')}  All operational.`
        : `${degradedServices.join(', ')} degraded. ${operationalServices.length} services operational.`,
    details: {
      totalServices: monitors.length,
      degradedServices,
      operationalServices,
    },
    riskScore,
  };
}

function parseLinear(raw: string, options: CheckOptions): LinearCheck {
  const issues = parseCoralTable(raw);

  const closedIssues = issues.filter(
    (i) =>
      i.state === 'Done' ||
      i.state === 'Closed' ||
      i.state === 'Completed' ||
      i.state === 'done' ||
      i.state === 'closed'
  );
  const inProgressIssues = issues.filter(
    (i) =>
      i.state === 'In Progress' ||
      i.state === 'In Review' ||
      i.state === 'in_progress'
  );
  const openIssues = issues.filter(
    (i) =>
      i.state !== 'Done' &&
      i.state !== 'Closed' &&
      i.state !== 'Completed' &&
      i.state !== 'Cancelled' &&
      i.state !== 'done' &&
      i.state !== 'closed'
  );

  let status: SourceStatus = 'pass';
  let riskScore = 0;

  if (openIssues.length > 0) {
    status = 'warn';
    riskScore = 25;
  }

  return {
    source: 'linear',
    status,
    summary:
      openIssues.length === 0
        ? `${closedIssues.length}/${issues.length} issues in "${options.release || 'current release'}" closed.`
        : `${openIssues.length} unresolved issues in "${options.release || 'current release'}". ${closedIssues.length}/${issues.length} closed.`,
    details: {
      totalIssues: issues.length,
      closedIssues: closedIssues.length,
      openIssues: openIssues.length,
      inProgressIssues: inProgressIssues.length,
      releaseMilestone: options.release || null,
      unresolvedTitles: openIssues.map((i) => String(i.title)),
    },
    riskScore,
  };
}

// ─── Master Parser ──────────────────────────────────────────

export function parseAllResults(
  results: SourceQueryResults,
  options: CheckOptions
): ReadinessSnapshot {
  return {
    timestamp: new Date().toISOString(),
    service: options.service || 'default-service',
    release: options.release || 'latest',
    branch: options.branch || 'main',
    github: parseGitHub(results.github.prs, results.github.workflows, options),
    sentry: parseSentry(results.sentry, options),
    datadog: parseDatadog(results.datadog),
    pagerduty: parsePagerDuty(
      results.pagerduty.incidents,
      results.pagerduty.oncalls
    ),
    statusgator: parseStatusGator(results.statusgator),
    linear: parseLinear(results.linear, options),
  };
}

// ─── Utility ────────────────────────────────────────────────

function getTimeAgo(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (isNaN(diffMs) || diffMs < 0) return 'just now';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
