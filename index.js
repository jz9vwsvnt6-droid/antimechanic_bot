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
    await bot.telegram.setWebhook(`${PUBLIC_URL}/telegram-webhook/${WEBHOOK_SECRET}`);
    console.log("Вебхук Telegram установлен:", `${PUBLIC_URL}/telegram-webhook/${WEBHOOK_SECRET}`);
  } catch (err) {
    console.error("Не удалось установить вебхук:", err.message);
  }

  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Начать / перезапустить бота" },
      { command: "reminders", description: "Настроить будильники самовспоминания" },
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
