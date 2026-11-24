// TimeCapsule, версия для ЛР7 (часть 2):
//  - запечатывание капсулы: письмо отправляется не в веб-запросе, а через SNS/SQS/Lambda;
//  - открытие капсул по расписанию выполняет Lambda-opener, а не каждый веб-запрос;
//  - режим MAIL_MODE=inline оставлен для замера "до" (медленная отправка внутри запроса).
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const os = require('os');
const AWS = require('aws-sdk');
const DynamoDBStore = require('connect-dynamodb')({ session });

require('dotenv').config();

const HOST = os.hostname();
const useSsl = (process.env.PGSSLMODE || '').startsWith('no-verify');
const MAIL_DELAY = Number(process.env.MAIL_DELAY_SECONDS || 5);
const MAIL_MODE = process.env.MAIL_MODE || 'inline';       // inline | sns
const TOPIC_ARN = process.env.EVENTS_TOPIC_ARN || '';
const REGION = process.env.AWS_REGION || 'eu-central-1';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

const sns = new AWS.SNS({ region: REGION });

let zoneCache = null;
async function getZone() {
  if (zoneCache !== null) return zoneCache;
  try {
    const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' },
      signal: AbortSignal.timeout(1500),
    });
    const token = await tokenRes.text();
    const azRes = await fetch(
      'http://169.254.169.254/latest/meta-data/placement/availability-zone',
      { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1500) }
    );
    zoneCache = (await azRes.text()) || '';
  } catch (e) {
    zoneCache = '';
  }
  return zoneCache;
}

const store = new DynamoDBStore({
  client: new AWS.DynamoDB({ region: REGION }),
  table: process.env.SESSIONS_TABLE || 'timecapsule-dev-sessions',
  initialized: true,
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'tc.sid',
  secret: process.env.SESSION_SECRET || 'lab6-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 1000 },
}));

