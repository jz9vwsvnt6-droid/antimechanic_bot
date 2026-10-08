// Тонкий слой поверх Postgres (Supabase). Никакой ORM — простые SQL-запросы,
// чтобы весь проект оставался маленьким и понятным.

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL не задан (см. .env.example)");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase требует SSL, но с самоподписанным на их стороне сертификатом это ок
});

// Пулер Supabase иногда рвёт простаивающие соединения. Без этого обработчика
// такая ошибка роняет весь процесс бота.
pool.on("error", (err) => {
  console.error("Соединение с базой разорвано (пул восстановит его сам):", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// --- Пользователи -----------------------------------------------------

const PAUSE_THRESHOLD_DAYS = 14;

/**
 * Находит или создаёт пользователя. Возвращает { user, isNew, returnedAfterPause }.
 */
async function upsertUser(tgUser) {
  const { id: tg_id, username, first_name } = tgUser;

  const existing = await query("select * from users where tg_id = $1", [tg_id]);

  if (existing.rows.length === 0) {
    const inserted = await query(
      `insert into users (tg_id, username, first_name) values ($1, $2, $3) returning *`,
      [tg_id, username || null, first_name || null]
    );
    return { user: inserted.rows[0], isNew: true, returnedAfterPause: false };
  }

  const user = existing.rows[0];
  const daysSinceActive =
    (Date.now() - new Date(user.last_active).getTime()) / (1000 * 60 * 60 * 24);
  const returnedAfterPause = daysSinceActive >= PAUSE_THRESHOLD_DAYS;

  const updated = await query(
    `update users set last_active = now(), username = $2, first_name = $3 where tg_id = $1 returning *`,
    [tg_id, username || null, first_name || null]
  );

  return { user: updated.rows[0], isNew: false, returnedAfterPause };
}

async function touchLastActive(tgId) {
  await query("update users set last_active = now() where tg_id = $1", [tgId]);
}

async function getUserByTgId(tgId) {
  const res = await query("select * from users where tg_id = $1", [tgId]);
  return res.rows[0] || null;
}

async function setReminders(tgId, { enabled, freqPerDay, windowStartH, windowEndH }) {
  const fields = [];
  const values = [tgId];
  let i = 2;

  if (enabled !== undefined) {
    fields.push(`reminders_enabled = $${i++}`);
    values.push(enabled);
  }
  if (freqPerDay !== undefined) {
    fields.push(`freq_per_day = $${i++}`);
    values.push(freqPerDay);
  }
  if (windowStartH !== undefined) {
    fields.push(`window_start_h = $${i++}`);
    values.push(windowStartH);
  }
  if (windowEndH !== undefined) {
    fields.push(`window_end_h = $${i++}`);
    values.push(windowEndH);
  }
  if (fields.length === 0) return;

  await query(`update users set ${fields.join(", ")} where tg_id = $1`, values);
}

async function getActiveReminderUsers() {
  const res = await query(
    `select * from users where reminders_enabled = true`
  );
  return res.rows;
}

async function markReminderSent(userId) {
  await query("update users set last_reminder_at = now() where id = $1", [userId]);
}

// --- Дневник ------------------------------------------------------------

async function addJournalEntry(userId, text) {
  await query(
    "insert into journal_entries (user_id, text) values ($1, $2)",
    [userId, text]
  );
}

async function getRecentEntries(userId, limit = 5) {
  const res = await query(
    "select text, created_at from journal_entries where user_id = $1 order by created_at desc limit $2",
    [userId, limit]
  );
  return res.rows;
}

// --- Тема недели ----------------------------------------------------------

async function setWeeklyTheme(text, setByTgId) {
  await query("insert into weekly_theme (text, set_by) values ($1, $2)", [text, setByTgId]);
}

async function getCurrentTheme() {
  const res = await query("select * from weekly_theme order by set_at desc limit 1");
  return res.rows[0] || null;
}

// --- Библиотека -----------------------------------------------------------

async function getLibraryItems(category) {
  const res = await query(
    "select * from library_items where category = $1 order by added_at desc",
    [category]
  );
  return res.rows;
}

// --- Статистика (для админов, только агрегаты — без личных данных) --------

async function getStats() {
  const totalUsers = await query("select count(*) from users");
  const active7d = await query(
    "select count(*) from users where last_active > now() - interval '7 days'"
  );
  const active30d = await query(
    "select count(*) from users where last_active > now() - interval '30 days'"
  );
  const entries7d = await query(
    "select count(*) from journal_entries where created_at > now() - interval '7 days'"
  );
  const remindersOn = await query(
    "select count(*) from users where reminders_enabled = true"
  );

  return {
    totalUsers: Number(totalUsers.rows[0].count),
    active7d: Number(active7d.rows[0].count),
    active30d: Number(active30d.rows[0].count),
    entries7d: Number(entries7d.rows[0].count),
    remindersOn: Number(remindersOn.rows[0].count),
  };
}

async function getAllActiveTgIds() {
  const res = await query("select tg_id from users");
  return res.rows.map((r) => r.tg_id);
}

// --- Схема: доп. таблицы создаются автоматически при запуске ---------------

async function ensureSchema() {
  await query(`
    create table if not exists admins (
      tg_id    bigint primary key,
      added_by bigint,
      added_at timestamptz not null default now()
    )
  `);
  // Таблица доступна только серверу бота (подключение postgres), не публичному API
  await query("alter table admins enable row level security");
}

// --- Администраторы (дополнительно к ADMIN_IDS из настроек Render) ---------

async function listDbAdmins() {
  const res = await query(
    `select a.tg_id, a.added_at, u.username, u.first_name
       from admins a left join users u on u.tg_id = a.tg_id
      order by a.added_at`
  );
  return res.rows;
}

async function addAdmin(tgId, addedBy) {
  await query(
    "insert into admins (tg_id, added_by) values ($1, $2) on conflict (tg_id) do nothing",
    [tgId, addedBy]
  );
}

async function removeAdmin(tgId) {
  const res = await query("delete from admins where tg_id = $1", [tgId]);
  return res.rowCount > 0;
}

async function findUserByUsername(username) {
  const res = await query("select * from users where lower(username) = lower($1)", [username]);
  return res.rows[0] || null;
}

module.exports = {
  ensureSchema,
  listDbAdmins,
  addAdmin,
  removeAdmin,
  findUserByUsername,
  pool,
  query,
  upsertUser,
  touchLastActive,
  getUserByTgId,
  setReminders,
  getActiveReminderUsers,
  markReminderSent,
  addJournalEntry,
  getRecentEntries,
  setWeeklyTheme,
  getCurrentTheme,
  getLibraryItems,
  getStats,
  getAllActiveTgIds,
  PAUSE_THRESHOLD_DAYS,
};
