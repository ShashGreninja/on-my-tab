import pg from 'pg';
import { Render } from '@renderinc/sdk';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { PaymentStore } from './store.ts';
import { paypalSandbox } from './paypal.ts';
import { createElastic } from './elastic.ts';

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('Set ' + name);
  return value;
}

export function connect(name = 'DATABASE_URL') {
  const pool = new pg.Pool({ connectionString: required(name), max: 5, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => { console.error('Database pool connection lost'); });
  const store = new PaymentStore({
    async query<Row>(sql: string, parameters?: unknown[]) {
      const result = await pool.query(sql, parameters);
      return { rows: result.rows as Row[] };
    },
  });
  return { store, pool };
}

export function sandboxProvider() {
  return paypalSandbox(required('PAYPAL_CLIENT_ID'), required('PAYPAL_CLIENT_SECRET'), process.env.PAYPAL_WEBHOOK_ID);
}

export function elasticFromEnv() {
  return process.env.ELASTIC_URL ? createElastic(process.env.ELASTIC_URL, required('ELASTIC_API_KEY')) : undefined;
}

export function keys(name: string) {
  const entries = z.record(z.string().min(1).max(120), z.string().min(24).max(512)).parse(JSON.parse(required(name)));
  if (new Set(Object.values(entries)).size !== Object.keys(entries).length || !Object.keys(entries).length) {
    throw new Error('Each account requires a unique key');
  }
  return new Map(Object.entries(entries));
}

export function oauthFromEnv() {
  if (!process.env.OAUTH_ISSUER) return;
  const issuer = required('OAUTH_ISSUER');
  const resource = required('MCP_RESOURCE_URL');
  const jwks = new URL(required('OAUTH_JWKS_URL'));
  if (new URL(issuer).protocol !== 'https:' || jwks.protocol !== 'https:' || new URL(resource).protocol !== 'https:') {
    throw new Error('OAuth configuration requires HTTPS');
  }
  const keySet = createRemoteJWKSet(jwks);
  return {
    resource, issuer,
    async verify(token: string) {
      try {
        const { payload } = await jwtVerify(token, keySet, {
          issuer, audience: resource, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp'],
        });
        if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('purchases:agent')) return;
        return payload.sub;
      } catch { return undefined; }
    },
  };
}

export async function dispatch(task: 'reconcile' | 'indexAudit') {
  const render = new Render({ token: required('RENDER_API_KEY') });
  await render.workflows.startTask(required('RENDER_WORKFLOW_SLUG') + '/' + task, [], AbortSignal.timeout(10_000));
}
