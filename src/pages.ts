import { formatUsd, type Purchase } from './store.ts';

function page(title: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d0e0f">
  <link rel="icon" type="image/svg+xml" href="/assets/on-my-tab.svg">
  <title>${title} | on my tab</title>
  <link rel="stylesheet" href="/assets/payment-ui.css"><link rel="stylesheet" href="/assets/checkout.css"></head><body>
  <header class="site-header"><div class="site-header-inner">
    <a class="brand" href="/audit"><img class="brand-mark" src="/assets/on-my-tab.svg" alt="" width="28" height="28">on my tab</a>
    <span class="environment">Sandbox</span>
  </div></header>
  <main class="approval-main"><article class="approval-card">${content}</article></main></body></html>`;
}

export function loginPage(next: string, failed = false) {
  return page('Sign in', `
  <div class="approval-intro"><h1>Sign in to on my tab</h1><p>Use the approval credentials for your workspace.</p></div>
  ${failed ? '<p class="form-error" role="alert">Check your workspace account and approval key, then try again.</p>' : ''}
  <form class="approval-form" action="/session" method="post"><input type="hidden" name="next" value="${next}">
  <label>Workspace account<input name="owner" autocomplete="username" required></label>
  <label>Approval key<input name="key" type="password" autocomplete="current-password" required></label>
  <button class="action">Sign in</button></form>`);
}

const descriptions = {
  approval_required: 'Review the credit pack before opening checkout.',
  processing: 'Payment is being verified. Refresh this page to check again.',
  credits_available: 'The credit pack is available. You can return to your coding task.',
  needs_review: 'This purchase needs review before credits can be issued.',
};

const approvalStatuses = {
  approval_required: 'Awaiting approval',
  processing: 'Verifying payment',
  credits_available: 'Credits issued',
  needs_review: 'Needs review',
};

export function approvalPage(purchase: Purchase, simulate: boolean, checking: boolean) {
  const verifying = purchase.status === 'processing' || (checking && purchase.status === 'approval_required');
  const status = verifying ? 'processing' : purchase.status;
  const action = verifying ? `<a class="action action--quiet" href="/approval/${purchase.id}?checking=1">Refresh status</a>`
    : purchase.status === 'approval_required'
    ? `<form class="approval-form" method="post" action="/approval/${purchase.id}/${simulate ? 'simulate' : 'start'}">
        <button class="action">${simulate ? 'Simulate buyer approval' : 'Continue to PayPal'}</button></form>`
    : '';
  const title = status === 'credits_available' ? 'Credits available' : 'Credit top-up';
  return page(title, `
    <div class="approval-intro"><h1>${title}</h1><p>${descriptions[status]}</p></div>
    <div class="approval-status status" data-status="${status}">${approvalStatuses[status]}</div>
    <dl class="payment-card receipt">
      <div class="receipt-total"><dt>Total</dt><dd>$${formatUsd(purchase.cents)} <small>USD</small></dd></div>
      <div><dt>Demo API credits</dt><dd>${purchase.credits}</dd></div>
    </dl>${action}
    <p class="approval-note">Sandbox purchase. Test money only.</p>`);
}

export function messagePage(title: string, detail: string) {
  return page(title, `<div class="approval-intro"><h1>${title}</h1><p>${detail}</p></div>`);
}
