# Payment Access

A developer's coding agent can request a PayPal top-up when a paid tool runs out of credits. The developer reviews and approves the purchase in a separate browser session. The agent gets a purchase status and can resume its task after fulfillment. The sandbox demo sells 100 demo API credits for $5 in test money.

## Run without Codex or PayPal credentials

Use Node.js 24.18+ and run:

```sh
npm ci
npm run demo
```

In another terminal:

```sh
npm run demo:client
```

Open the approval link from the CLI. Sign in as **demo** with the local approval key **local-demo-human-only-key**. Continue to checkout, then choose **Simulate buyer approval**. Press Enter in the CLI to see the new credits unblock the check. Visit [the local audit dashboard](http://localhost:3000/audit) to see the timeline and the tool fields disclosed to the agent.

This mode uses a simulated provider and a temporary PostgreSQL instance through PGlite. Restarting clears the demo. It binds to loopback. The simulated provider cannot charge anything.

```sh
npm run check
npm test
npm run build
npm run test:browser
```

The tests use no model calls. The HTTP integration test opens two temporary loopback ports. PayPal adapter tests use injected provider responses. The suite also checks the PostgreSQL grants and a lost response after capture. The browser test uses installed Chrome by default. Set `PLAYWRIGHT_CHANNEL=msedge` for Edge.

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

## Deploy the sandbox

The [architecture record](docs/decisions/001-payment-access-layer.md) describes the boundaries and failure cases.

1. Provision Render Postgres in the same region as the app and Workflow. Create two distinct login roles named `payment_agent` and `payment_checkout`. Keep the database private once setup is finished. Run `npm run migrate` with `ADMIN_DATABASE_URL` and the sandbox `PAYPAL_MERCHANT_ID`. The migration grants least-privilege access to each role.
2. Import `render.yaml`. Use the restricted agent database connection string for MCP and the checkout role connection string for the checkout service and Workflow. Set `CHECKOUT_ORIGIN` to the exact HTTPS origin of the checkout service on both web services. Supply the Render API key and Workflow slug for the dispatcher. Set strong, distinct keys with `AGENT_KEYS` and `HUMAN_KEYS`, each a JSON object mapping the same account ID to a different random key. The human signs in with the account ID and its approval key. The MCP service can also validate OAuth JWTs from a configured issuer using `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, and `MCP_RESOURCE_URL`. The JWT must have the MCP audience, the `purchases:agent` scope, and an account ID in `sub` matching the human account. Configure OAuth client registration with your identity provider.
3. Register `/paypal/webhook` on the checkout origin with the sandbox app. Subscribe to `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, and `PAYMENT.CAPTURE.PENDING`. Set the webhook ID on Render. The scheduled sweep keeps the database queue moving if an immediate Workflow dispatch fails.
4. Create the Elastic index `payment-access-audit` using `db/elastic-mapping.json`. Set `ELASTIC_URL` and an API key with read/write access to this index. Audit events are indexed by stable ID. The dashboard can read scoped ES|QL results, and payment fulfillment continues if Elastic is offline.
5. Set the AG Studio trial or commercial license in `AG_STUDIO_LICENSE` for the hosted demo. AG Studio renders the timeline and disclosure widgets. Its dashboard assistant answers two common questions from the authenticated audit view using a deterministic runner. Codex is the AI agent in the purchase demo.

The hosted configuration is for sandbox transactions. The demo is scoped to one seller and one offer. The script and test suite do not need a Codex subscription, Elastic credentials, or an AG Studio license to exercise the payment flow.
