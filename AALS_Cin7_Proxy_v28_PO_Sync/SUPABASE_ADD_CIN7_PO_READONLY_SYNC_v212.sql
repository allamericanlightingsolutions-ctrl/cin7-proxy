-- AALS Operations v212 - Cin7 Purchase Order read-only synchronization
-- Run once in Supabase SQL Editor before deploying the v212 portal/proxy.
-- Safe to run again. This script does not connect to or modify Cin7.

begin;

alter table public.po_information
  add column if not exists source_system text not null default 'manual',
  add column if not exists sync_read_only boolean not null default false,
  add column if not exists cin7_po_id text,
  add column if not exists cin7_reference text not null default '',
  add column if not exists cin7_customer_order_no text not null default '',
  add column if not exists cin7_modified_at timestamptz,
  add column if not exists cin7_payload jsonb not null default '{}'::jsonb;

create unique index if not exists po_information_cin7_po_id_uidx
  on public.po_information (cin7_po_id)
  where cin7_po_id is not null and btrim(cin7_po_id) <> '';

create index if not exists po_information_source_system_idx
  on public.po_information (source_system);

create index if not exists po_information_cin7_modified_idx
  on public.po_information (cin7_modified_at desc);

create table if not exists public.aals_integration_sync_state (
  sync_key text primary key,
  last_cursor text not null default '',
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_status text not null default '',
  last_message text not null default '',
  last_count integer not null default 0,
  updated_by_email text not null default lower(coalesce(auth.jwt()->>'email','')),
  updated_at timestamptz not null default now()
);

alter table public.aals_integration_sync_state enable row level security;

drop policy if exists aals_sync_state_admin_select on public.aals_integration_sync_state;
drop policy if exists aals_sync_state_admin_insert on public.aals_integration_sync_state;
drop policy if exists aals_sync_state_admin_update on public.aals_integration_sync_state;

create policy aals_sync_state_admin_select on public.aals_integration_sync_state
for select to authenticated using (public.aals_po_is_admin());
create policy aals_sync_state_admin_insert on public.aals_integration_sync_state
for insert to authenticated with check (public.aals_po_is_admin());
create policy aals_sync_state_admin_update on public.aals_integration_sync_state
for update to authenticated using (public.aals_po_is_admin()) with check (public.aals_po_is_admin());

grant select, insert, update on public.aals_integration_sync_state to authenticated;

create or replace function public.set_aals_sync_state_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by_email := lower(coalesce(auth.jwt()->>'email', new.updated_by_email, ''));
  return new;
end;
$$;

drop trigger if exists aals_sync_state_set_updated_at on public.aals_integration_sync_state;
create trigger aals_sync_state_set_updated_at
before update on public.aals_integration_sync_state
for each row execute function public.set_aals_sync_state_updated_at();

create or replace function public.aals_po_match_tokens_v212(p_value text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(distinct token), array[]::text[])
  from (
    select regexp_replace(lower(piece), '[^a-z0-9]+', '', 'g') as token
    from regexp_split_to_table(coalesce(p_value, ''), E'[\\n,;|/]+') piece
  ) tokens
  where length(token) >= 5
    and token not in ('aalsstock', 'notrecorded', 'pending');
$$;

