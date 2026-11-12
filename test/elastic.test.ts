import assert from 'node:assert/strict';
import test from 'node:test';
import { createElastic } from '../src/elastic.ts';
import { PaymentStore } from '../src/store.ts';
import type { Database } from '../src/store.ts';

test('Elastic indexes only approved fields and searches only the supplied request IDs', async () => {
  const requestId = '8476f600-0aa2-40d8-83eb-e2213d7c2cbf';
  const eventId = 'd23e359d-1314-4ee7-8709-4fe6d0209a1e';
  const stored = {
    id: eventId, request_id: requestId, kind: 'agent_response', status: 'approval_required',
    disclosed_fields: ['request_id', 'status'], occurred_at: new Date('2026-11-12T12:00:00Z'),
    payer_email: 'canary@example.test',
  };
  const writes: unknown[][] = [];
  const database: Database = {
    async query<Row>(sql: string, parameters?: unknown[]) {
      if (sql.startsWith('SELECT')) return { rows: [stored as Row] };
      writes.push(parameters ?? []);
      return { rows: [] };
    },
  };
  const calls: { url: string; data: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), data: JSON.parse(String(init?.body)) });
    return Response.json(String(url).endsWith('/_query') ? { values: [['approval_required', 1]] } : {});
  };
  const elastic = createElastic('https://search.example.test', 'test', transport);
  assert.equal(await elastic.indexEvents(new PaymentStore(database)), 1);
  assert.deepEqual(writes, [[eventId]]);
  assert.deepEqual(Object.keys(calls[0].data).sort(), ['disclosed_fields', 'kind', 'occurred_at', 'request_id', 'status']);
  assert.deepEqual(await elastic.insights([requestId]), { configured: true, rows: [['approval_required', 1]] });
  assert.match(String(calls[1].data.query), new RegExp(requestId));
  await assert.rejects(elastic.insights(['invalid syntax']));
  assert.equal(calls.length, 2);
});
