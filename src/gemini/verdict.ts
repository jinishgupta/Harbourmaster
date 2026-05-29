// ═══════════════════════════════════════════════════════════════
//  Harbourmaster — Gemini Verdict Synthesizer
// ═══════════════════════════════════════════════════════════════

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ReadinessSnapshot, Verdict, VerdictType, ConfidenceLevel } from '../types.js';

// ─── System Prompt ──────────────────────────────────────────

const SYSTEM_PROMPT = `You are Harbourmaster, a deploy readiness intelligence agent. You analyze data from 6 monitoring sources and produce a deployment verdict.

Your job is to determine whether it is safe to deploy right now based on the evidence provided.

## Verdict Rules (follow strictly):

### HOLD (definitive — any ONE of these triggers HOLD):
- Active PagerDuty incident (any severity)
- Error rate more than 2× the 24h baseline in Sentry
- Failed CI on the release branch in GitHub

### HOLD (advisory — these should trigger HOLD with medium confidence):
- Any StatusGator dependency degraded
- Any Datadog monitor in alert state
- Unresolved Linear issues in the target release

### CAUTION (advisory — these trigger CAUTION):
- Error rate between 1.2×-2× baseline in Sentry
- Open (non-release-blocking) PRs on the branch
- Datadog monitors in warn (not alert) state

### GO (all of the following must be true):
- No active PagerDuty incidents
- Error rate below 1.2× baseline
- CI passing on the release branch
- All StatusGator dependencies operational
- All Datadog monitors green
- All release-scoped Linear issues resolved

## Response Format:
Respond ONLY with valid JSON in this exact schema:
{
  "verdict": "GO" | "HOLD" | "CAUTION",
  "confidence": "high" | "medium" | "low",
  "reasoning": "A plain-English paragraph of 3-5 sentences explaining the verdict. Reference specific data points from the sources. If HOLD, clearly state what needs to change before deploying. If GO, confirm what was checked.",
  "riskScore": <number 0-100>,
  "onCall": [{"name": "<person>", "service": "<team/service>"}]
}

## Risk Score Guidelines:
- 0-30: Safe to deploy (GO territory)
- 31-60: Proceed with caution (CAUTION territory)
- 61-100: Do not deploy (HOLD territory)

Be specific and cite data. Engineers trust this verdict to decide whether to ship.`;

// ─── Gemini Synthesis ───────────────────────────────────────

export async function synthesizeVerdict(
  snapshot: ReadinessSnapshot
): Promise<Verdict> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    // Fall back to rule-based verdict
    return computeLocalVerdict(snapshot);
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1, // Low temperature for consistent verdicts
      },
    });

    const prompt = formatSnapshotForPrompt(snapshot);

    const result = await model.generateContent([
      { text: SYSTEM_PROMPT },
      { text: prompt },
    ]);

    const responseText = result.response.text();
    const parsed = JSON.parse(responseText) as {
      verdict: VerdictType;
      confidence: ConfidenceLevel;
      reasoning: string;
      riskScore: number;
      onCall: Array<{ name: string; service: string }>;
    };

    return {
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      riskScore: parsed.riskScore,
      onCall: parsed.onCall || snapshot.pagerduty.details.onCall,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(
      'Gemini API error, falling back to local verdict:',
      (error as Error).message
    );
    return computeLocalVerdict(snapshot);
  }
}

// ─── Format Snapshot for Prompt ─────────────────────────────

