import { randomUUID } from 'node:crypto';
import { formatUsd } from './store.ts';
import type { PayPal, ProviderOrder } from './paypal.ts';

export function fakePayPal(): PayPal & { approve(id: string): void } {
  const orders = new Map<string, ProviderOrder>();
  function find(id: string) {
    const order = orders.get(id);
    if (!order) throw new Error('unknown simulated order');
    return order;
  }
  return {
    async createOrder(purchase, returnUrl) {
      const id = 'FAKE-' + purchase.id;
      if (!orders.has(id)) orders.set(id, {
        id, status: 'CREATED', reference: purchase.id, merchant: purchase.merchant,
        total: formatUsd(purchase.cents), currency: purchase.currency, captures: [],
      });
      return { id, approvalUrl: returnUrl.replace(/\/return$/, '') };
    },
    approve(id) {
      const order = find(id);
      if (order.status === 'CREATED') order.status = 'APPROVED';
    },
    async getOrder(id) { return structuredClone(find(id)); },
    async captureOrder(id) {
      const order = find(id);
      if (order.status === 'COMPLETED') return;
      if (order.status !== 'APPROVED') throw new Error('approval required');
      order.captures = [{ id: randomUUID(), status: 'COMPLETED', total: order.total, currency: order.currency }];
      order.status = 'COMPLETED';
    },
    async verifyWebhook() { return false; },
  };
}
