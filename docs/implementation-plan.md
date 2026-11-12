# Payment access layer implementation plan

The [architecture decision](decisions/001-payment-access-layer.md) defines the security boundary and sponsor roles. The first release buys one sandbox credit pack and resumes a demo API task.

- Implement the PostgreSQL ledger and reconciler. Prove that a lost capture response, concurrent reconciliation, and unapproved or mismatched orders cannot grant duplicate or unpaid credits.
- Add separately authenticated MCP and browser checkout services. Exercise both over HTTP with the official MCP client and a simulated provider. Implement the PayPal Sandbox adapter and test the provider contract.
- Add Render dispatch and recovery, Elastic audit indexing, and the AG Studio owner dashboard. Document the deployment and run the model-free judge demo before a short Codex acceptance run.
