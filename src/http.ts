import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler, Request } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { PayPal } from './paypal.ts';
import { operationWindowMs, reconcile } from './reconcile.ts';
import { formatUsd, type PaymentStore } from './store.ts';
import { approvalPage, loginPage, messagePage } from './pages.ts';

type Keys = ReadonlyMap<string, string>;
const uuid = z.uuid();
const statusSchema = z.enum(['approval_required', 'processing', 'credits_available', 'needs_review']);
const purchaseOutput = z.strictObject({ request_id: uuid, status: statusSchema, approval_url: z.url().optional() });

function equal(a: string, b: string) {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function appBase() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    next();
  });
  return app;
}

const safeError: ErrorRequestHandler = (error: { status?: number }, _req, res, next) => {
  if (res.headersSent) return next(error);
  const code = error.status === 413 ? 413 : error.status === 400 ? 400 : 503;
  res.status(code).json({ error: code === 503 ? 'temporarily_unavailable' : 'invalid_request' });
};

export function createAgentApp(config: {
  store: PaymentStore; approvalOrigin: string; agentKeys: Keys; authenticate?: (token: string) => Promise<string | undefined>;
  oauth?: { resource: string; issuer: string };
}) {
  const { store, approvalOrigin } = config;
  const app = appBase();
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  const metadataPath = '/.well-known/oauth-protected-resource/mcp';
  if (config.oauth) app.get(metadataPath, (_req, res) => {
    res.json({ resource: config.oauth!.resource, authorization_servers: [config.oauth!.issuer],
      scopes_supported: ['purchases:agent'], bearer_methods_supported: ['header'] });
  });
  app.post('/mcp', express.json({ limit: '32kb' }), async (req, res) => {
    // MCP CLI clients do not send Origin. Block browser origins on this endpoint.
    if (req.headers.origin) { res.sendStatus(403); return; }
    const token = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
    const owner = token && ([...config.agentKeys].find(([, key]) => equal(key, token))?.[0]
      ?? await config.authenticate?.(token));
    if (!owner) {
      const challenge = config.oauth ? 'Bearer resource_metadata="' + new URL(metadataPath, config.oauth.resource).href + '", scope="purchases:agent"'
        : 'Bearer realm="payment-access"';
      res.set('WWW-Authenticate', challenge).sendStatus(401);
      return;
    }

    const mcp = new McpServer({ name: 'payment-access', version: '0.1.0' });
    function ok(data: Record<string, unknown>) {
      return { structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    }
    function fail(code: string) {
      return { isError: true, content: [{ type: 'text' as const, text: code }] };
    }
    async function protect(fn: () => Promise<ReturnType<typeof ok> | ReturnType<typeof fail>>) {
      try { return await fn(); } catch { return fail('temporarily_unavailable'); }
    }

    mcp.registerTool('request_purchase', {
      title: 'Request a PayPal credit top-up',
      description: 'Request the test-credits offer for the demo API. The human approves and pays in a separate checkout. Present the link and wait for the human before checking status.',
      inputSchema: z.strictObject({ offer_id: z.enum(['test-credits']) }),
      outputSchema: purchaseOutput,
      annotations: { idempotentHint: true, destructiveHint: false },
    }, ({ offer_id }) => protect(async () => {
      const request = await store.request(owner, offer_id);
      if (!request) return fail('offer_unavailable');
      const data = purchaseOutput.parse({
        request_id: request.id, status: request.status,
        ...(request.status === 'approval_required' ? { approval_url: new URL('/approval/' + request.id, approvalOrigin).href } : {}),
      });
      await store.auditResponse(request.id, request.status, Object.keys(data));
      return ok(data);
    }));
    mcp.registerTool('get_purchase_status', {
      title: 'Check credit top-up status',
      description: 'Check one purchase request. Resume the demo task when the status is credits_available.',
      inputSchema: z.strictObject({ request_id: uuid }),
      outputSchema: purchaseOutput,
      annotations: { readOnlyHint: true },
    }, ({ request_id }) => protect(async () => {
      const request = await store.status(owner, request_id);
      if (!request) return fail('request_not_found');
      const data = purchaseOutput.parse({ request_id: request.id, status: request.status });
      await store.auditResponse(request.id, request.status, Object.keys(data));
      return ok(data);
    }));
    mcp.registerTool('run_demo_check', {
      title: 'Run the demo build check',
      description: 'Use one credit to run a deterministic demo check. When quota_exhausted is returned, test-credits is the supported top-up offer.',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ status: z.enum(['completed', 'quota_exhausted']), offer_id: z.string().optional() }),
      annotations: { destructiveHint: false },
    }, () => protect(async () => {
      if (!await store.consume(owner)) return ok({ status: 'quota_exhausted', offer_id: 'test-credits' });
      return ok({ status: 'completed' });
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => { res.set('Allow', 'POST').sendStatus(405); });
  app.use(safeError);
  return app;
}

export function createCheckoutApp(config: {
  store: PaymentStore; provider: PayPal & { approve?(id: string): void }; humanKeys: Keys;
  sessionSecret: string; origin?: string; fake: boolean; kick: () => Promise<unknown>;
  studioLicense?: string; auditInsights?: (requestIds: string[]) => Promise<unknown>;
}) {
  const { store, provider } = config;
  const app = appBase();
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  const signingKey = config.sessionSecret;
  const origin = (req: Request) => config.origin ?? 'http://' + req.get('host');
  const sign = (value: string) => createHmac('sha256', signingKey).update(value).digest('base64url');
  function human(req: Request) {
    const cookie = /(?:^|;\s*)approval_session=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:;|$)/.exec(req.get('cookie') ?? '');
    if (!cookie || !equal(sign(cookie[1]), cookie[2])) return;
    const payload = z.tuple([z.string(), z.number()]).safeParse(
      JSON.parse(Buffer.from(cookie[1], 'base64url').toString('utf8')),
    );
    if (payload.success && payload.data[1] > Date.now() && config.humanKeys.has(payload.data[0])) return payload.data[0];
  }
  function sameOrigin(req: Request) { return req.get('origin') === origin(req); }
  function safeNext(value: unknown) {
    return typeof value === 'string' && (/^\/approval\/[0-9a-f-]{36}$/.test(value) || value === '/audit') ? value : '/audit';
  }
  function wake() {
    // The database already holds the job if the immediate wakeup fails.
    void config.kick().catch(() => {});
  }
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/', (_req, res) => { res.redirect('/audit'); });
  app.get('/assets/checkout.css', (_req, res) => {
    res.sendFile(fileURLToPath(new URL('./checkout.css', import.meta.url)));
  });
  app.post('/session', (req, res) => {
    if (!sameOrigin(req)) { res.sendStatus(403); return; }
    const { owner, key, next } = req.body ?? {};
    const expected = typeof owner === 'string' ? config.humanKeys.get(owner) : undefined;
    if (typeof key !== 'string' || !expected || !equal(expected, key)) {
      res.status(401).type('html').send(loginPage(safeNext(next), true));
      return;
    }
    const value = Buffer.from(JSON.stringify([owner, Date.now() + 60 * 60 * 1000])).toString('base64url');
    res.cookie('approval_session', value + '.' + sign(value), {
      httpOnly: true, sameSite: 'lax', secure: origin(req).startsWith('https:'), maxAge: 60 * 60 * 1000, path: '/',
    });
    res.redirect(303, safeNext(next));
  });

  app.get('/approval/:id', async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) { res.sendStatus(404); return; }
    const owner = human(req);
    if (!owner) { res.type('html').send(loginPage('/approval/' + id.data)); return; }
    const purchase = await store.purchase(owner, id.data);
    if (!purchase) { res.sendStatus(404); return; }
    const payment = config.fake ? await store.payment(id.data, owner) : undefined;
    res.type('html').send(approvalPage(purchase, Boolean(payment?.provider_order_id), req.query.checking === '1'));
  });

  app.post('/approval/:id/start', async (req, res) => {
    const owner = human(req);
    if (!owner) { res.sendStatus(401); return; }
    if (!sameOrigin(req)) { res.sendStatus(403); return; }
    const id = uuid.safeParse(req.params.id);
    if (!id.success) { res.sendStatus(404); return; }
    const payment = await store.beginOrder(id.data, owner);
    if (!payment) { res.sendStatus(404); return; }
    if (payment.status !== 'approval_required') { res.redirect(303, '/approval/' + id.data); return; }
    if (Date.now() - payment.order_started_at.getTime() >= operationWindowMs) {
      await store.review(id.data);
      res.redirect(303, '/approval/' + id.data);
      return;
    }
    const order = await provider.createOrder(payment, new URL('/approval/' + id.data + '/return', origin(req)).href);
    await store.bindOrder(id.data, order.id);
    if (!order.approvalUrl) wake();
    res.redirect(303, order.approvalUrl || '/approval/' + id.data);
  });

  app.get('/approval/:id/return', async (req, res) => {
    const owner = human(req);
    if (!owner) { res.status(401).type('html').send(messagePage('Session expired', 'Sign in from the original approval link to check this purchase.')); return; }
    const id = uuid.safeParse(req.params.id);
    if (!id.success) { res.sendStatus(404); return; }
    const payment = await store.payment(id.data, owner);
    if (!payment?.provider_order_id || req.query.token !== payment.provider_order_id) { res.sendStatus(404); return; }
    await store.schedule(owner, id.data);
    wake();
    res.redirect(303, '/approval/' + id.data + '?checking=1');
  });

  if (config.fake) app.post('/approval/:id/simulate', async (req, res) => {
    const owner = human(req);
    if (!owner) { res.sendStatus(401); return; }
    if (!sameOrigin(req)) { res.sendStatus(403); return; }
    const id = uuid.safeParse(req.params.id);
    if (!id.success) { res.sendStatus(404); return; }
    const payment = await store.payment(id.data, owner);
    if (!payment?.provider_order_id) { res.sendStatus(404); return; }
    provider.approve?.(payment.provider_order_id);
    await reconcile(store, provider, id.data);
    res.redirect(303, '/approval/' + id.data);
  });

  app.post('/paypal/webhook', express.json({ limit: '128kb' }), async (req, res) => {
    if (!await provider.verifyWebhook(req.headers, req.body)) { res.sendStatus(401); return; }
    const event = z.object({ id: z.string(), event_type: z.string(), resource: z.object({
      id: z.string().optional(), supplementary_data: z.object({ related_ids: z.object({ order_id: z.string() }).optional() }).optional(),
    }) }).safeParse(req.body);
    if (event.success) {
      const { id, event_type: kind, resource } = event.data;
      const order = kind === 'CHECKOUT.ORDER.APPROVED' ? resource.id
        : kind === 'PAYMENT.CAPTURE.COMPLETED' || kind === 'PAYMENT.CAPTURE.PENDING'
          ? resource.supplementary_data?.related_ids?.order_id : undefined;
      if (order && await store.webhook(id, order, kind === 'PAYMENT.CAPTURE.COMPLETED')) wake();
    }
    res.sendStatus(204);
  });

  app.get('/audit', (req, res) => {
    if (!human(req)) { res.type('html').send(loginPage('/audit')); return; }
    res.sendFile(fileURLToPath(new URL('../dist/index.html', import.meta.url)));
  });
  app.get('/audit/data', async (req, res) => {
    const owner = human(req);
    if (!owner) { res.sendStatus(401); return; }
    const events = await store.audit(owner);
    res.json({ events, credits: await store.balance(owner), studioLicense: config.studioLicense ?? '' });
  });
  app.get('/audit/insights', async (req, res) => {
    const owner = human(req);
    if (!owner) { res.sendStatus(401); return; }
    const events = await store.audit(owner);
    const ids = [...new Set(events.map(event => event.request_id))];
    res.json(config.auditInsights ? await config.auditInsights(ids) : { configured: false, rows: [] });
  });
  app.use('/assets', express.static(fileURLToPath(new URL('../dist/assets/', import.meta.url)), { index: false }));
  app.use(safeError);
  return app;
}
