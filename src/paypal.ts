import { createHash } from 'node:crypto';
import { z } from 'zod';
import { formatUsd, type Purchase } from './store.ts';

export interface ProviderOrder {
  id: string;
  status: string;
  reference: string;
  merchant: string;
  total: string;
  currency: string;
  captures: { id: string; status: string; total: string; currency: string }[];
}

export interface PayPal {
  createOrder(purchase: Purchase, returnUrl: string): Promise<{ id: string; approvalUrl: string }>;
  getOrder(id: string): Promise<ProviderOrder>;
  captureOrder(id: string, requestId: string): Promise<void>;
  verifyWebhook(headers: Record<string, unknown>, event: unknown): Promise<boolean>;
}

const money = z.object({ value: z.string(), currency_code: z.string() });
const providerOrder = z.object({
  id: z.string(), status: z.string(),
  purchase_units: z.array(z.object({
    reference_id: z.string(), payee: z.object({ merchant_id: z.string() }), amount: money,
    payments: z.object({ captures: z.array(z.object({ id: z.string(), status: z.string(), amount: money })).optional() }).optional(),
  })).length(1),
});
const createdOrder = z.object({ id: z.string(), links: z.array(z.object({ rel: z.string(), href: z.string() })) });

export function paypalSandbox(clientId: string, clientSecret: string, webhookId?: string, transport = fetch): PayPal {
  const base = 'https://api-m.sandbox.paypal.com';
  let token: { value: string; expiry: number } | undefined;

  async function accessToken() {
    if (token && Date.now() < token.expiry) return token.value;
    const response = await transport(base + '/v1/oauth2/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) throw new Error('PayPal authentication failed');
    const data = z.object({ access_token: z.string(), expires_in: z.number() }).safeParse(await response.json());
    if (!data.success) throw new Error('invalid PayPal authentication response');
    token = { value: data.data.access_token, expiry: Date.now() + Math.max(0, data.data.expires_in - 60) * 1000 };
    return token.value;
  }

  async function call(path: string, body?: unknown, idempotency?: string) {
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json', Prefer: 'return=representation',
    };
    if (idempotency) headers['PayPal-Request-Id'] = idempotency;
    const response = await transport(base + path, {
      method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) token = undefined;
    if (!response.ok) throw new Error('PayPal request failed with HTTP ' + response.status);
    return response.json() as Promise<unknown>;
  }

  function key(operation: string, id: string) {
    return createHash('sha256').update(operation + ':' + id).digest('hex').slice(0, 36);
  }

  return {
    async createOrder(purchase, returnUrl) {
      const response = createdOrder.safeParse(await call('/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: purchase.id,
          payee: { merchant_id: purchase.merchant },
          amount: { currency_code: purchase.currency, value: formatUsd(purchase.cents) },
        }],
        payment_source: { paypal: { experience_context: {
          shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: returnUrl,
          cancel_url: returnUrl.replace(/\/return$/, ''),
        } } },
      }, key('create', purchase.id)));
      if (!response.success) throw new Error('invalid PayPal create response');
      const href = response.data.links.find(link => link.rel === 'payer-action' || link.rel === 'approve')?.href;
      return { id: response.data.id, approvalUrl: href ? safePayPalUrl(href) : '' };
    },
    async getOrder(id) {
      const result = providerOrder.safeParse(await call('/v2/checkout/orders/' + encodeURIComponent(id)));
      if (!result.success) throw new Error('invalid PayPal order response');
      const { status, purchase_units: [unit] } = result.data;
      return {
        id: result.data.id, status, reference: unit.reference_id, merchant: unit.payee.merchant_id,
        total: unit.amount.value, currency: unit.amount.currency_code,
        captures: (unit.payments?.captures ?? []).map(capture => ({
          id: capture.id, status: capture.status, total: capture.amount.value, currency: capture.amount.currency_code,
        })),
      };
    },
    async captureOrder(id, requestId) {
      await call('/v2/checkout/orders/' + encodeURIComponent(id) + '/capture', {}, key('capture', requestId));
    },
    async verifyWebhook(headers, event) {
      if (!webhookId) return false;
      const signature: Record<string, string> = {};
      const names = { auth_algo: 'auth-algo', cert_url: 'cert-url', transmission_id: 'transmission-id',
        transmission_sig: 'transmission-sig', transmission_time: 'transmission-time' };
      for (const [field, header] of Object.entries(names)) {
        const value = headers['paypal-' + header];
        if (typeof value !== 'string' || !value) return false;
        signature[field] = value;
      }
      const result = z.object({ verification_status: z.string() }).safeParse(await call(
        '/v1/notifications/verify-webhook-signature',
        { ...signature, webhook_id: webhookId, webhook_event: event },
      ));
      return result.success && result.data.verification_status === 'SUCCESS';
    },
  };
}

function safePayPalUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== 'https://www.sandbox.paypal.com' || url.username || url.password) {
    throw new Error('unexpected PayPal approval origin');
  }
  return url.href;
}
