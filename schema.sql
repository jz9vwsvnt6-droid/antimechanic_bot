-- Схема базы данных бота "Наблюдатель".
-- Выполнить один раз в Supabase: SQL Editor -> New query -> вставить весь файл -> Run.

create table if not exists users (
  id                bigserial primary key,
  tg_id             bigint unique not null,
  username          text,
  first_name        text,
  joined_at         timestamptz not null default now(),
  last_active       timestamptz not null default now(),
  reminders_enabled boolean not null default false,
  freq_per_day      integer not null default 3,       -- 2 / 4 / 6 условных уровня
  window_start_h    integer not null default 9,        -- часы по МСК (UTC+3)
  window_end_h      integer not null default 22,
  last_reminder_at  timestamptz
);

create table if not exists journal_entries (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  text       text not null,
  created_at timestamptz not null default now()
);

create table if not exists weekly_theme (
  id      bigserial primary key,
  text    text not null,
  set_at  timestamptz not null default now(),
  set_by  bigint
);

create table if not exists library_items (
  id          bigserial primary key,
  category    text not null check (category in ('lecture', 'music', 'glossary')),
  title       text not null,
  description text,
  url         text,           -- ссылка на аудио/видео/файл/пост
  added_at    timestamptz not null default now()
);

create index if not exists idx_journal_user on journal_entries(user_id);
create index if not exists idx_users_tg on users(tg_id);

-- Немного стартового контента, чтобы библиотека не была пустой в день запуска.
-- Арсен и Михаил могут redактировать / добавлять строки прямо здесь, в Table Editor Supabase,
-- без изменения кода бота.
insert into library_items (category, title, description, url) values
  ('glossary', 'Самовспоминание', 'Состояние, в котором человек одновременно осознаёт и то, что делает, и то, что он это делает — вместо автоматического погружения в действие.', null),
  ('glossary', 'Механичность', 'Действия, мысли и реакции, которые происходят сами собой, без участия осознанного внимания — «на автопилоте».', null),
  ('glossary', 'Три центра', 'Интеллектуальный (мысли), эмоциональный (чувства) и двигательный (тело) — три относительно независимых «канала», через которые проявляется человек.', null),
  ('glossary', 'Буфер', 'Внутренний механизм, который не даёт человеку видеть противоречия в себе и тем самым сохраняет привычный образ себя.', null)
on conflict do nothing;
