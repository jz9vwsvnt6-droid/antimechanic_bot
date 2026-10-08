// Логика "будильников самовспоминания".
//
// Внешний планировщик (cron-job.org) дёргает /tick раз в несколько минут.
// На каждом тике для каждого человека с включёнными будильниками
// подбрасывается взвешенная монетка. Вероятность считается от реального
// времени, прошедшего с прошлого тика, - поэтому частота остаётся верной,
// даже если интервал cron поменяют (5, 10 или 15 минут) или тик пропустится.
// В среднем человек получает примерно freq_per_day напоминаний за своё окно
// часов, но в случайные моменты: предсказуемое время быстро становится фоном.
//
// Минимальный отступ между напоминаниями подстраивается под частоту:
// при 2 в день - не чаще раза в 90 минут, при 20 в день - примерно раз в 15.

const db = require("./db");
const { randomReminderQuestion } = require("./content");

const DEFAULT_TICK_MIN = 5;   // если сервер только что перезапустился
const MAX_TICK_GAP_MIN = 30;  // долгий простой не превращаем в пачку напоминаний
const MSK_OFFSET_HOURS = 3;   // часы окна - по московскому времени
const MAX_FREQ = 30;          // технический потолок "без ограничения"

let lastTickAt = null;

function currentMskHour() {
  return (new Date().getUTCHours() + MSK_OFFSET_HOURS) % 24;
}

function isWithinWindow(user, hour) {
  const { window_start_h, window_end_h } = user;
  if (window_start_h <= window_end_h) return hour >= window_start_h && hour < window_end_h;
  return hour >= window_start_h || hour < window_end_h;
}

function windowMinutes(user) {
  const span =
    user.window_start_h <= user.window_end_h
      ? user.window_end_h - user.window_start_h
      : 24 - user.window_start_h + user.window_end_h;
  return Math.max(60, span * 60);
}

function cooldownMinutes(user) {
  const freq = Math.max(1, Math.min(MAX_FREQ, Number(user.freq_per_day) || 1));
  return Math.min(90, (windowMinutes(user) / freq) * 0.4);
}

function cooldownActive(user) {
  if (!user.last_reminder_at) return false;
  const minutesSince = (Date.now() - new Date(user.last_reminder_at).getTime()) / 60000;
  return minutesSince < cooldownMinutes(user);
}

/**
 * Вызывается на каждый /tick. Возвращает список { user, question } тех,
 * кому сейчас стоит отправить напоминание. Сама отправка - в index.js.
 */
async function collectDueReminders() {
  const now = Date.now();
  let elapsedMin = lastTickAt ? (now - lastTickAt) / 60000 : DEFAULT_TICK_MIN;
  elapsedMin = Math.max(0, Math.min(MAX_TICK_GAP_MIN, elapsedMin));
  lastTickAt = now;

  const hour = currentMskHour();
  const users = await db.getActiveReminderUsers();
  const due = [];

  for (const user of users) {
    if (!isWithinWindow(user, hour)) continue;
    if (cooldownActive(user)) continue;

    const freq = Math.max(1, Math.min(MAX_FREQ, Number(user.freq_per_day) || 1));
    // Вероятность с поправкой на отступ: часть окна "закрыта" после каждого напоминания
    const openMinutes = Math.max(30, windowMinutes(user) - freq * cooldownMinutes(user));
    const p = Math.min(0.9, (freq * elapsedMin) / openMinutes);
    if (Math.random() < p) due.push({ user, question: randomReminderQuestion() });
  }

  return due;
}

module.exports = { collectDueReminders, MAX_FREQ, cooldownMinutes, windowMinutes };
