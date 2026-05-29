import 'dotenv/config';
import * as Sentry from '@sentry/node';

// ─── Config ──────────────────────────────────────────────────
const DSN = process.env.SENTRY_DSN;
if (!DSN) {
  console.error(
    '❌ Missing SENTRY_DSN in .env\n' +
      '   Find it at: Sentry → Project Settings → Client Keys (DSN)\n' +
      '   Example: https://abc123@o123456.ingest.sentry.io/7890123',
  );
  process.exit(1);
}

Sentry.init({
  dsn: DSN,
  environment: 'staging',
  release: 'payments-service@2.4.1-rc.3',
  tracesSampleRate: 1.0,
});

// ─── Error definitions ───────────────────────────────────────
interface SeedError {
  type: string;
  message: string;
  level: Sentry.SeverityLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

const errors: SeedError[] = [
  // ── Fatal errors ───────────────────────────────────────────
  {
    type: 'TypeError',
    message: "Cannot read properties of undefined (reading 'stripe_customer_id')",
    level: 'fatal',
    tags: { module: 'checkout', handler: 'processPayment' },
    extra: { userId: 'usr_8a2f3e', cartTotal: 149.99, currency: 'USD' },
  },
  {
    type: 'Error',
    message: 'FATAL: Payment gateway connection pool exhausted — 0/50 connections available',
    level: 'fatal',
    tags: { module: 'gateway', provider: 'stripe' },
    extra: { poolSize: 50, activeConnections: 50, waitingRequests: 312 },
  },
  {
    type: 'Error',
    message: 'Database transaction deadlock detected in payments table — automatic retry failed after 3 attempts',
    level: 'fatal',
    tags: { module: 'database', table: 'payments' },
    extra: { retryCount: 3, lockTimeout: 5000, transactionId: 'txn_9xk2m' },
  },

  // ── Network / Timeout errors ───────────────────────────────
  {
    type: 'TimeoutError',
    message: 'Stripe API request timed out after 30000ms — POST /v1/payment_intents',
    level: 'error',
    tags: { module: 'stripe-client', endpoint: '/v1/payment_intents' },
    extra: { timeout: 30000, method: 'POST', idempotencyKey: 'idk_7fn2a9' },
  },
  {
    type: 'NetworkError',
    message: 'ECONNREFUSED 10.0.3.42:5432 — unable to reach payments-db replica',
    level: 'error',
    tags: { module: 'database', host: '10.0.3.42' },
    extra: { port: 5432, database: 'payments_prod', sslEnabled: true },
  },
  {
    type: 'FetchError',
    message: 'request to https://api.stripe.com/v1/charges failed, reason: socket hang up',
    level: 'error',
    tags: { module: 'stripe-client', endpoint: '/v1/charges' },
    extra: { retryAttempt: 2, lastStatusCode: null },
  },
  {
    type: 'TimeoutError',
    message: 'Redis BRPOP timed out waiting for payment-events queue after 60s',
    level: 'error',
    tags: { module: 'queue', queue: 'payment-events' },
    extra: { timeoutSeconds: 60, redisHost: 'redis-payments.internal' },
  },

  // ── Type / Reference errors ────────────────────────────────
  {
    type: 'TypeError',
    message: "amount.toFixed is not a function — received type 'string' instead of number",
    level: 'error',
    tags: { module: 'pricing', handler: 'calculateTax' },
    extra: { receivedValue: '49.99', expectedType: 'number' },
  },
  {
    type: 'ReferenceError',
    message: 'currencyFormatter is not defined — missing import in refund-processor.ts',
    level: 'error',
    tags: { module: 'refunds', file: 'refund-processor.ts' },
  },
  {
    type: 'TypeError',
    message: "Cannot destructure property 'payment_method' of 'req.body' as it is null",
    level: 'error',
    tags: { module: 'api', route: 'POST /api/v2/payments' },
    extra: { contentType: 'application/json', bodySize: 0 },
  },
  {
    type: 'RangeError',
    message: 'Invalid currency code "USDT" — expected ISO 4217 format',
    level: 'error',
    tags: { module: 'validation', handler: 'validateCurrency' },
    extra: { input: 'USDT', supportedCurrencies: ['USD', 'EUR', 'GBP', 'JPY', 'CAD'] },
  },

  // ── Business logic errors ──────────────────────────────────
  {
    type: 'Error',
    message: 'Idempotency conflict — payment idk_3xm9p2 already processed with different parameters',
    level: 'error',
    tags: { module: 'idempotency', handler: 'checkIdempotencyKey' },
    extra: {
      idempotencyKey: 'idk_3xm9p2',
      originalAmount: 99.99,
      duplicateAmount: 149.99,
    },
  },
  {
    type: 'Error',
    message: 'Webhook signature verification failed — possible replay attack on /webhooks/stripe',
    level: 'error',
    tags: { module: 'webhooks', provider: 'stripe' },
    extra: { endpoint: '/webhooks/stripe', signatureHeader: 'whsec_...' },
  },
  {
    type: 'Error',
    message: 'Payment declined — card_declined: insufficient_funds (card ending 4242)',
    level: 'error',
    tags: { module: 'checkout', declineCode: 'insufficient_funds' },
    extra: { last4: '4242', brand: 'visa', amount: 299.0 },
  },
  {
    type: 'Error',
    message: 'Refund amount $350.00 exceeds original charge $299.99 for charge ch_3Nq9',
    level: 'error',
    tags: { module: 'refunds', handler: 'processRefund' },
    extra: { chargeId: 'ch_3Nq9', originalAmount: 299.99, refundAmount: 350.0 },
  },
  {
    type: 'Error',
    message: 'Rate limit exceeded — 429 from Stripe API (1200 requests/min limit hit)',
    level: 'error',
    tags: { module: 'stripe-client', statusCode: '429' },
    extra: { rateLimit: 1200, windowSeconds: 60, retryAfter: 12 },
  },
  {
    type: 'SyntaxError',
    message: 'Unexpected token < in JSON at position 0 — Stripe returned HTML error page',
    level: 'error',
    tags: { module: 'stripe-client', endpoint: '/v1/invoices' },
    extra: { responseContentType: 'text/html', expectedContentType: 'application/json' },
  },
  {
    type: 'Error',
    message: 'Currency conversion failed — exchange rate API returned stale data (last updated 26h ago)',
    level: 'error',
    tags: { module: 'pricing', handler: 'convertCurrency' },
    extra: { fromCurrency: 'GBP', toCurrency: 'USD', lastUpdated: '2026-05-24T00:15:00Z' },
  },
];

// ─── Stack trace builder ─────────────────────────────────────
function buildStack(type: string, message: string): string {
  const frames = [
    `    at processPayment (src/services/payments/processor.ts:142:11)`,
    `    at ChargeHandler.execute (src/handlers/charge-handler.ts:87:25)`,
    `    at StripeClient.createPaymentIntent (src/clients/stripe.ts:63:18)`,
    `    at async PaymentRouter.handlePost (src/routes/payments.ts:34:9)`,
    `    at async Layer.handle (node_modules/express/lib/router/layer.js:95:5)`,
    `    at async Router.dispatch (node_modules/express/lib/router/index.js:284:7)`,
  ];
  return `${type}: ${message}\n${frames.join('\n')}`;
}

// ─── Helpers ─────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): number {
  return Math.floor(Math.random() * 301) + 200; // 200-500ms
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Seeding Sentry with realistic payment-service errors…\n');
  console.log(`   DSN:         ${DSN!.replace(/\/\/(.+?)@/, '//<key>@')}`);
  console.log(`   Environment: staging`);
  console.log(`   Release:     payments-service@2.4.1-rc.3`);
  console.log(`   Errors:      ${errors.length}\n`);

