/**
 * Apply sql/schema.sql to the linked Neon branch.
 * Usage: npm run db:setup  (loads .env.local with node --env-file)
 */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is missing. Run `neon deploy` (or `neon env pull`) first.");
  process.exit(1);
}

const sql = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
const pool = new Pool({ connectionString, max: 1 });

try {
  await pool.query(sql);
  const { rows } = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'knomad_docs'`,
  );
  const count = await pool.query("select count(*)::int as n from public.knomad_docs");
  console.log(
    JSON.stringify(
      { table: rows[0]?.table_name || null, rows: count.rows[0]?.n ?? 0 },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
