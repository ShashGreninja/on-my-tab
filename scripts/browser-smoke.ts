import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAgentApp, createCheckoutApp } from '../src/http.ts';
import { fakePayPal } from '../src/fake-paypal.ts';
import { PaymentStore } from '../src/store.ts';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const store = new PaymentStore(db);
const checkout = createCheckoutApp({
  store, provider: fakePayPal(), humanKeys: new Map([['demo', 'human-browser-test-key']]),
  sessionSecret: 'test-only-session-secret', fake: true, kick: async () => {},
}).listen(0, '127.0.0.1');
await once(checkout, 'listening');
const approvalAddress = checkout.address();
assert.ok(approvalAddress && typeof approvalAddress !== 'string');
const origin = 'http://127.0.0.1:' + approvalAddress.port;
const agent = createAgentApp({
  store, approvalOrigin: origin, agentKeys: new Map([['demo', 'agent-browser-test-key']]),
}).listen(0, '127.0.0.1');
await once(agent, 'listening');
const agentAddress = agent.address();
assert.ok(agentAddress && typeof agentAddress !== 'string');
const client = new Client({ name: 'browser-smoke', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + agentAddress.port + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer agent-browser-test-key' } },
  }));
  const { structuredContent } = await client.callTool({ name: 'request_purchase', arguments: { offer_id: 'test-credits' } });
  const { approval_url, request_id } = structuredContent as { approval_url: string; request_id: string };
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(approval_url);
    assert.equal(await page.title(), 'Sign in | on my tab');
    assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), '/assets/on-my-tab.svg');
    const logo = page.getByRole('link', { name: 'on my tab', exact: true }).locator('img');
    assert.equal(await logo.evaluate(async (image: HTMLImageElement) => {
      await image.decode();
      return image.naturalWidth > 0;
    }), true);
    await page.getByLabel('Workspace account').fill('demo');
    await page.getByLabel('Approval key').fill('human-browser-test-key');
    const [login] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/session'),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    assert.equal(login.status(), 303);
    await page.getByRole('button', { name: 'Continue to PayPal' }).click();
    await page.getByRole('button', { name: 'Simulate buyer approval' }).click();
    await page.getByRole('heading', { name: 'Credits available' }).waitFor();
    const status = await client.callTool({ name: 'get_purchase_status', arguments: { request_id } });
    assert.deepEqual(status.structuredContent, { request_id, status: 'credits_available' });
    await page.goto(origin + '/audit');
    assert.equal(await page.title(), 'Payment audit | on my tab');
    await page.getByRole('link', { name: 'on my tab', exact: true }).waitFor();
    const disclosure = page.getByRole('combobox', { name: 'Tool response' });
    await disclosure.waitFor();
    await page.getByRole('heading', { name: 'Purchase timeline' }).waitFor();
    const completedResponse = await disclosure.inputValue();
    await page.getByRole('button', { name: /Inspect agent response/, pressed: false }).click();
    assert.notEqual(await disclosure.inputValue(), completedResponse);
    await page.getByRole('code').filter({ hasText: 'approval_url' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.getByRole('button', { name: 'Open audit studio' }).click();
    await page.getByRole('button', { name: 'Agent visibility' }).waitFor();
    await page.getByRole('button', { name: 'Back to audit activity' }).click();
    await disclosure.waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(origin + '/audit');
    await page.getByRole('heading', { name: 'Purchase timeline' }).waitFor();
    await page.getByRole('heading', { name: 'What the agent saw' }).waitFor();
    await page.getByRole('strong').filter({ hasText: 'Credits granted' }).waitFor();
    await page.getByRole('code').filter({ hasText: 'request_id' }).waitFor();
    const composer = await page.getByPlaceholder('Ask the AI Assistant...').boundingBox();
    const studio = await page.locator('#audit-studio').boundingBox();
    assert.ok(composer && studio && composer.y + composer.height <= studio.y + studio.height);
    await page.getByRole('button', { name: 'Agent visibility' }).click();
    await page.getByText('The latest agent response contained request_id, status.').waitFor();
    assert.deepEqual(errors, []);
    console.log('Mobile checkout, responsive audit, and desktop AG Studio assistant passed in Chromium.');
  } finally { await browser.close(); }
} finally {
  await client.close();
  checkout.close();
  agent.close();
  await db.close();
}
