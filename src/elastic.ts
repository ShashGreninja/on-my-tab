import { z } from 'zod';
import type { PaymentStore } from './store.ts';

export function createElastic(base: string, apiKey: string, transport = fetch) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Elastic must use HTTPS');
  const index = 'payment-access-audit';

  async function call(path: string, method: string, body: unknown) {
    const response = await transport(new URL(path, url), {
      method, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: 'ApiKey ' + apiKey, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Elastic request failed');
    return response.json() as Promise<unknown>;
  }

  return {
    async indexEvents(store: PaymentStore) {
      const events = await store.unindexed();
      for (const event of events) {
        await call('/' + index + '/_doc/' + event.id, 'PUT', {
          request_id: event.request_id, kind: event.kind, status: event.status,
          disclosed_fields: event.disclosed_fields, occurred_at: event.occurred_at,
        });
        await store.indexed(event.id);
      }
      return events.length;
    },
    async insights(requestIds: string[]) {
      const ids = z.array(z.uuid()).max(250).parse(requestIds);
      if (!ids.length) return { configured: true, rows: [] };
      // Only UUIDs from the authenticated owner's ledger are interpolated.
      const values = ids.map(id => '"' + id + '"').join(',');
      const result = z.object({
        values: z.array(z.tuple([z.string(), z.number()])),
      }).parse(await call('/_query', 'POST', { query:
        'FROM ' + index + ' | WHERE request_id IN (' + values + ')'
        + ' | STATS purchase_status = LAST(status, occurred_at) BY request_id'
        + ' | STATS purchases = COUNT(*) BY purchase_status | SORT purchases DESC | KEEP purchase_status, purchases',
      }));
      return { configured: true, rows: result.values };
    },
  };
}