  for (let i = 0; i < errors.length; i++) {
    const err = errors[i];
    const delay = randomDelay();

    // Build a proper Error object with a realistic stack
    const error = new Error(err.message);
    error.name = err.type;
    error.stack = buildStack(err.type, err.message);

    Sentry.withScope((scope) => {
      scope.setLevel(err.level);
      scope.setTag('service', 'payments-service');

      if (err.tags) {
        for (const [k, v] of Object.entries(err.tags)) {
          scope.setTag(k, v);
        }
      }
      if (err.extra) {
        for (const [k, v] of Object.entries(err.extra)) {
          scope.setExtra(k, v);
        }
      }

      Sentry.captureException(error);
    });

    const icon = err.level === 'fatal' ? '💀' : '🔴';
    console.log(
      `${icon} [${i + 1}/${errors.length}] ${err.level.toUpperCase().padEnd(5)} ${err.type}: ${err.message.slice(0, 80)}${err.message.length > 80 ? '…' : ''}`,
    );

    await sleep(delay);
  }

  console.log('\n⏳ Flushing events to Sentry…');
  const flushed = await Sentry.close(10000);
  if (flushed) {
    console.log('✅ All errors sent successfully!');
  } else {
    console.warn('⚠️  Some events may not have been sent (flush timed out)');
  }

  console.log('\n📊 Check your Sentry dashboard for the new issues.');
}

main().catch((err) => {
  console.error('💥 Seeding failed:', err);
  process.exit(1);
});
