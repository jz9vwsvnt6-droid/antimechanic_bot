// Логика "будильников самовспоминания".
//
// Подход: вместо того чтобы заранее планировать точное время для каждого
// пользователя (что требует хранить состояние по каждому будущему напоминанию),
// внешний планировщик (cron-job.org) дёргает наш /tick каждые 10 минут.
// На каждом тике для каждого пользователя с включёнными будильниками
// подбрасывается взвешенная монетка: вероятность подобрана так, чтобы
// в среднем за день пользователь получил примерно freq_per_day напоминаний,
// но именно в случайные моменты внутри своего окна часов — это важно:
// предсказуемое время быстро превращается в фоновый шум и перестаёт "будить".
//
// Дополнительно действует минимальный отступ между напоминаниями (COOLDOWN_MIN),
// чтобы монетка не могла случайно прислать два вопроса подряд.

const db = require("./db");
const { randomReminderQuestion } = require("./content");

const TICK_MINUTES = 10;
const COOLDOWN_MIN = 90;
const MSK_OFFSET_HOURS = 3; // считаем часы окна по московскому времени

function currentMskHour() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  return (utcHour + MSK_OFFSET_HOURS) % 24;
}

function isWithinWindow(user, hour) {
  const { window_start_h, window_end_h } = user;
  if (window_start_h <= window_end_h) {
    return hour >= window_start_h && hour < window_end_h;
  }
  // окно, переходящее через полночь (на случай нестандартной настройки)
  return hour >= window_start_h || hour < window_end_h;
}

function ticksInWindow(user) {
  const span =
    user.window_start_h <= user.window_end_h
      ? user.window_end_h - user.window_start_h
      : 24 - user.window_start_h + user.window_end_h;
  return Math.max(1, Math.round((span * 60) / TICK_MINUTES));
}

function cooldownActive(user) {
  if (!user.last_reminder_at) return false;
  const minutesSince = (Date.now() - new Date(user.last_reminder_at).getTime()) / 60000;
  return minutesSince < COOLDOWN_MIN;
}

/**
 * Вызывается на каждый /tick. Возвращает список { user, question } тех,
 * кому в этот раз стоит отправить напоминание — сама отправка через Telegram
 * происходит в index.js, чтобы этот модуль не знал про бота напрямую.
 */
async function collectDueReminders() {
  const hour = currentMskHour();
  const users = await db.getActiveReminderUsers();
  const due = [];

  for (const user of users) {
    if (!isWithinWindow(user, hour)) continue;
    if (cooldownActive(user)) continue;

    const p = user.freq_per_day / ticksInWindow(user);
    if (Math.random() < p) {
      due.push({ user, question: randomReminderQuestion() });
    }
  }

  return due;
}

module.exports = { collectDueReminders, TICK_MINUTES };
