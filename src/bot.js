const { Telegraf, Markup } = require("telegraf");
const db = require("./db");
const content = require("./content");
const { MAX_FREQ } = require("./reminders");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN не задан (см. .env.example)");

// Владельцы - из настроек Render (ADMIN_IDS). Их нельзя снять командой из бота.
const OWNER_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// Остальные администраторы - в таблице admins, добавляются командой /add_admin.
let dbAdminCache = { ids: [], at: 0 };

async function dbAdminIds() {
  if (Date.now() - dbAdminCache.at < 60 * 1000) return dbAdminCache.ids;
  try {
    const rows = await db.listDbAdmins();
    dbAdminCache = { ids: rows.map((r) => Number(r.tg_id)), at: Date.now() };
  } catch (err) {
    console.error("Не удалось прочитать список админов:", err.message);
  }
  return dbAdminCache.ids;
}

function resetAdminCache() {
  dbAdminCache.at = 0;
}

async function isAdmin(tgId) {
  const id = Number(tgId);
  if (OWNER_IDS.includes(id)) return true;
  return (await dbAdminIds()).includes(id);
}

const bot = new Telegraf(BOT_TOKEN);

const mainMenu = Markup.keyboard([
  ["🔔 Будильники", "📓 Дневник"],
  ["📚 Библиотека", "🎯 Тема недели"],
  ["💛 Поддержать", "❓ Помощь"],
]).resize();

// --- middleware: подтягиваем/создаём пользователя на каждое взаимодействие ---

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try {
    const { user, returnedAfterPause } = await db.upsertUser(ctx.from);
    ctx.state.user = user;
    ctx.state.returnedAfterPause = returnedAfterPause;
  } catch (err) {
    console.error("Ошибка upsertUser:", err.message);
  }
  return next();
});

// Если человек вернулся после паузы (14+ дней) — мягкое приветствие
// показываем один раз перед обработкой любой команды.
async function maybeGreetReturning(ctx) {
  if (ctx.state.returnedAfterPause) {
    await ctx.reply(content.RETURNED_AFTER_PAUSE);
  }
}

// --- /start ---------------------------------------------------------------

bot.start(async (ctx) => {
  await maybeGreetReturning(ctx);
  await ctx.reply(content.WELCOME(ctx.from.first_name), mainMenu);
});

bot.help(async (ctx) => {
  const admin = await isAdmin(ctx.from.id);
  await ctx.reply(content.HELP + (admin ? content.ADMIN_HELP : ""), mainMenu);
});
bot.hears("❓ Помощь", async (ctx) => ctx.reply(content.HELP, mainMenu));

// --- Дневник ----------------------------------------------------------------

bot.command("journal", async (ctx) => {
  await maybeGreetReturning(ctx);
  const text = ctx.message.text.replace(/^\/journal\s*/i, "").trim();
  if (!text) {
    await ctx.reply(content.JOURNAL_PROMPT);
    return;
  }
  await db.addJournalEntry(ctx.state.user.id, text);
  await ctx.reply(content.JOURNAL_SAVED);
});

bot.command("journal_show", async (ctx) => {
  const entries = await db.getRecentEntries(ctx.state.user.id, 5);
  if (entries.length === 0) {
    await ctx.reply("Пока пусто. Можно просто написать сюда пару строк о том, что заметил.");
    return;
  }
  const lines = entries.map((e) => {
    const d = new Date(e.created_at);
    const date = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    return `${date} — ${e.text}`;
  });
  await ctx.reply(lines.join("\n"));
});

bot.hears("📓 Дневник", async (ctx) => {
  await ctx.reply(content.JOURNAL_PROMPT);
});

// Свободный текст без команды — тоже трактуем как запись в дневник,
// если человек только что видел приглашение (простая эвристика: если
// сообщение не совпадает ни с одной кнопкой меню, считаем его дневниковой записью).
const MENU_LABELS = ["🔔 Будильники", "📓 Дневник", "📚 Библиотека", "🎯 Тема недели", "💛 Поддержать", "❓ Помощь"];

bot.on("text", async (ctx, next) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return next();
  if (MENU_LABELS.includes(text)) return next();

  await maybeGreetReturning(ctx);
  await db.addJournalEntry(ctx.state.user.id, text);
  await ctx.reply(content.JOURNAL_SAVED);
});

// --- Будильники ---------------------------------------------------------

