import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createAgentApp, createCheckoutApp } from '../src/http.ts';
import { fakePayPal } from '../src/fake-paypal.ts';
import { reconcileBatch } from '../src/reconcile.ts';
import { elasticFromEnv, required, sandboxProvider } from '../src/runtime.ts';
import { PaymentStore } from '../src/store.ts';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const store = new PaymentStore(db);
const sandbox = process.env.PAYPAL_MODE === 'sandbox';
if (sandbox) await db.query("UPDATE offers SET merchant = $1 WHERE id = 'test-credits'", [required('PAYPAL_MERCHANT_ID')]);
const provider = sandbox ? sandboxProvider() : fakePayPal();
const elastic = elasticFromEnv();
const agentKey = process.env.LOCAL_AGENT_KEY ?? 'local-demo-agent-only-key';
const humanKey = process.env.LOCAL_APPROVAL_KEY ?? 'local-demo-human-only-key';
if (agentKey === humanKey) throw new Error('Use distinct agent and human keys');
const checkoutPort = Number(process.env.LOCAL_CHECKOUT_PORT ?? 3000);
const agentPort = Number(process.env.LOCAL_AGENT_PORT ?? 3001);
const origin = 'http://localhost:' + checkoutPort;
const kick = () => reconcileBatch(store, provider);
const timer = setInterval(() => {
  void kick().catch(() => {});
  void elastic?.indexEvents(store).catch(() => {});
}, 3000);
timer.unref();

createCheckoutApp({
  store, provider, humanKeys: new Map([['demo', humanKey]]), origin, fake: !sandbox, kick,
  sessionSecret: randomBytes(32).toString('hex'), studioLicense: process.env.AG_STUDIO_LICENSE,
  auditInsights: elastic?.insights,
}).listen(checkoutPort, '127.0.0.1', () => console.log('Approval and audit: ' + origin + '/audit (' + (sandbox ? 'PayPal Sandbox' : 'simulated') + ')'));
createAgentApp({ store, approvalOrigin: origin, agentKeys: new Map([['demo', agentKey]]) })
  .listen(agentPort, '127.0.0.1', () => console.log('MCP: http://127.0.0.1:' + agentPort + '/mcp'));
