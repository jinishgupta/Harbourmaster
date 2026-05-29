import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────────
const API_TOKEN = process.env.PAGERDUTY_API_TOKEN;
if (!API_TOKEN) {
  console.error(
    '❌ Missing PAGERDUTY_API_TOKEN in .env\n' +
      '   Create one at: https://support.pagerduty.com/main/docs/api-access-keys\n' +
      '   You need a REST API v2 token with full access.',
  );
  process.exit(1);
}

const BASE_URL = 'https://api.pagerduty.com';

const headers: Record<string, string> = {
  Authorization: `Token token=${API_TOKEN}`,
  'Content-Type': 'application/json',
  Accept: 'application/vnd.pagerduty+json;version=2',
};

// ─── API helpers ─────────────────────────────────────────────
async function pdGet<T = any>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function pdPost<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function pdPut<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Helpers ─────────────────────────────────────────────────
interface PagerDutyService {
  id: string;
  name: string;
  html_url: string;
}

interface PagerDutyUser {
  id: string;
  email: string;
  name: string;
}

interface PagerDutyPolicy {
  id: string;
  name: string;
}

interface PagerDutyPriority {
  id: string;
  name: string;
}

interface PagerDutyIncident {
  id: string;
  html_url: string;
  title: string;
  status: string;
  urgency: string;
}

async function getCurrentUser(): Promise<PagerDutyUser> {
  try {
    // Try /users/me first (works for user-level tokens)
    const data = await pdGet<{ user: PagerDutyUser }>('/users/me');
    return data.user;
  } catch (error) {
    // Fall back to listing all users and taking the first one (works for account-level tokens)
    console.log('   ⚠️ /users/me failed, falling back to /users (account-level token detected)');
    const data = await pdGet<{ users: PagerDutyUser[] }>('/users', { limit: '1' });
    if (!data.users || data.users.length === 0) {
      throw new Error('No users found in this PagerDuty account to associate incidents with.');
    }
    return data.users[0];
  }
}

async function findOrCreateService(): Promise<PagerDutyService> {
  // List existing services
  console.log('🔍 Looking for existing services…');
  const data = await pdGet<{ services: PagerDutyService[] }>('/services', { limit: '100' });

  // Try to find a "payments-service" or similar
  let svc = data.services.find(
    (s) => s.name.toLowerCase().includes('payment') || s.name.toLowerCase().includes('harbourmaster'),
  );
  if (svc) {
    console.log(`   ✅ Found service: "${svc.name}" (${svc.id})`);
    return svc;
  }

  // Use the first available service if any exist
  if (data.services.length > 0) {
    svc = data.services[0];
    console.log(`   ✅ Using existing service: "${svc.name}" (${svc.id})`);
    return svc;
  }

  // Need to create a service — first we need an escalation policy
  console.log('   📦 No services found. Creating "payments-service"…');
  const policyData = await pdGet<{ escalation_policies: PagerDutyPolicy[] }>('/escalation_policies', {
    limit: '1',
  });

  let policyId: string;
  if (policyData.escalation_policies.length > 0) {
    policyId = policyData.escalation_policies[0].id;
    console.log(`   📋 Using escalation policy: "${policyData.escalation_policies[0].name}"`);
  } else {
    // Create a default escalation policy
    const user = await getCurrentUser();
    console.log(`   📋 Creating default escalation policy…`);
    const epResult = await pdPost<{ escalation_policy: PagerDutyPolicy }>('/escalation_policies', {
      escalation_policy: {
        type: 'escalation_policy',
        name: 'Default (Harbourmaster)',
        escalation_rules: [
          {
            escalation_delay_in_minutes: 30,
            targets: [
              {
                id: user.id,
                type: 'user_reference',
              },
            ],
          },
        ],
      },
    });
    policyId = epResult.escalation_policy.id;
  }

  const createResult = await pdPost<{ service: PagerDutyService }>('/services', {
    service: {
      type: 'service',
      name: 'payments-service',
      description: 'Harbourmaster seed — Payment processing service',
      escalation_policy: {
        id: policyId,
        type: 'escalation_policy_reference',
      },
      alert_creation: 'create_alerts_and_incidents',
    },
  });

  console.log(`   ✅ Created service: "${createResult.service.name}" (${createResult.service.id})`);
  return createResult.service;
}

async function getPriorities(): Promise<PagerDutyPriority[]> {
  try {
    const data = await pdGet<{ priorities: PagerDutyPriority[] }>('/priorities');
    return data.priorities || [];
  } catch {
    return [];
  }
}

