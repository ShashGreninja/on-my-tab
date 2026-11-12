# ADR-001 — Keep PayPal checkout outside the agent harness

Status: Implemented for the sandbox prototype. The local simulated flow is tested. Hosted provider acceptance requires sandbox credentials.

## Decision

Build a payment handoff for developers whose coding agents hit a limit on a paid tool. Start with one sandbox merchant, one fixed-price credit pack, and a demo API that consumes credits. Use TypeScript throughout, React for the approval and audit views, and one managed Render Postgres database. Keep the code in one repository with separate runtime credentials for each service.

| Component | Responsibility |
| --- | --- |
| MCP web service on Render | Expose `request_purchase(offer_id)` and `get_purchase_status(request_id)` over Streamable HTTP. Validate scoped MCP OAuth tokens and check workspace and request ownership on every call. Its database role can create a pending request and read sanitized status. |
| Checkout web service on Render | Show the pending request in a separate human session, create the PayPal order from the frozen offer, and redirect the buyer to PayPal. Accept and verify PayPal webhooks. Serve the authenticated owner dashboard. |
| Render Workflows | Capture an approved PayPal order, reconcile uncertain results, and fulfill the credit pack. Separate the audit indexing task so Elastic downtime cannot delay fulfillment. Pass internal IDs to workflows and return safe status codes. |
| Render Postgres | Store offers, purchase requests, PayPal order and capture references, processed webhook IDs, credit grants, and pending jobs. Store the minimal fields needed to reconcile a payment. |
| Elasticsearch and AG Studio | Index approved audit fields for search and analysis. Present an access-controlled timeline of approval, capture, and fulfillment, with a custom widget showing the fields disclosed to the agent. |

The MCP bearer token grants only request and status access. It cannot authenticate to the human checkout site. The approval site uses a distinct session on its own origin and can be opened on a phone outside the harness. An opaque request ID or link identifies a purchase and carries no approval authority. The MCP service has no PayPal secret or access to private payment tables. Its strict response schema allows an app request ID, a status, and a fixed-origin approval page link when needed. It returns fixed error codes. PayPal login, funding details, payer identity, and provider payloads are excluded from tool results, app logs, workflow arguments and results, and search. Audit events are built from an allowlist at the source. If the user gives a harness access to the checkout browser or pastes payment details into its chat, that access is outside this boundary.

## Payment lifecycle

1. Codex sees the demo API's quota error and requests a known offer. The server freezes the merchant, price in minor units, currency, and credit quantity. Repeated requests for the same offer reuse its existing open request for that buyer. A fresh purchase requires its own approval.
2. The developer signs into the approval site and reviews those terms. A server-side PayPal Orders v2 call creates and stores an order for those terms, with a stable `PayPal-Request-Id` for the create operation. Only the authenticated owner can start checkout. Each request binds to one provider order, and any change to the terms requires a new request.
3. The buyer approves on PayPal. The browser return and verified webhook can both prompt reconciliation. The worker loads the stored PayPal order and checks its provider state, seller, and total before attempting capture. Browser parameters and webhook delivery alone cannot authorize fulfillment. Capture uses its own stable `PayPal-Request-Id`. Only a verified `COMPLETED` capture for the expected order, seller, amount, and currency qualifies. A pending or ambiguous result stays in reconciliation. If a request times out, look up the existing order and capture before retrying. Respect the endpoint's idempotency window. After it expires, unresolved attempts go to review instead of automatically starting a new order or capture.
4. In one Postgres transaction, record the completed capture, insert the credit grant, update purchase status, and append an audit event. Unique constraints on the request and capture IDs prevent a second credit grant. `get_purchase_status` returns `credits_available` only after that transaction commits. An old or repeated webhook cannot regress the state.

