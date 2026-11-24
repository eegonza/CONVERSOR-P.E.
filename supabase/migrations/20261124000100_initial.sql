begin;

create schema app_private;
revoke all on schema app_private from public, anon, authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  email text,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  role text not null default 'operator' check (role in ('admin', 'operator')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.conversions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  filename text not null check (char_length(filename) between 5 and 255),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  extraction jsonb not null check (jsonb_typeof(extraction) = 'object'),
  uploaded_at timestamptz not null,
  processed_at timestamptz not null check (processed_at >= uploaded_at),
  unique (user_id, sha256)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  user_name text not null,
  conversion_id uuid references public.conversions (id) on delete restrict,
  event_type text not null check (event_type in (
    'conversion_registered', 'processing_failed', 'review_saved', 'export_approved',
    'user_created', 'user_profile_updated'
  )),
  details jsonb not null check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index conversions_user_history on public.conversions (user_id, uploaded_at desc);
create index conversions_history on public.conversions (uploaded_at desc);
create index audit_user_history on public.audit_events (user_id, created_at desc);
create index audit_history on public.audit_events (created_at desc);
create index audit_conversion_history on public.audit_events (conversion_id, created_at desc);

create unique index audit_approved_snapshot on public.audit_events (
  user_id, conversion_id, event_type, (details ->> 'number'), (details ->> 'preview_hash'),
  (details ->> 'acceptance_hash')
) where event_type in ('review_saved', 'export_approved');

create unique index audit_created_profile on public.audit_events ((details ->> 'target_id'))
where event_type = 'user_created';

revoke all on public.profiles, public.conversions, public.audit_events
  from public, anon, authenticated, service_role;
grant select on public.profiles, public.conversions, public.audit_events to authenticated;

alter table public.profiles enable row level security;
alter table public.conversions enable row level security;
alter table public.audit_events enable row level security;

create function app_private.current_active_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid()) and active;
$$;

create policy read_profiles on public.profiles for select to authenticated
using (
  (select app_private.current_active_role()) = 'admin'
  or (id = (select auth.uid()) and (select app_private.current_active_role()) = 'operator')
);

create policy read_conversions on public.conversions for select to authenticated
using (
  (select app_private.current_active_role()) = 'admin'
  or (user_id = (select auth.uid()) and (select app_private.current_active_role()) = 'operator')
);

create policy read_audit_events on public.audit_events for select to authenticated
using (
  (select app_private.current_active_role()) = 'admin'
  or (user_id = (select auth.uid()) and (select app_private.current_active_role()) = 'operator')
);

create function app_private.profile_name(p_full_name text, p_email text)
returns text
language sql immutable
set search_path = ''
as $$
  select left(coalesce(nullif(btrim(p_full_name), ''), nullif(split_part(p_email, '@', 1), ''), 'Usuario'), 120);
$$;

create function app_private.provision_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_actor_id text := new.raw_app_meta_data ->> 'provisioned_by';
  v_role text := 'operator';
  v_target public.profiles;
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (id, email, full_name, created_at)
    values (
      new.id, new.email, app_private.profile_name(new.raw_user_meta_data ->> 'full_name', new.email),
      coalesce(new.created_at, now())
    );
  elsif old.raw_app_meta_data ->> 'provisioned_by' is not null then
    return new;
  end if;

  if v_actor_id is null or exists (
    select 1 from public.audit_events where event_type = 'user_created' and details ->> 'target_id' = new.id::text
  ) then
    return new;
  end if;

  if v_actor_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'Identificador de aprovisionamiento inválido' using errcode = '22023';
  end if;
  select * into v_actor from public.profiles
  where id = v_actor_id::uuid and active and role = 'admin' for share;
  if not found then
    raise exception 'Se requiere un administrador activo' using errcode = '42501';
  end if;
  v_role := coalesce(new.raw_app_meta_data ->> 'provisioned_role', 'operator');
  if v_role not in ('admin', 'operator') then
    raise exception 'Rol de aprovisionamiento inválido' using errcode = '22023';
  end if;

  update public.profiles set role = v_role, active = true,
    full_name = app_private.profile_name(new.raw_user_meta_data ->> 'full_name', new.email)
  where id = new.id returning * into strict v_target;
  insert into public.audit_events (user_id, user_name, event_type, details)
  values (v_actor.id, v_actor.full_name, 'user_created', jsonb_build_object(
    'target_id', v_target.id, 'full_name', v_target.full_name, 'role', v_target.role, 'email', v_target.email
  ));
  return new;
