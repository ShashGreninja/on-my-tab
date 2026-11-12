import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PaymentStore } from '../src/store.ts';

test('the production MCP role cannot read or write payment records', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await db.exec('CREATE ROLE payment_agent; CREATE ROLE payment_checkout;');
  await db.exec(await readFile(new URL('../db/grants.sql', import.meta.url), 'utf8'));
  await db.exec('SET ROLE payment_agent');
  const store = new PaymentStore(db);
  const request = await store.request('alice', 'test-credits');
  assert.ok(request);
  assert.equal((await store.status('alice', request.id))?.status, 'approval_required');
  await store.auditResponse(request.id, request.status, ['request_id', 'status']);
  assert.equal(await store.consume('alice'), false);
  for (const statement of [
    'SELECT * FROM payment_orders', 'SELECT * FROM credit_grants',
    "UPDATE purchases SET status = 'credits_available'", 'UPDATE balances SET credits = 99',
  ]) {
    await assert.rejects(db.query(statement), /permission denied/);
  }
});
