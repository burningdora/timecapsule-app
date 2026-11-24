// Разовая миграция схемы для ЛР7: таблица notifications и колонка capsules.opened_at.
const { Pool } = require('pg');
require('dotenv').config();

const useSsl = (process.env.PGSSLMODE || '').startsWith('no-verify');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const sql = `
    alter table capsules add column if not exists opened_at timestamptz;
    create table if not exists notifications (
      id            bigserial primary key,
      capsule_id    integer not null,
      user_id       integer not null,
      kind          varchar(16) not null,
      capsule_title varchar(200) not null,
      created_at    timestamptz not null default now(),
      unique (capsule_id, kind)
    );
    create index if not exists capsules_due_idx on capsules (open_at) where opened_at is null;
  `;
  await pool.query(sql);
  const t = await pool.query("select column_name from information_schema.columns where table_name='notifications' order by ordinal_position");
  console.log('notifications columns:', t.rows.map((r) => r.column_name).join(', '));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
