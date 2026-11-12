CREATE TABLE IF NOT EXISTS offers (
  id text PRIMARY KEY,
  merchant text NOT NULL,
  cents integer NOT NULL CHECK (cents > 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  credits integer NOT NULL CHECK (credits > 0)
);
INSERT INTO offers VALUES ('test-credits', 'DEMO-MERCHANT', 500, 'USD', 100)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  offer_id text NOT NULL REFERENCES offers,
  merchant text NOT NULL,
  cents integer NOT NULL,
  currency text NOT NULL,
  credits integer NOT NULL,
  status text NOT NULL DEFAULT 'approval_required' CHECK (status IN (
    'approval_required', 'processing', 'credits_available', 'needs_review'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_purchase
  ON purchases (owner_id, offer_id) WHERE status IN ('approval_required', 'processing', 'needs_review');

CREATE TABLE IF NOT EXISTS payment_orders (
  request_id uuid PRIMARY KEY REFERENCES purchases,
  provider_order_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  capture_started_at timestamptz,
  next_check_at timestamptz,
  lease_until timestamptz,
  lease_token uuid
);
CREATE INDEX IF NOT EXISTS due_orders ON payment_orders(next_check_at) WHERE next_check_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS credit_grants (
  request_id uuid PRIMARY KEY REFERENCES purchases,
  capture_id text UNIQUE NOT NULL,
  credits integer NOT NULL
);
CREATE TABLE IF NOT EXISTS balances (
  owner_id text PRIMARY KEY,
  credits integer NOT NULL CHECK (credits >= 0)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES purchases,
  kind text NOT NULL CHECK (kind IN ('agent_response','checkout_started','credits_granted','needs_review')),
  status text NOT NULL CHECK (status IN ('approval_required','processing','credits_available','needs_review')),
  disclosed_fields text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz
);
CREATE INDEX IF NOT EXISTS audit_by_purchase ON audit_events(request_id, occurred_at);
CREATE INDEX IF NOT EXISTS pending_audit ON audit_events(occurred_at) WHERE indexed_at IS NULL;

CREATE OR REPLACE FUNCTION consume_demo_credit(account text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH consumed AS (
    UPDATE public.balances SET credits = credits - 1
    WHERE owner_id = account AND credits > 0 RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM consumed);
$$;
REVOKE ALL ON FUNCTION consume_demo_credit(text) FROM PUBLIC;
