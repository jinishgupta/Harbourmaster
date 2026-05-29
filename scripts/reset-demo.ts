import 'dotenv/config';

// ─── PagerDuty Reset ─────────────────────────────────────────
async function resetPagerDuty() {
  const API_TOKEN = process.env.PAGERDUTY_API_TOKEN;
  if (!API_TOKEN) {
    console.log('⚠️ Skipping PagerDuty reset (No API token found)');
    return;
  }

  const BASE_URL = 'https://api.pagerduty.com';
  const headers = {
    Authorization: `Token token=${API_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.pagerduty+json;version=2',
  };

  try {
    console.log('🔄 Fetching active incidents from PagerDuty...');
    const res = await fetch(`${BASE_URL}/incidents?statuses[]=triggered&statuses[]=acknowledged`, { headers });
    const data = await res.json();
    
    if (data.incidents && data.incidents.length > 0) {
      console.log(`🧹 Resolving ${data.incidents.length} active incidents...`);
      for (const inc of data.incidents) {
        await fetch(`${BASE_URL}/incidents/${inc.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ incident: { type: 'incident_reference', status: 'resolved' } })
        });
        console.log(`   ✅ Resolved: ${inc.title}`);
      }
    } else {
      console.log('   ✅ No active PagerDuty incidents to resolve.');
    }
  } catch (err) {
    console.error('❌ Failed to reset PagerDuty:', err);
  }
}

// ─── Linear Reset ────────────────────────────────────────────
async function resetLinear() {
  const API_KEY = process.env.LINEAR_API_KEY;
  if (!API_KEY) {
    console.log('⚠️ Skipping Linear reset (No API key found)');
    return;
  }

  const GRAPHQL_URL = 'https://api.linear.app/graphql';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: API_KEY,
  };

  async function gql(query: string, variables?: any) {
    const res = await fetch(GRAPHQL_URL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    const json = await res.json() as any;
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  try {
    console.log('\n🔄 Looking for Linear label "Release v2.4.1"...');
    // We can delete the label which automatically removes it from all issues
    const data = await gql(`
      query {
        issueLabels(filter: { name: { eq: "Release v2.4.1" } }) {
          nodes { id name }
        }
      }
    `);

    if (data.issueLabels.nodes.length > 0) {
      const labelId = data.issueLabels.nodes[0].id;
      console.log(`🧹 Deleting label "${data.issueLabels.nodes[0].name}"...`);
      await gql(`mutation($id: String!) { issueLabelDelete(id: $id) { success } }`, { id: labelId });
      console.log('   ✅ Label deleted! All associated mock issues are now detached from the release.');
    } else {
      console.log('   ✅ No "Release v2.4.1" label found in Linear.');
    }
  } catch (err) {
    console.error('❌ Failed to reset Linear:', err);
  }
}

async function main() {
  console.log('🧹 Harbourmaster Reset Script');
  console.log('============================\n');
  
  await resetPagerDuty();
  await resetLinear();

  console.log('\n============================');
  console.log('⚠️ SENTRY NOTE: Sentry does not allow resolving issues via the DSN key used for ingestion.');
  console.log('To reset Sentry, please open your Sentry Dashboard, select all issues, and click "Resolve".');
  console.log('✅ Once Sentry is resolved in the UI, your Harbourmaster check will be 100% green again!');
}

main().catch(console.error);