end;
$$;

-- GoTrue versions may apply trusted app metadata after inserting the Auth user.
create trigger conversor_auth_user_provisioned
after insert or update of raw_app_meta_data on auth.users
for each row execute function app_private.provision_profile();

insert into public.profiles (id, email, full_name, created_at)
select id, email, app_private.profile_name(raw_user_meta_data ->> 'full_name', email), coalesce(created_at, now())
from auth.users;

create function app_private.refresh_profile_email()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger conversor_auth_email_changed
after update of email on auth.users
for each row when (old.email is distinct from new.email)
execute function app_private.refresh_profile_email();

create function app_private.require_actor(p_actor uuid, p_admin boolean default false)
returns public.profiles
language plpgsql
set search_path = ''
as $$
declare
  v_actor public.profiles;
begin
  select * into v_actor from public.profiles
  where id = p_actor and active
  for share;
  if not found or (p_admin and v_actor.role <> 'admin') then
    raise exception 'Permiso insuficiente' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create function app_private.validate_source(p_filename text, p_sha256 text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_filename is null or char_length(p_filename) not between 5 and 255
    or p_filename !~* '\.pdf$' or p_filename ~ '[/[:cntrl:]]' or strpos(p_filename, chr(92)) > 0
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Nombre de PDF o huella inválidos' using errcode = '22023';
  end if;
end;
$$;

create function app_private.register_conversion(
  p_actor uuid, p_filename text, p_sha256 text, p_extraction jsonb, p_uploaded_at timestamptz
)
returns public.conversions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_conversion public.conversions;
  v_registered_at timestamptz;
begin
  v_actor := app_private.require_actor(p_actor);
  perform app_private.validate_source(p_filename, p_sha256);
  if jsonb_typeof(p_extraction) is distinct from 'object' or pg_column_size(p_extraction) > 20971520 then
    raise exception 'Extracción inválida' using errcode = '22023';
  end if;
  if p_uploaded_at is not null and not isfinite(p_uploaded_at) then
    raise exception 'Fecha de carga inválida' using errcode = '22023';
  end if;

  v_registered_at := clock_timestamp();
  insert into public.conversions (user_id, filename, sha256, extraction, uploaded_at, processed_at)
  values (
    v_actor.id, p_filename, p_sha256, p_extraction,
    least(coalesce(p_uploaded_at, v_registered_at), v_registered_at), v_registered_at
  )
  on conflict (user_id, sha256) do nothing
  returning * into v_conversion;

  if not found then
    select * into strict v_conversion from public.conversions
    where user_id = v_actor.id and sha256 = p_sha256;
    return v_conversion;
  end if;

  insert into public.audit_events (user_id, user_name, conversion_id, event_type, details)
  values (v_actor.id, v_actor.full_name, v_conversion.id, 'conversion_registered',
    jsonb_build_object('filename', p_filename, 'sha256', p_sha256));
  return v_conversion;
end;
$$;

create function app_private.record_snapshot(
  p_actor uuid, p_event_type text, p_conversion_id uuid, p_number text, p_filename text,
  p_preview_hash text, p_preview jsonb, p_acceptance text
)
returns public.audit_events
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_event public.audit_events;
  v_review public.audit_events;
  v_acceptance text := nullif(btrim(p_acceptance), '');
  v_acceptance_hash text;
begin
  v_actor := app_private.require_actor(p_actor);
  if p_event_type is null or p_event_type not in ('review_saved', 'export_approved')
    or p_number is null or p_number !~ '^[0-9]{1,40}$'
    or p_preview_hash is null or p_preview_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_preview) is distinct from 'object' or pg_column_size(p_preview) > 20971520
    or char_length(v_acceptance) > 2000
    or (p_event_type = 'export_approved' and p_filename is distinct from 'SALIDA ' || p_number || '.xlsx')
    or (p_event_type = 'review_saved' and (p_filename is not null or p_acceptance is not null)) then
    raise exception 'Instantánea, número de salida o nombre de archivo inválido' using errcode = '22023';
  end if;

  perform 1 from public.conversions
  where id = p_conversion_id and (user_id = v_actor.id or v_actor.role = 'admin');
  if not found then
    raise exception 'Conversión no disponible' using errcode = 'P0002';
  end if;

  if p_event_type = 'export_approved' then
    select * into v_review from public.audit_events
    where user_id = v_actor.id and conversion_id = p_conversion_id and event_type = 'review_saved'
      and details ->> 'number' = p_number and details ->> 'preview_hash' = p_preview_hash;
    if not found or v_review.details -> 'preview' is distinct from p_preview then
      raise exception 'La exportación requiere la revisión previa de esta vista' using errcode = '22023';
    end if;
  end if;

  v_acceptance_hash := encode(sha256(convert_to(coalesce(v_acceptance, ''), 'UTF8')), 'hex');
  insert into public.audit_events (user_id, user_name, conversion_id, event_type, details)
  values (v_actor.id, v_actor.full_name, p_conversion_id, p_event_type, jsonb_build_object(
    'number', p_number, 'filename', p_filename, 'preview_hash', p_preview_hash,
    'preview', p_preview, 'acceptance', v_acceptance, 'acceptance_hash', v_acceptance_hash, 'review_id', v_review.id
  ))
  on conflict do nothing
  returning * into v_event;

  if not found then
    select * into strict v_event from public.audit_events
    where user_id = v_actor.id and conversion_id = p_conversion_id and event_type = p_event_type
      and details ->> 'number' = p_number and details ->> 'preview_hash' = p_preview_hash
      and details ->> 'acceptance_hash' = v_acceptance_hash;
    if v_event.details -> 'preview' is distinct from p_preview
      or v_event.details ->> 'acceptance' is distinct from v_acceptance then
      raise exception 'La huella ya corresponde a otra instantánea' using errcode = '22023';
    end if;
  end if;
  return v_event;
