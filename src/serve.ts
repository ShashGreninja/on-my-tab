import { createAgentApp, createCheckoutApp } from './http.ts';
import { connect, dispatch, elasticFromEnv, keys, oauthFromEnv, required, sandboxProvider } from './runtime.ts';

const mode = process.argv[2];
const port = Number(process.env.PORT ?? 3000);
const approvalOrigin = required('CHECKOUT_ORIGIN');
const url = new URL(approvalOrigin);
if (url.protocol !== 'https:' || url.origin !== approvalOrigin) throw new Error('CHECKOUT_ORIGIN must be an HTTPS origin');

if (mode === 'agent') {
  const oauth = oauthFromEnv();
  const app = createAgentApp({
    store: connect().store,
    approvalOrigin,
    agentKeys: process.env.AGENT_KEYS ? keys('AGENT_KEYS') : new Map(),
    authenticate: oauth?.verify,
    oauth,
  });
  app.listen(port, '0.0.0.0', () => console.log('MCP server listening'));
} else if (mode === 'checkout') {
  const elastic = elasticFromEnv();
  const sessionSecret = required('APPROVAL_SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('APPROVAL_SESSION_SECRET needs at least 32 characters');
  createCheckoutApp({
    store: connect().store, provider: sandboxProvider(), humanKeys: keys('HUMAN_KEYS'),
    sessionSecret, origin: approvalOrigin, fake: false, kick: () => dispatch('reconcile'),
    studioLicense: process.env.AG_STUDIO_LICENSE,
    auditInsights: elastic?.insights,
  }).listen(port, '0.0.0.0', () => console.log('Checkout server listening'));
} else throw new Error('Use agent or checkout');
