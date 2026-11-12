-- Provision login roles payment_agent and payment_checkout before running this script.
GRANT USAGE ON SCHEMA public TO payment_agent, payment_checkout;
GRANT SELECT ON offers TO payment_agent;
GRANT SELECT (id, owner_id, offer_id, status) ON purchases TO payment_agent;
GRANT INSERT (owner_id, offer_id, merchant, cents, currency, credits) ON purchases TO payment_agent;
GRANT INSERT (request_id, kind, status, disclosed_fields) ON audit_events TO payment_agent;
GRANT EXECUTE ON FUNCTION consume_demo_credit(text) TO payment_agent;
GRANT SELECT, INSERT, UPDATE ON offers, purchases, payment_orders, webhook_events, credit_grants, balances, audit_events TO payment_checkout;
GRANT EXECUTE ON FUNCTION consume_demo_credit(text) TO payment_checkout;
