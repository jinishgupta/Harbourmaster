// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — Type Definitions
// ═══════════════════════════════════════════════════════════════

// ─── CLI Options ────────────────────────────────────────────

export interface CheckOptions {
  service?: string;
  release?: string;
  branch?: string;
  live?: boolean;
  noSlack?: boolean;
  json?: boolean;
}

export interface WatchOptions extends CheckOptions {
  interval?: number; // seconds
}

// ─── Source Check Results ───────────────────────────────────

export type SourceStatus = 'pass' | 'warn' | 'fail';

export interface SourceCheck {
  source: string;
  status: SourceStatus;
  summary: string;
  details: Record<string, unknown>;
  riskScore: number; // 0–100 contribution from this source
}

export interface GitHubCheck extends SourceCheck {
  source: 'github';
  details: {
    totalPRs: number;
    mergedPRs: number;
    openPRs: number;
    ciPassed: boolean;
    lastCITime: string;
    failedWorkflows: string[];
  };
}

export interface SentryCheck extends SourceCheck {
  source: 'sentry';
  details: {
    errorRate: number;
    baselineRate: number;
    ratioToBaseline: number;
    newFatals: number;
    topIssues: Array<{ title: string; count: number; level: string }>;
  };
}

export interface DatadogCheck extends SourceCheck {
  source: 'datadog';
  details: {
    monitorsInAlert: number;
    totalMonitors: number;
    p99Latency: number;
    baselineLatency: number;
    alertingMonitors: string[];
  };
}

export interface PagerDutyCheck extends SourceCheck {
  source: 'pagerduty';
  details: {
    activeIncidents: number;
    highestSeverity: string | null;
    incidentTitle: string | null;
    incidentDuration: string | null;
    onCall: Array<{ name: string; service: string }>;
  };
}

export interface StatusGatorCheck extends SourceCheck {
  source: 'statusgator';
  details: {
    totalServices: number;
    degradedServices: string[];
    operationalServices: string[];
  };
}

export interface LinearCheck extends SourceCheck {
  source: 'linear';
  details: {
    totalIssues: number;
    closedIssues: number;
    openIssues: number;
    inProgressIssues: number;
    releaseMilestone: string | null;
    unresolvedTitles: string[];
  };
}

// ─── Readiness Snapshot ─────────────────────────────────────

export interface ReadinessSnapshot {
  timestamp: string;
  service: string;
  release: string;
  branch: string;
  github: GitHubCheck;
  sentry: SentryCheck;
  datadog: DatadogCheck;
  pagerduty: PagerDutyCheck;
  statusgator: StatusGatorCheck;
  linear: LinearCheck;
}

// ─── Verdict ────────────────────────────────────────────────

export type VerdictType = 'GO' | 'HOLD' | 'CAUTION';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Verdict {
  verdict: VerdictType;
  confidence: ConfidenceLevel;
  reasoning: string;
  riskScore: number; // 0–100 overall
  onCall: Array<{ name: string; service: string }>;
  timestamp: string;
}

// ─── Deploy Log ─────────────────────────────────────────────

export interface DeployLogEntry {
  timestamp: string;
  service: string;
  release: string;
  branch: string;
  verdict: VerdictType;
  confidence: ConfidenceLevel;
  riskScore: number;
  reasoning: string;
  checks: {
    github: { passing: boolean; summary: string };
    sentry: { passing: boolean; summary: string };
    datadog: { passing: boolean; summary: string };
    pagerduty: { passing: boolean; summary: string };
    statusgator: { passing: boolean; summary: string };
    linear: { passing: boolean; summary: string };
  };
}

// ─── Coral Raw Output ───────────────────────────────────────

export interface CoralRow {
  [key: string]: string | number | boolean | null;
}

export interface CoralQueryResult {
  columns: string[];
  rows: CoralRow[];
  source: string;
}
