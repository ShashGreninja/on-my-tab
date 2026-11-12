import { formatUsd, type Purchase } from './store.ts';

function page(title: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Payment Access</title><link rel="stylesheet" href="/assets/checkout.css"></head><body>
  <header><a href="/audit">Payment Access</a></header><main><article><h1>${title}</h1>${content}</article></main></body></html>`;
}

export function loginPage(next: string, failed = false) {
  return page('Sign in to approve purchases', `
  <p>Use the approval credentials for your workspace.</p>
  ${failed ? '<p role="alert">Those credentials did not match.</p>' : ''}
  <form action="/session" method="post"><input type="hidden" name="next" value="${next}">
  <label>Workspace account<input name="owner" autocomplete="username" required></label>
  <label>Approval key<input name="key" type="password" autocomplete="current-password" required></label>
  <button>Sign in</button></form>`);
}

const descriptions = {
  approval_required: 'Review the credit pack before opening checkout.',
  processing: 'Payment is being verified. Refresh this page to check again.',
  credits_available: 'The credit pack is available. You can return to your coding task.',
  needs_review: 'This purchase needs review before credits can be issued.',
};

export function approvalPage(purchase: Purchase, simulate: boolean) {
  const action = purchase.status === 'approval_required'
    ? `<form method="post" action="/approval/${purchase.id}/${simulate ? 'simulate' : 'start'}">
        <button>${simulate ? 'Simulate buyer approval' : 'Continue to PayPal'}</button></form>`
    : purchase.status === 'processing' ? `<a href="/approval/${purchase.id}">Refresh status</a>` : '';
  return page(purchase.status === 'credits_available' ? 'Credits available' : 'Review credit top-up',
    `<p>${descriptions[purchase.status]}</p><dl><div><dt>Demo API credits</dt><dd>${purchase.credits}</dd></div>
    <div><dt>Total</dt><dd>$${formatUsd(purchase.cents)} USD</dd></div></dl>${action}
    <p class="note">Sandbox purchase · Test money only</p>`);
}

export function messagePage(title: string, detail: string) {
  return page(title, `<p>${detail}</p>`);
}