create or replace function public.get_aals_po_updates_v212(
  p_entry_type text,
  p_entry_id text
)
returns table (
  id uuid,
  operations_reference text,
  po_number text,
  status text,
  sku text,
  product_description text,
  quantity text,
  date_ordered text,
  etd text,
  eta text,
  tracking_number text,
  updated_at timestamptz,
  match_method text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_allowed boolean := false;
  v_table text;
  v_record jsonb;
  v_record_text text := '';
  v_record_compact text := '';
  v_profile_team text := '';
  v_record_team text := '';
  v_status text := '';
  v_waiting_materials boolean := false;
begin
  if v_email = '' or btrim(coalesce(p_entry_id, '')) = '' then return; end if;

  v_table := case lower(coalesce(p_entry_type, ''))
    when 'order' then 'orders'
    when 'quote' then 'quotes'
    when 'special_quote' then 'special_quotes'
    else ''
  end;
  if v_table = '' or to_regclass('public.' || v_table) is null then return; end if;

  execute format('select to_jsonb(t) from public.%I t where t.id::text = $1 limit 1', v_table)
    into v_record using p_entry_id;
  if v_record is null then return; end if;

  if public.aals_po_is_admin() then
    v_allowed := true;
  else
    v_allowed := v_email = any(array[
      lower(coalesce(v_record->>'user_email', '')),
      lower(coalesce(v_record->>'created_by_email', '')),
      lower(coalesce(v_record->>'requested_by_email', '')),
      lower(coalesce(v_record->>'customer_email', '')),
      lower(coalesce(v_record->>'email', '')),
      lower(coalesce(v_record->>'submitted_by_email', '')),
      lower(coalesce(v_record->>'authorized_by_email', '')),
      lower(coalesce(v_record->>'approved_by_email', '')),
      lower(coalesce(v_record->>'access_email_override', ''))
    ]);

    if not v_allowed and to_regclass('public.user_profiles') is not null then
      execute 'select lower(coalesce(team, '''')) from public.user_profiles where lower(email) = $1 limit 1'
        into v_profile_team using v_email;
      v_record_team := lower(coalesce(
        v_record->>'team_slug', v_record->>'team', v_record->>'team_name',
        v_record->>'client', v_record->>'client_name', ''
      ));
      v_allowed := btrim(v_profile_team) <> ''
        and regexp_replace(v_profile_team, '[^a-z0-9]+', '', 'g') =
            regexp_replace(v_record_team, '[^a-z0-9]+', '', 'g');
    end if;
  end if;
  if not v_allowed then return; end if;

  v_record_text := lower(v_record::text);
  v_record_compact := regexp_replace(v_record_text, '[^a-z0-9]+', '', 'g');
  v_status := regexp_replace(lower(coalesce(v_record->>'status', '')), '[^a-z0-9]+', '', 'g');
  v_waiting_materials := v_status = any(array[
    'waitingformaterials','waitingmaterials','awaitingmaterials',
    'pendingmaterials','pendingvendor','awaitingvendor','backordered'
  ]);

  return query
  with candidates as (
    select p.*,
      exists (
        select 1 from unnest(public.aals_po_match_tokens_v212(p.operations_reference || '|' || p.cin7_customer_order_no)) token
        where strpos(v_record_compact, token) > 0
      ) as reference_match,
      exists (
        select 1 from unnest(public.aals_po_match_tokens_v212(p.work_order)) token
        where strpos(v_record_compact, token) > 0
      ) as work_order_match,
      exists (
        select 1 from unnest(public.aals_po_match_tokens_v212(p.sku)) token
        where strpos(v_record_compact, token) > 0
      ) as sku_match
    from public.po_information p
  )
  select
    p.id, p.operations_reference, p.po_number, p.status, p.sku,
    p.product_description, p.quantity, p.date_ordered, p.etd, p.eta,
    p.tracking_number, p.updated_at,
    case
      when p.linked_entry_type = lower(coalesce(p_entry_type, '')) and p.linked_entry_id = p_entry_id then 'linked'
      when p.reference_match then 'reference'
      when p.work_order_match then 'work_order'
      else 'sku_quantity'
    end as match_method
  from candidates p
  where
    (p.linked_entry_type = lower(coalesce(p_entry_type, '')) and p.linked_entry_id = p_entry_id)
    or p.reference_match
    or p.work_order_match
    or (
      v_waiting_materials
      and regexp_replace(lower(coalesce(p.status, '')), '[^a-z0-9]+', '', 'g') not in ('delivered','cancelled','canceled','void')
      and p.sku_match
      and (
        btrim(coalesce(p.quantity, '')) = ''
        or exists (
          select 1 from regexp_matches(p.quantity, E'([0-9]+(?:\\.[0-9]+)?)', 'g') quantity_match
          where strpos(v_record_text, quantity_match[1]) > 0
        )
      )
    )
  order by
    case
      when p.linked_entry_type = lower(coalesce(p_entry_type, '')) and p.linked_entry_id = p_entry_id then 0
      when p.reference_match then 1
      when p.work_order_match then 2
      else 3
    end,
    p.updated_at desc;
end;
$$;

revoke all on function public.get_aals_po_updates_v212(text, text) from public;
grant execute on function public.get_aals_po_updates_v212(text, text) to authenticated;

commit;
