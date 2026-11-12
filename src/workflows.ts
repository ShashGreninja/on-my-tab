import { task } from '@renderinc/sdk/workflows';
import { connect, elasticFromEnv, sandboxProvider } from './runtime.ts';
import { reconcileBatch } from './reconcile.ts';

task({ name: 'reconcile', timeoutSeconds: 90, retry: { maxRetries: 3, waitDurationMs: 35_000 } }, async () => {
  const { store, pool } = connect();
  try { return { checked: await reconcileBatch(store, sandboxProvider()) }; }
  finally { await pool.end(); }
});

task({ name: 'indexAudit', timeoutSeconds: 90 }, async () => {
  const { store, pool } = connect();
  try {
    const elastic = elasticFromEnv();
    return { indexed: elastic ? await elastic.indexEvents(store) : 0 };
  } finally { await pool.end(); }
});