async function createIncident(
  serviceId: string,
  fromEmail: string,
  opts: {
    title: string;
    urgency: 'high' | 'low';
    priorityName?: string;
    body?: string;
  },
  priorities: PagerDutyPriority[],
): Promise<PagerDutyIncident> {
  const incidentBody: Record<string, any> = {
    incident: {
      type: 'incident',
      title: opts.title,
      service: {
        id: serviceId,
        type: 'service_reference',
      },
      urgency: opts.urgency,
      body: {
        type: 'incident_body',
        details: opts.body || opts.title,
      },
    },
  };

  // Attach priority if available
  if (opts.priorityName && priorities.length > 0) {
    const priority = priorities.find((p) =>
      p.name.toLowerCase().includes(opts.priorityName!.toLowerCase()),
    );
    if (priority) {
      incidentBody.incident.priority = {
        id: priority.id,
        type: 'priority_reference',
      };
    }
  }

  const data = await pdPost<{ incident: PagerDutyIncident }>('/incidents', incidentBody);
  return data.incident;
}

async function resolveIncident(
  incidentId: string,
  fromEmail: string,
): Promise<PagerDutyIncident> {
  const data = await pdPut<{ incident: PagerDutyIncident }>(`/incidents/${incidentId}`, {
    incident: {
      type: 'incident_reference',
      status: 'resolved',
    },
  });
  return data.incident;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Seeding PagerDuty with test incidents…\n');

  // Step 1 — Get current user (for 'From' header)
  const user = await getCurrentUser();
  console.log(`👤 Authenticated as: ${user.name} (${user.email})\n`);

  // We need the From header for incident creation
  headers['From'] = user.email;

  // Step 2 — Find or create a service
  const service = await findOrCreateService();
  console.log();

  // Step 3 — Load priorities
  const priorities = await getPriorities();
  if (priorities.length > 0) {
    console.log(`📊 Found ${priorities.length} priority levels: ${priorities.map((p) => p.name).join(', ')}`);
  } else {
    console.log('📊 No priority levels configured (incidents will use urgency only)');
  }
  console.log();

  // Step 4 — Create Incident 1: Resolved P3 ("yesterday")
  console.log('📝 Creating Incident 1: Database connection pool exhausted (resolved)…');
  const incident1 = await createIncident(
    service.id,
    user.email,
    {
      title: 'Database connection pool exhausted',
      urgency: 'low', // P3 → low urgency
      priorityName: 'P3',
      body:
        'PostgreSQL connection pool on payments-db-replica-02 reached maximum capacity (50/50 connections). ' +
        'Application threads blocked waiting for available connections. Auto-scaling triggered but failed to ' +
        'allocate new connections within the 30s timeout. Impact: ~12% of checkout requests returned 503 errors ' +
        'for approximately 8 minutes. Root cause: long-running analytics query holding connections open.',
    },
    priorities,
  );
  console.log(`   ✅ Created: ${incident1.title}`);
  console.log(`   🔗 ${incident1.html_url}`);

  // Resolve it
  console.log('   🔄 Resolving incident…');
  const resolved1 = await resolveIncident(incident1.id, user.email);
  console.log(`   ✅ Status: ${resolved1.status}\n`);

  // Step 5 — Create Incident 2: Active P2 (high urgency)
  console.log('📝 Creating Incident 2: Auth service degraded (active)…');
  const incident2 = await createIncident(
    service.id,
    user.email,
    {
      title: 'Auth service degraded — elevated 5xx responses',
      urgency: 'high', // P2 → high urgency
      priorityName: 'P2',
      body:
        'Auth service (auth-prod-us-east-1) returning elevated 5xx error rates. ' +
        'Current error rate: 23% (baseline: <0.1%). Affected endpoints: /oauth/token, /api/v2/sessions. ' +
        'Impact: Users unable to log in or refresh sessions. Downstream services (payments, checkout, dashboard) ' +
        'experiencing cascading failures. Last deploy: payments-service@2.4.1-rc.3 rolled out 45 minutes ago.',
    },
    priorities,
  );
  console.log(`   ✅ Created: ${incident2.title}`);
  console.log(`   🔗 ${incident2.html_url}`);
  console.log(`   ⚡ Status: ${incident2.status} | Urgency: ${incident2.urgency}\n`);

  // Summary
  console.log('─'.repeat(60));
  console.log('✅ PagerDuty seeding complete!\n');
  console.log('   Incident 1 (Resolved): ' + incident1.html_url);
  console.log('   Incident 2 (Active):   ' + incident2.html_url);
  console.log('\n📊 View all incidents: https://app.pagerduty.com/incidents');
}

main().catch((err) => {
  console.error('💥 Seeding failed:', err);
  process.exit(1);
});
