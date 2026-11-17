-- Donna's reminders (prospective memory): things to do or check at a future
-- time, private to one PMS user in one environment. Only the server (service
-- role) reads or writes them; the extension fetches its user's reminders
-- through the backend and schedules them locally.
-- The value lists in the check constraints must match shared/reminders.ts.

create table public.reminders (
  id bigint generated always as identity primary key,
  environment text not null check (environment in ('staging', 'production')),
  -- The PMS UserId, as verified by PMS on every request.
  user_id text not null check (length(user_id) > 0),
  -- 'notify' shows fixed text; 'check' has Donna look something up first.
  kind text not null check (kind in ('notify', 'check')),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  instruction text not null check (char_length(btrim(instruction)) between 1 and 1000),
  -- The schedule. local_time (and weekday for 'weekly') is the India
  -- wall-clock anchor every occurrence is computed from, so snoozing or
  -- firing late never shifts later occurrences.
  recurrence text not null check (recurrence in ('once', 'daily', 'weekdays', 'weekly')),
  local_time text not null check (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- 0 (Sunday) to 6 (Saturday); set only for 'weekly'.
  weekday smallint check (weekday between 0 and 6),
  check ((recurrence = 'weekly') = (weekday is not null)),
  next_fire_at timestamptz not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'cancelled')),
  -- Where the reminder was created. Provenance only: deleting that chat does
  -- not affect the reminder.
  source_conversation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reminders_owner_idx
  on public.reminders (environment, user_id, status);

alter table public.reminders enable row level security;
revoke all on public.reminders from anon, authenticated;
grant select, insert, update, delete on public.reminders to service_role;
grant usage, select on sequence public.reminders_id_seq to service_role;

create trigger reminders_touch_updated_at
  before update on public.reminders
  for each row execute function public.donna_touch_updated_at();