function remindersKeyboard(user) {
  const toggleLabel = user.reminders_enabled ? "Выключить" : "Включить";
  const btn = (n) =>
    Markup.button.callback((user.freq_per_day === n ? "• " : "") + n + " в день", "rem_freq_" + n);
  return Markup.inlineKeyboard([
    [Markup.button.callback(toggleLabel, "rem_toggle")],
    [btn(1), btn(2), btn(4)],
    [btn(6), btn(8), btn(12)],
  ]);
}

async function showRemindersMenu(ctx) {
  const user = await db.getUserByTgId(ctx.from.id);
  const status = user.reminders_enabled
    ? `включены, ~${user.freq_per_day} в день, окно ${user.window_start_h}:00-${user.window_end_h}:00 МСК`
    : "выключены";
  await ctx.reply(`${content.REMINDERS_MENU_TEXT}\n\nСейчас: ${status}`, remindersKeyboard(user));
}

bot.command("reminders", showRemindersMenu);

// Своя частота: /freq 20
bot.command("freq", async (ctx) => {
  const n = parseInt(ctx.message.text.replace(/^\/freq(@\w+)?\s*/i, ""), 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_FREQ) {
    await ctx.reply(`Напиши число от 1 до ${MAX_FREQ}, например: /freq 10`);
    return;
  }
  await db.setReminders(ctx.from.id, { freqPerDay: n, enabled: true });
  await ctx.reply(`Будильники включены: ~${n} в день, в случайное время.`);
});
bot.hears("🔔 Будильники", showRemindersMenu);

bot.action("rem_toggle", async (ctx) => {
  const user = await db.getUserByTgId(ctx.from.id);
  await db.setReminders(ctx.from.id, { enabled: !user.reminders_enabled });
  await ctx.answerCbQuery(user.reminders_enabled ? "Выключено" : "Включено");
  await showRemindersMenu(ctx);
});

bot.action(/rem_freq_(\d+)/, async (ctx) => {
  const freq = Number(ctx.match[1]);
  await db.setReminders(ctx.from.id, { freqPerDay: freq, enabled: true });
  await ctx.answerCbQuery(`Частота: ~${freq} в день`);
  await showRemindersMenu(ctx);
});

// --- Библиотека -------------------------------------------------------------

const libraryKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("Лекции", "lib_lecture")],
  [Markup.button.callback("Музыка", "lib_music")],
  [Markup.button.callback("Глоссарий", "lib_glossary")],
]);

bot.command("library", async (ctx) => {
  await ctx.reply("Что интересует?", libraryKeyboard);
});
bot.hears("📚 Библиотека", async (ctx) => {
  await ctx.reply("Что интересует?", libraryKeyboard);
});

const CATEGORY_TITLES = { lecture: "Лекции", music: "Музыка", glossary: "Глоссарий" };

bot.action(/lib_(lecture|music|glossary)/, async (ctx) => {
  const category = ctx.match[1];
  const items = await db.getLibraryItems(category);
  await ctx.answerCbQuery();
  if (items.length === 0) {
    await ctx.reply(`Раздел «${CATEGORY_TITLES[category]}» пока пуст.`);
    return;
  }
  const lines = items.map((i) => {
    const desc = i.description ? `\n${i.description}` : "";
    const url = i.url ? `\n${i.url}` : "";
    return `• ${i.title}${desc}${url}`;
  });
  await ctx.reply(lines.join("\n\n"));
});

// --- Тема недели --------------------------------------------------------

bot.command("theme", async (ctx) => {
  const theme = await db.getCurrentTheme();
  if (!theme) {
    await ctx.reply("Тема недели пока не задана.");
    return;
  }
  await ctx.reply(`Тема недели:\n\n${theme.text}`);
});
bot.hears("🎯 Тема недели", async (ctx) => {
  const theme = await db.getCurrentTheme();
  await ctx.reply(theme ? `Тема недели:\n\n${theme.text}` : "Тема недели пока не задана.");
});

// --- Поддержать -----------------------------------------------------------

bot.command("support", async (ctx) => ctx.reply(content.DONATE_TEXT()));
bot.hears("💛 Поддержать", async (ctx) => ctx.reply(content.DONATE_TEXT()));

// --- Админ-команды ----------------------------------------------------------

