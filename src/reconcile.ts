import type { PayPal, ProviderOrder } from './paypal.ts';
import { formatUsd, type PaymentStore } from './store.ts';

// Leave headroom inside the provider's documented six-hour default window.
export const operationWindowMs = 5 * 60 * 60 * 1000;

export async function reconcile(store: PaymentStore, provider: PayPal, id: string) {
  const payment = await store.payment(id);
  if (!payment?.provider_order_id || payment.status === 'credits_available' || payment.status === 'needs_review') return 'done';

  const expected = formatUsd(payment.cents);
  const matches = (order: ProviderOrder) =>
    order.id === payment.provider_order_id && order.reference === id &&
    order.merchant === payment.merchant && order.currency === payment.currency && order.total === expected;
  const review = async () => {
    await store.review(id);
    return 'review';
  };

  let order = await provider.getOrder(payment.provider_order_id);
  if (!matches(order)) return review();

  if (order.status === 'APPROVED' && order.captures.length === 0) {
    const started = await store.startCapture(id);
    if (!started || Date.now() - started.getTime() >= operationWindowMs) return review();
    await provider.captureOrder(order.id, id);
    // Read the canonical order after capture, including its immutable purchase unit.
    order = await provider.getOrder(order.id);
    if (!matches(order)) return review();
  }

  if (order.captures.length > 1) return review();
  const capture = order.captures[0];
  if (capture?.status === 'COMPLETED') {
    if (capture.total !== expected || capture.currency !== payment.currency) return review();
    await store.fulfill(id, capture.id);
    return 'done';
  }
  if (capture && capture.status !== 'PENDING') return review();
  if (order.status === 'VOIDED' || Date.now() - payment.order_started_at.getTime() >= operationWindowMs) return review();
  return 'pending';
}

export async function reconcileBatch(store: PaymentStore, provider: PayPal) {
  const jobs = await store.claimJobs();
  const results = await Promise.allSettled(jobs.map(async job => {
    let retry = true;
    try {
      retry = await reconcile(store, provider, job.request_id) === 'pending';
    } finally {
      await store.releaseJob(job.request_id, job.lease_token, retry);
    }
  }));
  if (results.some(result => result.status === 'rejected')) throw new Error('reconciliation retry scheduled');
  return jobs.length;
}
