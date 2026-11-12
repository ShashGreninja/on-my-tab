import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAgentApp, createCheckoutApp } from '../src/http.ts';
import { PaymentStore } from '../src/store.ts';
import { fakePayPal } from '../src/fake-paypal.ts';

test('an MCP identity can request a purchase but only the human session can pay', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const store = new PaymentStore(db);
  const checkout = createCheckoutApp({
    store, provider: fakePayPal(), humanKeys: new Map([['alice', 'human-only-test-key']]),
    sessionSecret: 'test-session-signing-secret', fake: true, kick: async () => {},
  }).listen(0, '127.0.0.1');
  await once(checkout, 'listening');
  const address = checkout.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const agent = createAgentApp({
    store, approvalOrigin: origin, agentKeys: new Map([['alice', 'agent-test-key'], ['bob', 'other-agent-key']]),
  }).listen(0, '127.0.0.1');
  await once(agent, 'listening');
  t.after(() => { checkout.close(); agent.close(); });
  const agentAddress = agent.address();
  assert.ok(agentAddress && typeof agentAddress !== 'string');
  const mcpUrl = 'http://127.0.0.1:' + agentAddress.port + '/mcp';
  async function connect(key: string) {
    const client = new Client({ name: 'quota-free-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: 'Bearer ' + key } },
    }));
    t.after(() => client.close());
    return client;
  }
  const alice = await connect('agent-test-key');
  const result = await alice.callTool({ name: 'request_purchase', arguments: { offer_id: 'test-credits' } });
  const data = result.structuredContent as { request_id: string; approval_url: string };
  assert.deepEqual(Object.keys(data).sort(), ['approval_url', 'request_id', 'status']);
  const bob = await connect('other-agent-key');
  const denied = await bob.callTool({ name: 'get_purchase_status', arguments: { request_id: data.request_id } });
  assert.equal(denied.isError, true);
  const startUrl = data.approval_url + '/start';
  const blocked = await fetch(startUrl, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer agent-test-key' }, redirect: 'manual' });
  assert.equal(blocked.status, 401);
  const login = await fetch(origin + '/session', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ owner: 'alice', key: 'human-only-test-key', next: '/approval/' + data.request_id }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const wrongOrigin = await fetch(startUrl, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://example.com' } });
  assert.equal(wrongOrigin.status, 403);
  const forged = await fetch(origin + '/paypal/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'fake-event', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'fake-order' } }),
  });
  assert.equal(forged.status, 401);
  const start = await fetch(startUrl, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, redirect: 'manual' });
  assert.equal(start.status, 303);
  const paid = await fetch(data.approval_url + '/simulate', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, redirect: 'manual' });
  assert.equal(paid.status, 303);
  const status = await alice.callTool({ name: 'get_purchase_status', arguments: { request_id: data.request_id } });
  assert.deepEqual(status.structuredContent, { request_id: data.request_id, status: 'credits_available' });
  const consumed = await alice.callTool({ name: 'run_demo_check' });
  assert.equal((consumed.structuredContent as { status: string }).status, 'completed');
});