end;
$$;

create function app_private.record_processing_failure(p_actor uuid, p_filename text, p_sha256 text, p_reason text)
returns public.audit_events
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_event public.audit_events;
begin
  v_actor := app_private.require_actor(p_actor);
  perform app_private.validate_source(p_filename, p_sha256);
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 2000 then
    raise exception 'Motivo de procesamiento inválido' using errcode = '22023';
  end if;
  insert into public.audit_events (user_id, user_name, event_type, details)
  values (v_actor.id, v_actor.full_name, 'processing_failed',
    jsonb_build_object('filename', p_filename, 'sha256', p_sha256, 'reason', btrim(p_reason)))
  returning * into v_event;
  return v_event;
end;
$$;

create function app_private.update_profile(p_target uuid, p_full_name text, p_role text, p_active boolean)
returns public.profiles
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_before public.profiles;
  v_after public.profiles;
begin
  -- Serialize profile administration before taking profile row locks.
  perform pg_advisory_xact_lock(1161907063, 942105622);
  v_actor := app_private.require_actor((select auth.uid()), true);

  if p_full_name is null or char_length(btrim(p_full_name)) not between 1 and 120
    or p_role is null or p_role not in ('admin', 'operator') or p_active is null then
    raise exception 'Perfil inválido' using errcode = '22023';
  end if;
  if p_target = v_actor.id and (p_role <> 'admin' or not p_active) then
    raise exception 'Un administrador activo no puede desactivarse ni cambiar su propio rol' using errcode = '42501';
  end if;

  select * into v_before from public.profiles where id = p_target for update;
  if not found then
    raise exception 'Perfil no disponible' using errcode = 'P0002';
  end if;
  if v_before.role = 'admin' and v_before.active and (p_role <> 'admin' or not p_active)
    and not exists (select 1 from public.profiles where role = 'admin' and active and id <> p_target) then
    raise exception 'Debe quedar un administrador activo' using errcode = '42501';
  end if;
  if (v_before.full_name, v_before.role, v_before.active) = (btrim(p_full_name), p_role, p_active) then
    return v_before;
  end if;

  update public.profiles set full_name = btrim(p_full_name), role = p_role, active = p_active
  where id = p_target returning * into v_after;
  insert into public.audit_events (user_id, user_name, event_type, details)
  values (v_actor.id, v_actor.full_name, 'user_profile_updated', jsonb_build_object(
    'target_id', p_target,
    'before', jsonb_build_object('full_name', v_before.full_name, 'role', v_before.role, 'active', v_before.active),
    'after', jsonb_build_object('full_name', v_after.full_name, 'role', v_after.role, 'active', v_after.active)
  ));
  return v_after;