function formatSnapshotForPrompt(snapshot: ReadinessSnapshot): string {
  return `
## Deploy Readiness Check
**Service:** ${snapshot.service}
**Release:** ${snapshot.release}
**Branch:** ${snapshot.branch}
**Timestamp:** ${snapshot.timestamp}

## Source Results:

### 1. GitHub (CI & Pull Requests)
- Status: ${snapshot.github.status}
- CI Passed: ${snapshot.github.details.ciPassed}
- Total PRs: ${snapshot.github.details.totalPRs}
- Merged PRs: ${snapshot.github.details.mergedPRs}
- Open PRs: ${snapshot.github.details.openPRs}
- Failed Workflows: ${snapshot.github.details.failedWorkflows.join(', ') || 'None'}
- Last CI: ${snapshot.github.details.lastCITime}

### 2. Sentry (Error Monitoring)
- Status: ${snapshot.sentry.status}
- Current Error Rate: ${snapshot.sentry.details.errorRate} events/hour
- 24h Baseline Rate: ${snapshot.sentry.details.baselineRate.toFixed(1)} events/hour
- Ratio to Baseline: ${snapshot.sentry.details.ratioToBaseline}×
- New Fatal Errors (last 1h): ${snapshot.sentry.details.newFatals}
- Top Issues: ${JSON.stringify(snapshot.sentry.details.topIssues)}

### 3. Datadog (Infrastructure)
- Status: ${snapshot.datadog.status}
- Monitors in Alert: ${snapshot.datadog.details.monitorsInAlert}/${snapshot.datadog.details.totalMonitors}
- Alerting Monitors: ${snapshot.datadog.details.alertingMonitors.join(', ') || 'None'}

### 4. PagerDuty (Incidents)
- Status: ${snapshot.pagerduty.status}
- Active Incidents: ${snapshot.pagerduty.details.activeIncidents}
- Highest Severity: ${snapshot.pagerduty.details.highestSeverity || 'N/A'}
- Incident: ${snapshot.pagerduty.details.incidentTitle || 'None'}
- Duration: ${snapshot.pagerduty.details.incidentDuration || 'N/A'}
- On-Call: ${JSON.stringify(snapshot.pagerduty.details.onCall)}

### 5. StatusGator (Third-Party Dependencies)
- Status: ${snapshot.statusgator.status}
- Total Services: ${snapshot.statusgator.details.totalServices}
- Degraded: ${snapshot.statusgator.details.degradedServices.join(', ') || 'None'}
- Operational: ${snapshot.statusgator.details.operationalServices.join(', ')}

### 6. Linear (Release Scope)
- Status: ${snapshot.linear.status}
- Release: ${snapshot.linear.details.releaseMilestone || 'N/A'}
- Issues: ${snapshot.linear.details.closedIssues}/${snapshot.linear.details.totalIssues} closed
- Open: ${snapshot.linear.details.openIssues}
- In Progress: ${snapshot.linear.details.inProgressIssues}
- Unresolved: ${snapshot.linear.details.unresolvedTitles.join(', ') || 'None'}

Based on all 6 sources, provide the deployment verdict.
  `.trim();
}

// ─── Local Rule-Based Verdict (Fallback) ────────────────────

function computeLocalVerdict(snapshot: ReadinessSnapshot): Verdict {
  const sources = [
    snapshot.github,
    snapshot.sentry,
    snapshot.datadog,
    snapshot.pagerduty,
    snapshot.statusgator,
    snapshot.linear,
  ];

  const hasFailure = sources.some((s) => s.status === 'fail');
  const hasWarning = sources.some((s) => s.status === 'warn');

  // Weighted risk score
  const weights = {
    github: 0.2,
    sentry: 0.2,
    datadog: 0.15,
    pagerduty: 0.25,
    statusgator: 0.1,
    linear: 0.1,
  };

  const riskScore = Math.round(
    snapshot.github.riskScore * weights.github +
    snapshot.sentry.riskScore * weights.sentry +
    snapshot.datadog.riskScore * weights.datadog +
    snapshot.pagerduty.riskScore * weights.pagerduty +
    snapshot.statusgator.riskScore * weights.statusgator +
    snapshot.linear.riskScore * weights.linear
  );

  let verdict: VerdictType;
  let confidence: ConfidenceLevel;
  let reasoning: string;

  if (hasFailure) {
    verdict = 'HOLD';
    confidence = 'high';
    const failingSources = sources
      .filter((s) => s.status === 'fail')
      .map((s) => `${s.source}: ${s.summary}`)
      .join(' ');
    reasoning = `Deploy blocked due to critical issues. ${failingSources} Recommend resolving these issues before shipping.`;
  } else if (hasWarning) {
    verdict = 'CAUTION';
    confidence = 'medium';
    const warningSources = sources
      .filter((s) => s.status === 'warn')
      .map((s) => `${s.source}: ${s.summary}`)
      .join(' ');
    reasoning = `Deploy possible but with caveats. ${warningSources} All critical checks pass, but review the warnings before proceeding.`;
  } else {
    verdict = 'GO';
    confidence = 'high';
    reasoning = `All 6 readiness checks passed. CI is green on ${snapshot.branch}, error rates are normal, no active incidents, all dependencies operational, and all release issues are resolved. Safe to ship.`;
  }

  return {
    verdict,
    confidence,
    reasoning,
    riskScore,
    onCall: snapshot.pagerduty.details.onCall,
    timestamp: new Date().toISOString(),
  };
}
