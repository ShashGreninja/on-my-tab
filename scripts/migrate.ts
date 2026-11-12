import { readFile } from 'node:fs/promises';
import { connect, required } from '../src/runtime.ts';

const { pool } = connect('ADMIN_DATABASE_URL');
try {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  await pool.query("UPDATE offers SET merchant = $1 WHERE id = 'test-credits'", [required('PAYPAL_MERCHANT_ID')]);
  await pool.query(await readFile(new URL('../db/grants.sql', import.meta.url), 'utf8'));
  console.log('Payment schema and service grants applied');
} finally { await pool.end(); }