Sources: [PayPal Orders capture](https://developer.paypal.com/api/orders/v2/orders-capture/), [PayPal REST requests](https://developer.paypal.com/api/make-api-requests), [PayPal webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Recovery and growth

- When checkout or a verified webhook changes payment state, write the pending job in the same database transaction. A dispatcher claims pending jobs using leases and calls Render Workflows. Retry failed dispatches with backoff. The webhook endpoint acknowledges delivery only after it records the verified event and any pending job. A scheduled sweep finds expired leases, failed runs, and unresolved orders. A dispatched task can run twice, so the worker must be safe to retry independently of the dispatcher.
- Keep web services stateless so Render can run more replicas without sticky sessions. Bound workflow concurrency and pool database connections. Track the oldest pending job, uncertain captures, and indexing lag. The purchase path reads authoritative status from Postgres even when search is down. Elastic can be rebuilt from the sanitized audit events.
- For a live rollout, enable point-in-time recovery on managed Postgres and rehearse restoring into a separate instance. After a restore, reconcile PayPal against the restored ledger before resuming money-moving jobs. Adding sellers is a separate milestone and requires the relevant PayPal onboarding. The sandbox prototype assumes one merchant and one checkout currency.

Sources: [Render Workflows](https://render.com/docs/workflows), [Render Workflow limits](https://render.com/docs/workflows-limits), [Render private networking](https://render.com/docs/private-network), [Render Postgres backups](https://render.com/docs/postgresql-backups), [PayPal Platforms](https://developer.paypal.com/platforms/overview).

## Test plan

| Test | Evidence | Codex quota |
| --- | --- | --- |
| Automated MCP contract and Postgres integration tests with a fake PayPal adapter | Run as two users. Reject cross-user reads, unknown fields, altered order terms, unapproved capture, and forged webhooks. Check response and error schemas, application logs, and the search document for a seeded synthetic payer email. | Zero |
| Recovery and concurrency tests using the same database schema and worker as deployment | Force a crash after PayPal accepts capture but before Postgres commits, replay a webhook, race two workers, and simulate a Render dispatch failure and an Elastic outage. One completed capture grants one pack. Pending or mismatched captures grant zero. Successful fulfillment remains visible while indexing catches up. | Zero |
| PayPal Sandbox end to end using MCP Inspector or a scripted MCP client | Request an offer, complete checkout with a sandbox buyer, and consume a newly granted credit on the demo API. Check the capture and grant, replay the verified event, and inspect the actual MCP response. Use sandbox merchant and buyer accounts. | Zero |
| Small load run against a fake provider | Send concurrent requests from distinct buyers and repeat delivery of the same events. Record latency, queue drain time, and duplicate capture/grant counts. Report the measured load with its environment. | Zero |
| Short Codex acceptance run | A real agent encounters the quota error, chooses the offer, waits for the developer to approve on a separate device, checks status after the user signals approval, and finishes the task. Record this flow. | Uses Codex quota |

The judge demo should include a scripted route so anyone can reproduce the PayPal Sandbox flow without Codex access. Label scripted and live-agent runs separately. Start with the real sandbox path early to validate the account configuration, then use the fake adapter for routine tests. [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) · [PayPal Sandbox](https://developer.paypal.com/sandbox-testing/overview)

## Sponsor targets

- **PayPal and Best Use of Agentic Commerce.** Show a real agent recognizing a paid dependency and resuming the job after a human approves the exact PayPal purchase. Best Use of PayPal + AI is also relevant. [Official prize rules](https://paypalaihackathon.devpost.com/rules)
- **AG Grid, primary sponsor prize.** Use AG Studio with a custom payment timeline and disclosure widget. Connect the Studio Agent Framework to read-only, workspace-scoped queries so an owner can ask why a top-up is still pending or what data was shared. Show the same request before and after fulfillment. [AG Grid sponsor brief](https://paypalaihackathon.devpost.com/details/aggrid)
- **Render, second sponsor prize target.** Host the app and database on Render. In Workflows, show a retried reconciliation task completing with one credit grant. [Render sponsor brief](https://paypalaihackathon.devpost.com/details/render)
- **Elastic, integration target.** Use Elasticsearch and ES|QL on sanitized events to find payment requests stuck in reconciliation and repeated denied access. Feed those results to AG Studio through the owner service. Devpost lists Elastic as a partner, with no separate Elastic prize in the published table. [Elastic sponsor brief](https://paypalaihackathon.devpost.com/details/elastic) · [Official prize rules](https://paypalaihackathon.devpost.com/rules)

The published rules cap awards at one sponsor prize alongside either one grand prize or one honorable mention. Prioritize the PayPal flow, Render recovery, and AG Studio views before adding another sponsor.
