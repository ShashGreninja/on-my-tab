import assert from 'node:assert/strict';
import test from 'node:test';
import { paypalSandbox } from '../src/paypal.ts';
import type { Purchase } from '../src/store.ts';

test('PayPal adapter keeps payer details private and uses stable operation IDs', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const response = {
    id: 'PAYPAL-ORDER', status: 'APPROVED',
    payer: { email_address: 'private-buyer@example.test' },
    links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER' }],
    purchase_units: [{
      reference_id: 'purchase-1', payee: { merchant_id: 'DEMO-MERCHANT', email_address: 'merchant@example.test' },
      amount: { value: '5.00', currency_code: 'USD' },
    }],
  };
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).endsWith('/token') ? { access_token: 'test-token', expires_in: 300 } : response);
  };
  const provider = paypalSandbox('sandbox-client', 'sandbox-secret', undefined, transport);
  const purchase: Purchase = {
    id: 'purchase-1', owner_id: 'alice', offer_id: 'test-credits', merchant: 'DEMO-MERCHANT',
    cents: 500, currency: 'USD', credits: 100, status: 'approval_required',
  };
  await provider.createOrder(purchase, 'https://approval.example.test/return');
  await provider.captureOrder('PAYPAL-ORDER', purchase.id);
  await provider.captureOrder('PAYPAL-ORDER', purchase.id);
  const keys = calls.slice(1).map(call => new Headers(call.init?.headers).get('PayPal-Request-Id'));
  assert.ok(keys.every(Boolean));
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[1], keys[2]);
  assert.doesNotMatch(JSON.stringify(await provider.getOrder('PAYPAL-ORDER')), /private-buyer|merchant@example/);
  assert.ok(calls.every(call => call.url.startsWith('https://api-m.sandbox.paypal.com/')));
});
