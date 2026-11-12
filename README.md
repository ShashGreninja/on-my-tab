# On My Tab

Your coding agent hits an API quota halfway through a task. On My Tab lets it request a top-up over MCP. You review the purchase and approve it on PayPal. Once the server verifies the payment, the agent gets its credits and can retry the task.

The agent sees a request ID, an approval link, and a purchase status. PayPal credentials and payer details stay outside the agent's tools. The demo sells one pack of 100 API credits for $5 in test money. Each purchase requires your approval.

## Try it locally

Use Node.js 24.18+ and run:

```sh
npm ci
npm run demo
```

In another terminal:

```sh
npm run demo:client
```

Open the approval link from the CLI and sign in as `demo` with the key `local-demo-human-only-key`. Continue to checkout and choose **Simulate buyer approval**. Press Enter in the CLI to retry the blocked check. The [audit dashboard](http://localhost:3000/audit) shows the purchase timeline and the fields the agent received.

The local demo uses a simulated payment provider and a temporary PostgreSQL database. It needs no Codex subscription or PayPal credentials. Restarting clears the demo data.

## How it works

- **MCP** lets the agent request a known offer and check the result. A separate browser session handles buyer approval.
- **PayPal** processes the sandbox payment. PostgreSQL records the capture and grants the credits in one transaction. If a response gets lost after capture, the worker checks the existing order before it retries.
- **Render Workflows** runs payment reconciliation and audit indexing as separate jobs. **Elastic** indexes the approved audit fields, and **AG Studio** shows the purchase timeline and what the agent received.

## Run PayPal Sandbox

Copy `.env.example` to `.env` and set `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_MERCHANT_ID` for a sandbox business account. Run the same demo and sign in to PayPal with a separate **sandbox personal account**. The return page and a local sweep both trigger verification. For the full webhook flow, use the hosted checkout service and register its HTTPS webhook URL. The provider API base is fixed to Sandbox.

## Connect Codex for one acceptance run

Add this to your Codex MCP configuration, or use equivalent MCP client settings:

```toml
[mcp_servers.payment_access]
url = "http://127.0.0.1:3001/mcp"
bearer_token_env_var = "PAYMENT_ACCESS_AGENT_KEY"
```

Set the named environment variable to the local agent key, **local-demo-agent-only-key** by default. For the hosted sandbox use its HTTPS MCP URL and your provisioned agent key. Use a fresh demo account with zero credits and ask Codex to run the demo check. If it runs out of credits, it should request the test-credits offer and show the approval link. Approve from a phone or browser outside the harness, then tell Codex to check status and finish the task. Keep the approval key, PayPal credentials, and checkout browser session outside the harness. Run the scripted demo for repeat tests and use Codex for the recording.

## Deploy a simulated preview

Create a Render Blueprint using `render.preview.yaml`. It runs the dashboard and MCP on one free web service. Render generates separate keys for the approval page and MCP. In the service's **Environment** settings, use `PREVIEW_APPROVAL_KEY` to sign in as `demo` and `PREVIEW_AGENT_KEY` as the MCP bearer token. The dashboard is at `/audit` and the MCP endpoint is at `/mcp` on the same Render URL.

To run the CLI against the hosted preview, set `MCP_URL` to the Render URL ending in `/mcp` and `LOCAL_AGENT_KEY` to the preview agent key. Then run `npm run demo:client`. The preview uses simulated payments and clears its data on restart.

## Deploy the PayPal Sandbox stack

The [architecture record](docs/decisions/001-payment-access-layer.md) describes the boundaries and failure cases.

1. Provision Render Postgres in the same region as the app and Workflow. Create two distinct login roles named `payment_agent` and `payment_checkout`. Keep the database private once setup is finished. Run `npm run migrate` with `ADMIN_DATABASE_URL` and the sandbox `PAYPAL_MERCHANT_ID`. The migration grants least-privilege access to each role.
2. Import `render.yaml`. Use the restricted agent database connection string for MCP and the checkout role connection string for the checkout service and Workflow. Set `CHECKOUT_ORIGIN` to the exact HTTPS origin of the checkout service on both web services. Supply the Render API key and Workflow slug for the dispatcher. Set strong, distinct keys with `AGENT_KEYS` and `HUMAN_KEYS`, each a JSON object mapping the same account ID to a different random key. The human signs in with the account ID and its approval key. The MCP service can also validate OAuth JWTs from a configured issuer using `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, and `MCP_RESOURCE_URL`. The JWT must have the MCP audience, the `purchases:agent` scope, and an account ID in `sub` matching the human account. Configure OAuth client registration with your identity provider.
3. Register `/paypal/webhook` on the checkout origin with the sandbox app. Subscribe to `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, and `PAYMENT.CAPTURE.PENDING`. Set the webhook ID on Render. The scheduled sweep keeps the database queue moving if an immediate Workflow dispatch fails.
4. Create the Elastic index `payment-access-audit` using `db/elastic-mapping.json`. Set `ELASTIC_URL` and an API key with read/write access to this index. Audit events are indexed by stable ID. The dashboard can read scoped ES|QL results, and payment fulfillment continues if Elastic is offline.
5. Set the AG Studio trial or commercial license in `AG_STUDIO_LICENSE` for the hosted demo. AG Studio renders the timeline and disclosure widgets. Its dashboard assistant answers two common questions from the authenticated audit view using a deterministic runner. Codex is the AI agent in the purchase demo.

The hosted configuration is for sandbox transactions. The demo is scoped to one seller and one offer. The script and test suite do not need a Codex subscription, Elastic credentials, or an AG Studio license to exercise the payment flow.

## Tests

`npm test` exercises the MCP boundary, PostgreSQL permissions, duplicate events, and recovery after a lost capture response. It uses simulated PayPal responses. Run `npm run check` for TypeScript and `npm run test:browser` for checkout and the audit dashboard in Chrome. Set `PLAYWRIGHT_CHANNEL=msedge` to use Edge.

## License

Project source is available under the [MIT license](LICENSE). AG Studio and the bundled Geist font retain their own licenses.
