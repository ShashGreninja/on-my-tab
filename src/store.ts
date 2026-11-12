export interface Database {
  query<Row>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
}

export type Status = 'approval_required' | 'processing' | 'credits_available' | 'needs_review';
export interface Purchase {
  id: string;
  offer_id: string;
  owner_id: string;
  merchant: string;
  cents: number;
  currency: string;
  credits: number;
  status: Status;
}
interface Payment extends Purchase {
  provider_order_id: string | null;
  order_started_at: Date;
  capture_started_at: Date | null;
}
export interface AuditEvent {
  id: string;
  request_id: string;
  kind: string;
  status: Status;
  disclosed_fields: string[];
  occurred_at: Date;
}

export class PaymentStore {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async request(owner: string, offer: string) {
    // Concurrent inserts can conflict with a row that was invisible to their snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await this.db.query<{ id: string; status: Status }>(
        `INSERT INTO purchases (owner_id, offer_id, merchant, cents, currency, credits)
           SELECT $1, id, merchant, cents, currency, credits FROM offers WHERE id = $2
           ON CONFLICT DO NOTHING RETURNING id, status`, [owner, offer],
      );
      if (rows[0]) return rows[0];
      const existing = await this.db.query<{ id: string; status: Status }>(
        `SELECT id, status FROM purchases WHERE owner_id = $1 AND offer_id = $2
           AND status IN ('approval_required','processing','needs_review')`, [owner, offer],
      );
      if (existing.rows[0]) return existing.rows[0];
      if (!(await this.db.query('SELECT id FROM offers WHERE id = $1', [offer])).rows.length) return;
    }
    throw new Error('purchase contention');
  }

  async status(owner: string, id: string) {
    return (await this.db.query<{ id: string; status: Status }>(
      'SELECT id, status FROM purchases WHERE owner_id = $1 AND id = $2', [owner, id],
    )).rows[0];
  }

  async purchase(owner: string, id: string) {
    return (await this.db.query<Purchase>(
      'SELECT * FROM purchases WHERE owner_id = $1 AND id = $2', [owner, id],
    )).rows[0];
  }

  async auditResponse(id: string, status: Status, fields: string[]) {
    await this.db.query(
      "INSERT INTO audit_events(request_id, kind, status, disclosed_fields) VALUES ($1,'agent_response',$2,$3)",
      [id, status, fields],
    );
  }

  async beginOrder(id: string, owner: string) {
    await this.db.query(`INSERT INTO payment_orders(request_id)
      SELECT id FROM purchases WHERE id = $1 AND owner_id = $2 AND status = 'approval_required'
      ON CONFLICT DO NOTHING`, [id, owner]);
    return this.payment(id, owner);
  }

  async payment(id: string, owner?: string) {
    return (await this.db.query<Payment>(
      `SELECT p.*, o.provider_order_id, o.created_at AS order_started_at, o.capture_started_at
       FROM purchases p JOIN payment_orders o ON o.request_id = p.id
       WHERE p.id = $1 AND ($2::text IS NULL OR p.owner_id = $2)`, [id, owner ?? null],
    )).rows[0];
  }

  async bindOrder(id: string, order: string) {
    const { rows } = await this.db.query(`WITH bound AS (
      UPDATE payment_orders SET provider_order_id = $2, next_check_at = now()
      WHERE request_id = $1 AND provider_order_id IS NULL RETURNING request_id
    ), audited AS (
      INSERT INTO audit_events(request_id,kind,status)
      SELECT request_id,'checkout_started','approval_required' FROM bound
    ) SELECT request_id FROM payment_orders WHERE request_id = $1 AND provider_order_id = $2
      UNION SELECT request_id FROM bound`, [id, order]);
    if (!rows.length) throw new Error('provider order conflict');
  }

  async webhook(event: string, order: string, completed = false) {
    const { rows } = await this.db.query(`WITH received AS (
      INSERT INTO webhook_events(event_id)
      SELECT $1 WHERE EXISTS (SELECT 1 FROM payment_orders WHERE provider_order_id = $2)
      ON CONFLICT DO NOTHING RETURNING event_id
    ), scheduled AS (
      UPDATE payment_orders o SET next_check_at = now()
      FROM purchases p WHERE p.id = o.request_id AND o.provider_order_id = $2
      AND (p.status IN ('approval_required','processing') OR ($3 AND p.status = 'needs_review'))
      AND EXISTS (SELECT 1 FROM received)
    ) SELECT event_id FROM received`, [event, order, completed]);
    return rows.length > 0;
  }

  async schedule(owner: string, id: string) {
    await this.db.query(`UPDATE payment_orders o SET next_check_at = now()
      FROM purchases p WHERE p.id = o.request_id AND p.owner_id = $1 AND p.id = $2
      AND o.provider_order_id IS NOT NULL AND p.status IN ('approval_required','processing')`, [owner, id]);
  }

  async startCapture(id: string) {
    const { rows } = await this.db.query<{ capture_started_at: Date }>(`WITH eligible AS (
      UPDATE purchases SET status = 'processing' WHERE id = $1
      AND status IN ('approval_required','processing') RETURNING id
    ) UPDATE payment_orders SET capture_started_at = coalesce(capture_started_at, now())
      FROM eligible WHERE request_id = eligible.id RETURNING capture_started_at`, [id]);
    return rows[0]?.capture_started_at;
  }

  async fulfill(id: string, capture: string) {
    await this.db.query(`WITH granted AS (
      INSERT INTO credit_grants(request_id, capture_id, credits)
      SELECT id, $2, credits FROM purchases
      WHERE id = $1 AND status IN ('approval_required','processing','needs_review')
      ON CONFLICT (request_id) DO NOTHING RETURNING request_id, credits
    ), credited AS (
      INSERT INTO balances(owner_id, credits)
      SELECT p.owner_id, g.credits FROM purchases p JOIN granted g ON g.request_id = p.id
      ON CONFLICT (owner_id) DO UPDATE SET credits = balances.credits + excluded.credits
    ), finished AS (
      UPDATE purchases SET status = 'credits_available' FROM granted
      WHERE id = granted.request_id RETURNING id, status
    ) INSERT INTO audit_events(request_id,kind,status)
      SELECT id,'credits_granted',status FROM finished`, [id, capture]);
  }

  async review(id: string) {
    await this.db.query(`WITH updated AS (
      UPDATE purchases SET status = 'needs_review' WHERE id = $1
      AND status IN ('approval_required','processing') RETURNING id,status
    ) INSERT INTO audit_events(request_id,kind,status)
      SELECT id,'needs_review',status FROM updated`, [id]);
  }

  async balance(owner: string) {
    const { rows } = await this.db.query<{ credits: number }>('SELECT credits FROM balances WHERE owner_id = $1', [owner]);
    return rows[0]?.credits ?? 0;
  }

  async consume(owner: string) {
    const { rows } = await this.db.query<{ consumed: boolean }>(
      'SELECT consume_demo_credit($1) AS consumed', [owner],
    );
    return rows[0].consumed;
  }

  async claimJobs(limit = 10) {
    return (await this.db.query<{ request_id: string; lease_token: string }>(`WITH due AS (
      SELECT request_id FROM payment_orders WHERE next_check_at <= now()
      AND (lease_until IS NULL OR lease_until <= now()) ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE payment_orders o SET lease_until = now() + interval '2 minutes', lease_token = gen_random_uuid()
      FROM due WHERE o.request_id = due.request_id RETURNING o.request_id, o.lease_token`, [limit])).rows;
  }

  async releaseJob(id: string, lease: string, retry: boolean) {
    await this.db.query(`UPDATE payment_orders SET lease_until = NULL, lease_token = NULL,
      next_check_at = CASE WHEN $3 THEN now() + interval '30 seconds' ELSE NULL END
      WHERE request_id = $1 AND lease_token = $2`, [id, lease, retry]);
  }

  async audit(owner: string) {
    return (await this.db.query<AuditEvent>(`SELECT a.id, a.request_id, a.kind, a.status, a.disclosed_fields, a.occurred_at
      FROM audit_events a JOIN purchases p ON a.request_id = p.id
      WHERE p.owner_id = $1 ORDER BY a.occurred_at DESC LIMIT 250`, [owner])).rows;
  }

  async unindexed() {
    return (await this.db.query<AuditEvent>(`SELECT id, request_id, kind, status, disclosed_fields, occurred_at
      FROM audit_events WHERE indexed_at IS NULL ORDER BY occurred_at LIMIT 100`)).rows;
  }

  async indexed(id: string) {
    await this.db.query('UPDATE audit_events SET indexed_at = now() WHERE id = $1', [id]);
  }
}

export function formatUsd(cents: number) {
  return (cents / 100).toFixed(2);
}
