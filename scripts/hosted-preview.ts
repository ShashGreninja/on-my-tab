import { readFile } from 'node:fs/promises';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { fakePayPal } from '../src/fake-paypal.ts';
import { createAgentApp, createCheckoutApp } from '../src/http.ts';
import { reconcileBatch } from '../src/reconcile.ts';
import { PaymentStore } from '../src/store.ts';

const origin = new URL(process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000');
if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
  throw new Error('The hosted preview requires HTTPS');
}
const agentKey = process.env.PREVIEW_AGENT_KEY;
const approvalKey = process.env.PREVIEW_APPROVAL_KEY;
const sessionSecret = process.env.APPROVAL_SESSION_SECRET;
if (!agentKey || !approvalKey || !sessionSecret ||
    [agentKey, approvalKey, sessionSecret].some(key => key.length < 24) ||
    new Set([agentKey, approvalKey, sessionSecret]).size !== 3) {
  throw new Error('Set three distinct preview keys of at least 24 characters');
}

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const store = new PaymentStore(db);
const provider = fakePayPal();
const app = express();
app.disable('x-powered-by');
app.use(createAgentApp({ store, approvalOrigin: origin.origin, agentKeys: new Map([['demo', agentKey]]) }));
app.use(createCheckoutApp({
  store, provider, origin: origin.origin, humanKeys: new Map([['demo', approvalKey]]),
  sessionSecret, fake: true, kick: () => reconcileBatch(store, provider),
}));
app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {
  console.log('On My Tab simulated preview is ready');
});