bot.command("set_theme", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.reply(content.NOT_ADMIN);
  const text = ctx.message.text.replace(/^\/set_theme\s*/i, "").trim();
  if (!text) {
    await ctx.reply("Использование: /set_theme текст новой темы");
    return;
  }
  await db.setWeeklyTheme(text, ctx.from.id);
  await ctx.reply("Тема недели обновлена.");
});

bot.command("stats", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.reply(content.NOT_ADMIN);
  const s = await db.getStats();
  await ctx.reply(
    `Всего в боте: ${s.totalUsers}\n` +
      `Активны за 7 дней: ${s.active7d}\n` +
      `Активны за 30 дней: ${s.active30d}\n` +
      `Будильники включены у: ${s.remindersOn}\n` +
      `Записей в дневниках за 7 дней: ${s.entries7d}`
  );
});

bot.command("broadcast", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.reply(content.NOT_ADMIN);
  const text = ctx.message.text.replace(/^\/broadcast\s*/i, "").trim();
  if (!text) {
    await ctx.reply("Использование: /broadcast текст сообщения (уйдёт всем пользователям бота)");
    return;
  }
  const ids = await db.getAllActiveTgIds();
  let sent = 0;
  for (const id of ids) {
    try {
      await ctx.telegram.sendMessage(id, text);
      sent++;
    } catch (err) {
      // пользователь мог заблокировать бота — просто пропускаем
    }
  }
  await ctx.reply(`Разослано: ${sent} из ${ids.length}`);
});

// --- Управление администраторами -------------------------------------------
// /add_admin @username  или  /add_admin 123456789
// Человек должен хотя бы раз написать боту /start, чтобы бот его знал.

async function resolveTarget(arg) {
  if (!arg) return null;
  if (/^\d{5,}$/.test(arg)) {
    const user = await db.getUserByTgId(Number(arg));
    return { tg_id: Number(arg), user };
  }
  const username = arg.replace(/^@/, "");
  const user = await db.findUserByUsername(username);
  return user ? { tg_id: Number(user.tg_id), user } : null;
}

function displayName(u, id) {
  if (!u) return String(id);
  const name = u.first_name || "";
  const nick = u.username ? "@" + u.username : "";
  return [name, nick].filter(Boolean).join(" ") + ` (${id})`;
}

bot.command("add_admin", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.reply(content.NOT_ADMIN);
  const arg = ctx.message.text.replace(/^\/add_admin(@\w+)?\s*/i, "").trim();
  if (!arg) return ctx.reply("Использование: /add_admin @username или /add_admin числовой_ID");
  const target = await resolveTarget(arg);
  if (!target) {
    return ctx.reply("Не нашёл такого человека среди пользователей бота. Пусть он сначала напишет боту /start, потом повтори команду.");
  }
  await db.addAdmin(target.tg_id, ctx.from.id);
  resetAdminCache();
  await ctx.reply(`Готово: ${displayName(target.user, target.tg_id)} теперь администратор бота.`);
  try {
    await ctx.telegram.sendMessage(
      target.tg_id,
      "Тебе открыты команды администратора бота «Наблюдатель». Список - в /help."
    );
  } catch (err) {
    // если человек ещё не открывал бота - уведомление не дойдёт, это не страшно
  }
});

bot.command("remove_admin", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.reply(content.NOT_ADMIN);
  const arg = ctx.message.text.replace(/^\/remove_admin(@\w+)?\s*/i, "").trim();
  const target = await resolveTarget(arg);
  if (!target) return ctx.reply("Использование: /remove_admin @username или /remove_admin числовой_ID");
  if (OWNER_IDS.includes(target.tg_id)) {
    return ctx.reply("Это владелец бота из настроек сервера - его нельзя снять командой.");
  }
  const removed = await db.removeAdmin(target.tg_id);
  resetAdminCache();
  await ctx.reply(removed ? "Готово, права администратора сняты." : "Этот человек и так не был администратором.");
});

bot.command("admins", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.reply(content.NOT_ADMIN);
  const lines = [];
  for (const id of OWNER_IDS) {
    const u = await db.getUserByTgId(id);
    lines.push("• " + displayName(u, id) + " - владелец");
  }
  for (const r of await db.listDbAdmins()) {
    if (OWNER_IDS.includes(Number(r.tg_id))) continue;
    lines.push("• " + displayName(r, r.tg_id));
  }
  await ctx.reply("Администраторы бота:\n\n" + (lines.join("\n") || "пока никого"));
});

module.exports = { bot, isAdmin };
