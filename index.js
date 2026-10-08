require("dotenv").config();

const express = require("express");
const { bot } = require("./src/bot");
const db = require("./src/db");
const { collectDueReminders } = require("./src/reminders");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!PUBLIC_URL) throw new Error("PUBLIC_URL не задан (см. .env.example)");
if (!WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET не задан (см. .env.example)");

const app = express();
app.use(express.json());

// Простой health-check — по нему тоже можно "будить" сервис, если понадобится.
app.get("/", (_req, res) => res.send("Наблюдатель: бот работает."));

// --- Опросник для Арсена -------------------------------------------------
// Страница: https://<адрес-бота>.onrender.com/opros
// Ответы приходят сообщением от бота человеку из OPROS_CHAT_ID
// (если не задан — первому ID из ADMIN_IDS).
const path = require("path");

app.get("/opros", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "opros.html"));
});

const OPROS_CHAT_ID =
  process.env.OPROS_CHAT_ID || (process.env.ADMIN_IDS || "").split(",")[0].trim();

// Простая защита от спама: не больше 5 отправок за 10 минут с одного адреса
// и не больше 30 в сутки всего.
const oprosHits = new Map();
let oprosDay = { date: new Date().toDateString(), count: 0 };

function splitForTelegram(text, limit = 3800) {
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > limit && cur) {
      parts.push(cur);
      cur = line;
    } else {
      cur = cur ? cur + "\n" + line : line;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

app.post("/opros/answers", async (req, res) => {
  try {
    const text = req.body && typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 20000) return res.status(400).json({ ok: false, error: "bad_text" });
    if (!OPROS_CHAT_ID) return res.status(500).json({ ok: false, error: "no_chat" });

    const today = new Date().toDateString();
    if (oprosDay.date !== today) oprosDay = { date: today, count: 0 };
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim();
    const now = Date.now();
    const recent = (oprosHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= 5 || oprosDay.count >= 30) {
      return res.status(429).json({ ok: false, error: "too_many" });
    }
    recent.push(now);
    oprosHits.set(ip, recent);
    oprosDay.count++;

    const parts = splitForTelegram(text);
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : "";
      await bot.telegram.sendMessage(OPROS_CHAT_ID, prefix + parts[i]);
    }
    res.json({ ok: true, parts: parts.length });
  } catch (err) {
    console.error("Ошибка отправки ответов опроса:", err.message);
    res.status(500).json({ ok: false, error: "send_failed" });
  }
});

// Приём обновлений от Telegram. Путь содержит секрет, чтобы никто посторонний
// не мог слать боту поддельные апдейты, зная только адрес сервиса.
app.use(bot.webhookCallback(`/telegram-webhook/${WEBHOOK_SECRET}`));

// Внешний планировщик (cron-job.org) дёргает этот путь каждые ~10 минут.
// Он же не даёт бесплатному инстансу Render "засыпать" от бездействия.
app.get(`/tick/${WEBHOOK_SECRET}`, async (_req, res) => {
  try {
    const due = await collectDueReminders();
    for (const { user, question } of due) {
      try {
        await bot.telegram.sendMessage(user.tg_id, question);
        await db.markReminderSent(user.id);
      } catch (err) {
        console.error(`Не удалось отправить напоминание ${user.tg_id}:`, err.message);
      }
    }
    res.json({ ok: true, sent: due.length });
  } catch (err) {
    console.error("Ошибка в /tick:", err.message);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  try {
    await db.ensureSchema();
  } catch (err) {
    console.error("Не удалось проверить схему базы:", err.message);
  }
  try {
    await bot.telegram.setWebhook(`${PUBLIC_URL}/telegram-webhook/${WEBHOOK_SECRET}`);
    console.log("Вебхук Telegram установлен:", `${PUBLIC_URL}/telegram-webhook/${WEBHOOK_SECRET}`);
  } catch (err) {
    console.error("Не удалось установить вебхук:", err.message);
  }

  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Начать / перезапустить бота" },
      { command: "reminders", description: "Настроить будильники самовспоминания" },
      { command: "freq", description: "Своя частота будильников, например /freq 10" },
      { command: "journal", description: "Короткая запись в дневник наблюдений" },
      { command: "journal_show", description: "Последние записи дневника" },
      { command: "library", description: "Лекции, музыка, глоссарий" },
      { command: "theme", description: "Тема недели" },
      { command: "support", description: "Поддержать донатом" },
      { command: "help", description: "Список команд" },
    ]);
  } catch (err) {
    console.error("Не удалось задать список команд:", err.message);
  }
});