end;
$$;

-- PostgREST exposes public wrappers. Privileged implementations are outside exposed schemas.
create function public.register_conversion(
  p_actor uuid, p_filename text, p_sha256 text, p_extraction jsonb, p_uploaded_at timestamptz default null
)
returns public.conversions
language sql
set search_path = ''
as $$
  select * from app_private.register_conversion(p_actor, p_filename, p_sha256, p_extraction, p_uploaded_at);
$$;

create function public.record_review(p_actor uuid, p_conversion_id uuid, p_number text, p_preview_hash text, p_preview jsonb)
returns public.audit_events
language sql
set search_path = ''
as $$
  select * from app_private.record_snapshot(
    p_actor, 'review_saved', p_conversion_id, p_number, null, p_preview_hash, p_preview, null
  );
$$;

create function public.record_export(
  p_actor uuid, p_conversion_id uuid, p_number text, p_filename text,
  p_preview_hash text, p_preview jsonb, p_acceptance text
)
returns public.audit_events
language sql
set search_path = ''
as $$
  select * from app_private.record_snapshot(
    p_actor, 'export_approved', p_conversion_id, p_number, p_filename, p_preview_hash, p_preview, p_acceptance
  );
$$;

create function public.record_processing_failure(p_actor uuid, p_filename text, p_sha256 text, p_reason text)
returns public.audit_events
language sql
set search_path = ''
as $$
  select * from app_private.record_processing_failure(p_actor, p_filename, p_sha256, p_reason);
$$;

create function public.update_profile(p_target uuid, p_full_name text, p_role text, p_active boolean)
returns public.profiles
language sql
set search_path = ''
as $$
  select * from app_private.update_profile(p_target, p_full_name, p_role, p_active);
$$;

revoke all on all functions in schema app_private from public, anon, authenticated, service_role;
grant usage on schema app_private to authenticated, service_role;
grant execute on function
  app_private.current_active_role(),
  app_private.update_profile(uuid, text, text, boolean)
to authenticated;

grant execute on function
  app_private.register_conversion(uuid, text, text, jsonb, timestamptz),
  app_private.record_snapshot(uuid, text, uuid, text, text, text, jsonb, text),
  app_private.record_processing_failure(uuid, text, text, text)
to service_role;

revoke all on function
  public.register_conversion(uuid, text, text, jsonb, timestamptz),
  public.record_review(uuid, uuid, text, text, jsonb),
  public.record_export(uuid, uuid, text, text, text, jsonb, text),
  public.record_processing_failure(uuid, text, text, text),
  public.update_profile(uuid, text, text, boolean)
from public, anon, authenticated, service_role;

grant execute on function public.update_profile(uuid, text, text, boolean) to authenticated;

grant execute on function
  public.register_conversion(uuid, text, text, jsonb, timestamptz),
  public.record_review(uuid, uuid, text, text, jsonb),
  public.record_export(uuid, uuid, text, text, text, jsonb, text),
  public.record_processing_failure(uuid, text, text, text)
to service_role;

commit;
