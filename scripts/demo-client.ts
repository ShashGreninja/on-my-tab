import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:' + (process.env.LOCAL_AGENT_PORT ?? 3001) + '/mcp';
const key = process.env.LOCAL_AGENT_KEY ?? 'local-demo-agent-only-key';
if (!url.startsWith('http://127.0.0.1:') && !process.env.LOCAL_AGENT_KEY) {
  throw new Error('Set LOCAL_AGENT_KEY for the hosted sandbox');
}
const client = new Client({ name: 'model-free-payment-demo', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: 'Bearer ' + key } },
}));
const io = createInterface({ input: process.stdin, output: process.stdout });
try {
  const initial = await client.callTool({ name: 'run_demo_check' });
  const { status } = z.object({ status: z.string() }).parse(initial.structuredContent);
  if (status === 'completed') {
    console.log('The demo check completed using an existing credit.');
  } else {
    const request = await client.callTool({ name: 'request_purchase', arguments: { offer_id: 'test-credits' } });
    const purchase = z.object({ request_id: z.uuid(), status: z.string(), approval_url: z.url().optional() }).parse(request.structuredContent);
    console.log('Demo API quota exhausted.');
    console.log(purchase);
    if (process.argv.includes('--request-only')) process.exitCode = 0;
    else {
      if (purchase.approval_url) await io.question('Open the approval link and complete checkout, then press Enter. ');
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await client.callTool({ name: 'get_purchase_status', arguments: { request_id: purchase.request_id } });
        const data = z.object({ status: z.string() }).parse(result.structuredContent);
        if (data.status === 'needs_review') throw new Error('The purchase needs review');
        if (data.status === 'credits_available') { ready = true; break; }
        await delay(2000);
      }
      if (!ready) throw new Error('Credits are still pending; check the approval page');
      const final = await client.callTool({ name: 'run_demo_check' });
      if (z.object({ status: z.literal('completed') }).parse(final.structuredContent)) {
        console.log('Credits available. The demo check completed.');
      }
    }
  }
} finally {
  io.close();
  await client.close();
}
