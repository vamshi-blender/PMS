-- Donna's long-term memory: one table of per-user memories and one table of
-- organization-wide rules. Only the server (service role) reads or writes
-- these; row level security is on with no policies so other keys see nothing.

create table public.user_memories (
  id bigint generated always as identity primary key,
  environment text not null check (environment in ('staging', 'production')),
  -- The PMS UserId, as verified by PMS on every request.
  user_id text not null,
  content text not null check (char_length(content) between 1 and 1000),
  -- When to stop showing this memory to Donna; null means it does not expire.
  expires_at timestamptz,
  source_conversation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index user_memories_owner_idx
  on public.user_memories (environment, user_id);

create table public.organization_memories (
  id bigint generated always as identity primary key,
  environment text not null check (environment in ('staging', 'production')),
  content text not null check (char_length(content) between 1 and 1000),
  -- Only 'approved' rows are shown to Donna. Review by editing this column.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'superseded')),
  -- Set when this row is a proposed edit of an existing rule. The old rule
  -- stays in force until this row is approved.
  replaces_id bigint references public.organization_memories (id),
  proposed_by_user_id text not null,
  source_conversation_id text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organization_memories_status_idx
  on public.organization_memories (environment, status);

alter table public.user_memories enable row level security;
alter table public.organization_memories enable row level security;

create function public.donna_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_memories_touch_updated_at
  before update on public.user_memories
  for each row execute function public.donna_touch_updated_at();

create trigger organization_memories_touch_updated_at
  before update on public.organization_memories
  for each row execute function public.donna_touch_updated_at();

-- Reviewing is one manual edit: change `status`. This stamps reviewed_at.
create function public.donna_stamp_reviewed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.status <> 'pending' then
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;

create trigger organization_memories_stamp_reviewed_at
  before update on public.organization_memories
  for each row execute function public.donna_stamp_reviewed_at();

-- Approving a proposed edit retires the rule it replaces, so the old and new
-- versions are never both in force.
create function public.donna_supersede_replaced_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'approved' and old.status <> 'approved' and new.replaces_id is not null then
    update public.organization_memories
      set status = 'superseded'
      where id = new.replaces_id and status = 'approved';
  end if;
  return null;
end;
$$;

create trigger organization_memories_supersede_replaced_rule
  after update on public.organization_memories
  for each row execute function public.donna_supersede_replaced_rule();