const page = (body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>TimeCapsule</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:820px;margin:2.5rem auto;padding:0 1rem;color:#1c1c1c}
 code{background:#f2f2f2;padding:2px 5px;border-radius:4px}
 table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;font-size:14px}
 .badge{display:inline-block;padding:1px 7px;border-radius:10px;background:#eef;font-size:12px}
 footer{margin-top:2.5rem;color:#555;border-top:1px solid #ddd;padding-top:.7rem;font-size:13px}
</style></head><body>${body}
<footer>Served by <b>${HOST}</b> &middot; zone ${zoneCache || '?'} &middot; mail mode <code>${MAIL_MODE}</code></footer>
</body></html>`;

// Старое поведение: открытие капсул прямо в веб-запросе (используется только в режиме inline).
async function openDueCapsulesInline() {
  const r = await pool.query(
    `update capsules set opened_at = now()
      where open_at <= now() and opened_at is null
      returning id, user_id, title`);
  for (const c of r.rows) {
    await pool.query(
      `insert into notifications (capsule_id, user_id, kind, capsule_title)
       values ($1, $2, 'opened', $3) on conflict (capsule_id, kind) do nothing`,
      [c.id, c.user_id, c.title]);
  }
  return r.rows;
}

app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('select now() as now, current_database() as db');
    res.json({ status: 'ok', db: 'up', database: r.rows[0].db, server_time: r.rows[0].now,
               served_by: HOST, zone: await getZone(), mail_mode: MAIL_MODE });
  } catch (e) {
    res.status(503).json({ status: 'degraded', db: 'down', error: e.message, served_by: HOST });
  }
});

app.get('/', async (req, res) => {
  let capsules = [];
  let notifications = [];
  let openedInline = 0;
  try {
    if (MAIL_MODE !== 'sns') {
      const opened = await openDueCapsulesInline();
      openedInline = opened.length;
    }
    capsules = (await pool.query(
      `select id, title, open_at, opened_at from capsules order by id desc limit 15`)).rows;
    notifications = (await pool.query(
      `select id, capsule_id, kind, capsule_title, created_at
         from notifications order by id desc limit 10`)).rows;
  } catch (e) {
    return res.status(500).type('html').send(page('<p>db error: ' + e.message + '</p>'));
  }
  const rows = capsules.map((c) =>
    `<tr><td>${c.id}</td><td>${c.title}</td>
     <td>${new Date(c.open_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
     <td>${c.opened_at ? '<span class="badge">открыта</span>' : 'запечатана'}</td></tr>`).join('');
  const nrows = notifications.map((n) =>
    `<tr><td>${n.id}</td><td>${n.capsule_id}</td><td>${n.kind}</td>
     <td>${n.capsule_title}</td><td>${new Date(n.created_at).toISOString().slice(11, 19)}</td></tr>`).join('');
  const user = req.session.user;
  res.type('html').send(page(`
    <h1>TimeCapsule</h1>
    <p>${user ? 'Пользователь: <b>' + user.email + '</b>' : 'Гость'} &middot;
       сессия <code>${req.sessionID}</code></p>
    ${openedInline ? `<p class="badge">этим запросом открыто капсул: ${openedInline}</p>` : ''}
    <h2>Запечатать капсулу</h2>
    <form method="post" action="/seal">
      <p><input name="title" value="Письмо в будущее" size="40"></p>
      <p><textarea name="body" rows="3" cols="60">Текст капсулы</textarea></p>
      <p><input name="open_at" size="25" placeholder="2026-11-22T18:00:00Z"></p>
      <p><button>Seal capsule</button></p>
    </form>
    <h2>Капсулы</h2>
    <table><tr><th>id</th><th>title</th><th>open_at (UTC)</th><th>state</th></tr>${rows}</table>
    <h2>Уведомления (таблица notifications)</h2>
    <table><tr><th>id</th><th>capsule</th><th>kind</th><th>title</th><th>time</th></tr>${nrows}</table>
    <p><a href="/notifications.json">notifications.json</a> &middot; <a href="/capsules">/capsules</a> &middot; <a href="/health">/health</a></p>`));
});

app.post('/seal', async (req, res) => {
  const { title, body, open_at } = req.body || {};
  if (!title || !body) return res.status(400).send('title and body are required');
  const started = Date.now();
  try {
    const r = await pool.query(
      `insert into capsules (user_id, title, body, open_at)
       values (1, $1, $2, coalesce($3::timestamptz, now() + interval '1 day')) returning *`,
      [title, body, open_at || null]);
    const capsule = r.rows[0];

    if (MAIL_MODE === 'sns') {
      await sns.publish({
        TopicArn: TOPIC_ARN,
        Message: JSON.stringify({
          event: 'capsule.sealed',
          capsule_id: capsule.id,
          user_id: capsule.user_id,
          email: (req.session.user && req.session.user.email) || 'user1@timecapsule.local',
          title: capsule.title,
          open_at: capsule.open_at,
          sealed_at: new Date().toISOString(),
        }),
        MessageAttributes: {
          event: { DataType: 'String', StringValue: 'capsule.sealed' },
        },
      }).promise();
    } else {
      // имитация медленного почтового сервера: письмо "отправляется" прямо в запросе
      await new Promise((resolve) => setTimeout(resolve, MAIL_DELAY * 1000));
      await pool.query(
        `insert into notifications (capsule_id, user_id, kind, capsule_title)
         values ($1, $2, 'sealed', $3) on conflict (capsule_id, kind) do nothing`,
        [capsule.id, capsule.user_id, capsule.title]);
    }
    const ms = Date.now() - started;
    res.type('html').send(page(
      `<h1>Капсула запечатана</h1>
       <p>id <b>${capsule.id}</b>, открыть после <code>${capsule.open_at.toISOString()}</code></p>
       <p>Запрос Seal capsule занял <b>${ms} мс</b> (режим <code>${MAIL_MODE}</code>).</p>
       <p><a href="/">На главную</a></p>`));
  } catch (e) {
    res.status(500).type('html').send(page('<p>error: ' + e.message + '</p>'));
  }
});

app.get('/notifications.json', async (req, res) => {
  try {
    const r = await pool.query(
      `select id, capsule_id, kind, capsule_title, created_at from notifications order by id`);
    res.json({ count: r.rowCount, items: r.rows, served_by: HOST });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/capsules', async (req, res) => {
  try {
    const r = await pool.query(
      `select id, user_id, title, open_at, opened_at from capsules order by id limit 50`);
    res.json({ count: r.rowCount, items: r.rows, served_by: HOST });
  } catch (e) {
    res.status(500).json({ error: e.message, served_by: HOST });
  }
});

app.post('/capsules', async (req, res) => {
  const { title, body, open_at } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  try {
    const r = await pool.query(
      `insert into capsules (user_id, title, body, open_at)
       values (1, $1, $2, coalesce($3::timestamptz, now() + interval '1 day')) returning *`,
      [title, body, open_at || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/login', (req, res) => {
  const email = (req.body && req.body.email) || '';
  if (!email) return res.status(400).send('email is required');
  req.session.user = { email };
  req.session.save(() => res.redirect('/'));
});

app.get('/whoami', (req, res) => {
  res.json({ served_by: HOST, zone: zoneCache || '', session_id: req.sessionID,
             user: req.session.user || null });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`TimeCapsule on ${HOST} port ${port}, DB=${process.env.DB_HOST}, mode=${MAIL_MODE}`));
