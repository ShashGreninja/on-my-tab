import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { PaymentStore } from '../src/store.ts';
import { reconcile } from '../src/reconcile.ts';
import type { PayPal, ProviderOrder } from '../src/paypal.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const store = new PaymentStore(database);
  const request = await store.request('alice', 'test-credits');
  assert.ok(request);
  await store.beginOrder(request.id, 'alice');
  await store.bindOrder(request.id, 'ORDER-1');
  const order: ProviderOrder = {
    id: 'ORDER-1', status: 'APPROVED', reference: request.id,
    merchant: 'DEMO-MERCHANT', total: '5.00', currency: 'USD', captures: [],
  };
  let calls = 0;
  const provider: PayPal = {
    createOrder: async () => { throw new Error('unexpected create'); },
    verifyWebhook: async () => false,
    getOrder: async () => structuredClone(order),
    captureOrder: async () => {
      calls++;
      order.status = 'COMPLETED';
      order.captures = [{ id: 'CAPTURE-1', status: 'COMPLETED', total: '5.00', currency: 'USD' }];
      throw new Error('connection lost after capture');
    },
  };
  return { store, request, provider, order, calls: () => calls };
}

test('recovers a capture with a lost response and fulfills once under a race', async t => {
  const { store, request, provider, calls } = await fixture(t);
  await assert.rejects(reconcile(store, provider, request.id), /connection lost/);
  assert.equal(await store.balance('alice'), 0);
  await Promise.all([reconcile(store, provider, request.id), reconcile(store, provider, request.id)]);
  assert.equal(calls(), 1);
  assert.equal(await store.balance('alice'), 100);
  assert.equal((await store.status('alice', request.id))?.status, 'credits_available');
  assert.equal(await store.status('bob', request.id), undefined);
  assert.equal(await store.consume('alice'), true);
  assert.equal(await store.balance('alice'), 99);
});

test('pending captures and mismatched terms never grant credits', async t => {
  const { store, request, provider, order, calls } = await fixture(t);
  order.status = 'CREATED';
  assert.equal(await reconcile(store, provider, request.id), 'pending');
  order.status = 'COMPLETED';
  order.captures = [{ id: 'CAPTURE-1', status: 'PENDING', total: '5.00', currency: 'USD' }];
  assert.equal(await reconcile(store, provider, request.id), 'pending');
  assert.equal(await store.balance('alice'), 0);
  order.captures = [];
  order.status = 'APPROVED';
  order.total = '50.00';
  assert.equal(await reconcile(store, provider, request.id), 'review');
  assert.equal(calls(), 0);
  assert.equal(await store.balance('alice'), 0);
});

test('a verified late capture can resolve a purchase held for review', async t => {
  const { store, request, provider, order, calls } = await fixture(t);
  await store.review(request.id);
  assert.equal(await reconcile(store, provider, request.id), 'done');
  assert.equal(calls(), 0);
  order.status = 'COMPLETED';
  order.captures = [{ id: 'CAPTURE-1', status: 'COMPLETED', total: '5.00', currency: 'USD' }];
  await store.webhook('COMPLETE-1', 'ORDER-1', true);
  assert.equal(await reconcile(store, provider, request.id), 'done');
  assert.equal(await store.balance('alice'), 100);
});

test('a repeated request reuses an open purchase and webhook IDs are deduplicated', async t => {
  const { store, request } = await fixture(t);
  assert.equal((await store.request('alice', 'test-credits'))?.id, request.id);
  assert.equal(await store.webhook('EVENT-1', 'ORDER-1'), true);
  assert.equal(await store.webhook('EVENT-1', 'ORDER-1'), false);
});

test('a worker can recover an expired lease without accepting a stale release', async t => {
  const { store, request } = await fixture(t);
  const [first] = await store.claimJobs();
  assert.equal(first.request_id, request.id);
  assert.deepEqual(await store.claimJobs(), []);
  await store.db.query("UPDATE payment_orders SET lease_until = now() - interval '1 second'");
  const [replacement] = await store.claimJobs();
  assert.notEqual(first.lease_token, replacement.lease_token);
  await store.releaseJob(request.id, first.lease_token, false);
  assert.deepEqual(await store.claimJobs(), []);
  await store.releaseJob(request.id, replacement.lease_token, false);
  assert.deepEqual(await store.claimJobs(), []);
});
