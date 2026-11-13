-- One row per immutable skill revision/proposal. Administrators review by
-- changing status in Supabase; no agent-facing approval API exists.
create table public.procedural_memories (
  id bigint generated always as identity primary key,
  environment text not null check (environment in ('staging', 'production')),
  organization_id text not null check (length(organization_id) > 0),
  skill_key text not null check (skill_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(skill_key) <= 64),
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null check (length(btrim(description)) between 1 and 500),
  when_to_use text not null check (length(btrim(when_to_use)) between 1 and 500),
  instructions text not null check (length(btrim(instructions)) between 1 and 20000),
  version integer not null check (version > 0),
  proposed_action text not null check (proposed_action in ('add', 'update', 'delete')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'superseded')),
  replaces_id bigint references public.procedural_memories(id),
  proposed_by_user_id text not null check (length(proposed_by_user_id) > 0),
  source_conversation_id text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (environment, organization_id, skill_key, version)
);

-- An approved delete is a tombstone, keeping the retirement and its history.
create unique index procedural_memories_approved_idx
  on public.procedural_memories(environment, organization_id, skill_key)
  where status = 'approved';
create index procedural_memories_catalog_idx
  on public.procedural_memories(environment, organization_id, status);

alter table public.procedural_memories enable row level security;
revoke all on public.procedural_memories from anon, authenticated;
grant select, insert, update, delete on public.procedural_memories to service_role;
grant usage, select on sequence public.procedural_memories_id_seq to service_role;

create function public.donna_review_skill_revision()
returns trigger language plpgsql set search_path = '' as $$
declare
  active public.procedural_memories%rowtype;
begin
  -- Serializes proposals/publication for this exact organization/env/skill.
  perform pg_advisory_xact_lock(hashtextextended(new.environment || ':' || new.organization_id || ':' || new.skill_key, 0));
  select * into active from public.procedural_memories
    where environment = new.environment and organization_id = new.organization_id
      and skill_key = new.skill_key and status = 'approved';

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then raise exception 'New skill revisions must be pending'; end if;
    if new.replaces_id is distinct from active.id then
      raise exception 'Skill revision is stale; read the approved skill again';
    end if;
    if new.proposed_action = 'add' then
      if active.id is not null and active.proposed_action <> 'delete' then
        raise exception 'Skill already exists; propose an update';
      end if;
    elsif active.id is null or active.proposed_action = 'delete' then
      raise exception 'No approved skill exists to update or delete';
    end if;
    select coalesce(max(version), 0) + 1 into new.version from public.procedural_memories
      where environment = new.environment and organization_id = new.organization_id and skill_key = new.skill_key;
    new.created_at := now();
    new.reviewed_at := null;
    return new;
  end if;

  -- Review changes status only. To edit instructions, insert a new proposal.
  if (to_jsonb(new) - 'status' - 'reviewed_at') is distinct from
     (to_jsonb(old) - 'status' - 'reviewed_at') then
    raise exception 'Skill revisions are immutable; create a new proposal';
  end if;
  if new.status = old.status then
    new.reviewed_at := old.reviewed_at;
    return new;
  end if;
  if old.status = 'approved' and new.status = 'superseded' then return new; end if;
  if old.status <> 'pending' or new.status not in ('approved', 'rejected') then
    raise exception 'Only pending skill proposals can be approved or rejected';
  end if;
  if new.status = 'approved' then
    if new.replaces_id is distinct from active.id then
      raise exception 'Skill revision is stale; read the approved skill again';
    end if;
    -- Retire the old revision atomically before the unique index is checked.
    update public.procedural_memories set status = 'superseded' where id = active.id;
  end if;
  new.reviewed_at := now();
  return new;
end;
$$;

create trigger procedural_memories_review
  before insert or update on public.procedural_memories
  for each row execute function public.donna_review_skill_revision();
