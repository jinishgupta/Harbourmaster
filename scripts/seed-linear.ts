import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────────
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error(
    '❌ Missing LINEAR_API_KEY in .env\n' +
      '   Create one at: Linear → Settings → API → Personal API Keys\n' +
      '   Needs read/write access to issues, teams, and labels.',
  );
  process.exit(1);
}

const GRAPHQL_URL = 'https://api.linear.app/graphql';

// ─── GraphQL helper ──────────────────────────────────────────
async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: API_KEY!,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL errors:\n${json.errors.map((e) => `  • ${e.message}`).join('\n')}`);
  }
  return json.data as T;
}

// ─── Step 1: Find or create team ─────────────────────────────
interface Team {
  id: string;
  name: string;
  key: string;
}

async function findOrCreateTeam(): Promise<Team> {
  console.log('🔍 Looking for "Engineering" team…');

  const data = await gql<{ teams: { nodes: Team[] } }>(`
    query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }
  `);

  // Look for Engineering team
  let team = data.teams.nodes.find(
    (t) => t.name.toLowerCase() === 'engineering',
  );
  if (team) {
    console.log(`   ✅ Found team: "${team.name}" (${team.key})\n`);
    return team;
  }

  // Use first available team if any exist
  if (data.teams.nodes.length > 0) {
    team = data.teams.nodes[0];
    console.log(`   ℹ️  No "Engineering" team found. Using "${team.name}" (${team.key})\n`);
    return team;
  }

  // Create one
  console.log('   📦 No teams found. Creating "Engineering" team…');
  const createData = await gql<{ teamCreate: { team: Team; success: boolean } }>(`
    mutation($input: TeamCreateInput!) {
      teamCreate(input: $input) {
        success
        team {
          id
          name
          key
        }
      }
    }
  `, {
    input: {
      name: 'Engineering',
      key: 'ENG',
    },
  });

  if (!createData.teamCreate.success) {
    throw new Error('Failed to create Engineering team');
  }

  console.log(`   ✅ Created team: "${createData.teamCreate.team.name}" (${createData.teamCreate.team.key})\n`);
  return createData.teamCreate.team;
}

// ─── Step 2: Find or create label ────────────────────────────
interface Label {
  id: string;
  name: string;
}

async function findOrCreateLabel(teamId: string): Promise<Label> {
  const labelName = 'Release v2.4.1';
  console.log(`🏷️  Looking for label "${labelName}"…`);

  const data = await gql<{ issueLabels: { nodes: Label[] } }>(`
    query($filter: IssueLabelFilter) {
      issueLabels(filter: $filter) {
        nodes {
          id
          name
        }
      }
    }
  `, {
    filter: {
      name: { eq: labelName },
    },
  });

  if (data.issueLabels.nodes.length > 0) {
    console.log(`   ✅ Found existing label: "${data.issueLabels.nodes[0].name}"\n`);
    return data.issueLabels.nodes[0];
  }

  // Create the label
  console.log(`   📦 Creating label "${labelName}"…`);
  const createData = await gql<{ issueLabelCreate: { issueLabel: Label; success: boolean } }>(`
    mutation($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) {
        success
        issueLabel {
          id
          name
        }
      }
    }
  `, {
    input: {
      name: labelName,
      teamId,
      color: '#6B5CE7', // Purple — release label
    },
  });

  if (!createData.issueLabelCreate.success) {
    throw new Error(`Failed to create label "${labelName}"`);
  }

  console.log(`   ✅ Created label: "${createData.issueLabelCreate.issueLabel.name}"\n`);
  return createData.issueLabelCreate.issueLabel;
}

// ─── Step 3: Get workflow states ─────────────────────────────
interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

async function getWorkflowStates(teamId: string): Promise<Map<string, WorkflowState>> {
  console.log('📋 Fetching workflow states…');

  const data = await gql<{ workflowStates: { nodes: WorkflowState[] } }>(`
    query($filter: WorkflowStateFilter) {
      workflowStates(filter: $filter) {
        nodes {
          id
          name
          type
        }
      }
    }
  `, {
    filter: {
      team: { id: { eq: teamId } },
    },
  });

  const stateMap = new Map<string, WorkflowState>();
  for (const state of data.workflowStates.nodes) {
    // Map by type for easy lookup
    stateMap.set(state.type, state);
    // Also map by name for exact matches
    stateMap.set(state.name.toLowerCase(), state);
  }

  const stateNames = data.workflowStates.nodes.map((s) => `${s.name} (${s.type})`).join(', ');
  console.log(`   ✅ States: ${stateNames}\n`);

  return stateMap;
}

// ─── Step 4: Create issues ───────────────────────────────────
interface IssueDefinition {
  title: string;
  description: string;
  status: 'done' | 'in_progress';
  priority: number; // 1=urgent, 2=high, 3=medium, 4=low
}

const issues: IssueDefinition[] = [
  {
    title: 'Implement payment retry logic',
    description:
      'Add exponential backoff retry mechanism for failed payment attempts. ' +
      'Retry up to 3 times with delays of 1s, 4s, 16s. Log each retry attempt ' +
      'and emit metrics for monitoring. Handle non-retryable errors (card_declined, ' +
      'insufficient_funds) by failing fast.',
    status: 'done',
    priority: 2,
  },
  {
    title: 'Add Stripe webhook handlers',
    description:
      'Implement webhook handlers for: payment_intent.succeeded, payment_intent.payment_failed, ' +
      'charge.refunded, charge.dispute.created. Verify webhook signatures using Stripe\'s ' +
      'signing secret. Store raw events in webhook_events table for replay capability.',
    status: 'done',
    priority: 2,
  },
  {
    title: 'Update checkout flow UI',
    description:
      'Redesign checkout page to support the new payment retry flow. Add loading states, ' +
      'error messages for declined cards, and retry prompts. Include progress indicator ' +
      'for multi-step checkout. Mobile-responsive layout required.',
    status: 'done',
    priority: 3,
  },
  {
    title: 'Fix currency conversion rounding',
    description:
      'Fix floating-point precision issues in currency conversion. Use integer-based ' +
      'arithmetic (cents) for all calculations. Apply banker\'s rounding (round half to even) ' +
      'per ISO 4217. Add unit tests for edge cases: JPY (0 decimals), KWD (3 decimals).',
    status: 'done',
    priority: 1,
  },
  {
    title: 'Add idempotency keys to payment API',
    description:
      'Implement idempotency key support for POST /api/v2/payments. Keys stored in Redis ' +
      'with 24h TTL. Return cached response for duplicate requests. Handle race conditions ' +
      'with distributed locking. Return 409 Conflict if same key used with different parameters.',
    status: 'done',
    priority: 2,
  },
  {
    title: 'Update API rate limiting config',
    description:
      'Increase rate limits for authenticated users from 100 → 500 req/min. Add separate ' +
      'limits for webhook endpoints (1000 req/min). Implement sliding window counter in Redis. ' +
      'Return Retry-After header on 429 responses. Add rate limit headers to all responses.',
    status: 'in_progress',
    priority: 3,
  },
  {
    title: 'Add payment failure notifications',
    description:
      'Send email and Slack notifications when payments fail. Include: transaction ID, ' +
      'amount, currency, failure reason, customer email. Throttle notifications to max ' +
      '1 per customer per hour. Add notification preferences to merchant settings.',
    status: 'in_progress',
    priority: 3,
  },
];

interface CreatedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

async function createIssue(
  teamId: string,
  labelIds: string[],
  stateId: string,
  issue: IssueDefinition,
): Promise<CreatedIssue> {
  const data = await gql<{ issueCreate: { issue: CreatedIssue; success: boolean } }>(`
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
        }
      }
    }
  `, {
    input: {
      teamId,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      stateId,
      labelIds,
    },
  });

  if (!data.issueCreate.success) {
    throw new Error(`Failed to create issue: "${issue.title}"`);
  }

  return data.issueCreate.issue;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Seeding Linear with release tracking issues…\n');

  // Step 1 — Team
  const team = await findOrCreateTeam();

  // Step 2 — Label
  const label = await findOrCreateLabel(team.id);

  // Step 3 — Workflow states
  const states = await getWorkflowStates(team.id);

  // Resolve "done" and "in_progress" states
  const doneState =
    states.get('done') ||
    states.get('completed') ||
    states.get('closed');
  const inProgressState =
    states.get('started') ||
    states.get('in progress') ||
    states.get('in_progress');

  if (!doneState) {
    console.error('❌ Could not find a "Done/Completed" workflow state');
    console.error('   Available states:', [...states.entries()].map(([k, v]) => `${k}=${v.name}`).join(', '));
    process.exit(1);
  }
  if (!inProgressState) {
    console.error('❌ Could not find an "In Progress" workflow state');
    console.error('   Available states:', [...states.entries()].map(([k, v]) => `${k}=${v.name}`).join(', '));
    process.exit(1);
  }

  console.log(`   📌 "Done" state:        ${doneState.name} (${doneState.type})`);
  console.log(`   📌 "In Progress" state:  ${inProgressState.name} (${inProgressState.type})\n`);

  // Step 4 — Create issues
  console.log(`📝 Creating ${issues.length} issues with label "${label.name}"…\n`);

  const created: CreatedIssue[] = [];
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const stateId = issue.status === 'done' ? doneState.id : inProgressState.id;
    const statusIcon = issue.status === 'done' ? '✅' : '🔄';

    const result = await createIssue(team.id, [label.id], stateId, issue);
    created.push(result);

    console.log(
      `   ${statusIcon} [${i + 1}/${issues.length}] ${result.identifier} — ${result.title}`,
    );
  }

  // Summary
  console.log('\n' + '─'.repeat(60));
  console.log('✅ Linear seeding complete!\n');
  console.log(`   Team:   ${team.name} (${team.key})`);
  console.log(`   Label:  ${label.name}`);
  console.log(`   Issues: ${created.length} created (${issues.filter((i) => i.status === 'done').length} done, ${issues.filter((i) => i.status === 'in_progress').length} in progress)\n`);

  console.log('📋 Created issues:');
  for (const issue of created) {
    console.log(`   ${issue.identifier}: ${issue.title}`);
    console.log(`   🔗 ${issue.url}\n`);
  }
}

main().catch((err) => {
  console.error('💥 Seeding failed:', err);
  process.exit(1);
});
