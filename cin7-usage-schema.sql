begin;

create table public.cin7_usage_events (
  id uuid primary key,
  occurred_at timestamptz not null,
  connection text not null,
  module text not null check (module in ('bbw', 'tapestry', 'operations', 'warehouse', 'unattributed')),
  endpoint text not null,
  method text not null,
  http_status integer,
  attempt_number integer not null check (attempt_number >= 1)
);
create index cin7_usage_events_connection_time_idx
  on public.cin7_usage_events (connection, occurred_at desc);

create table public.cin7_usage_alerts (
  id uuid primary key default gen_random_uuid(),
  connection text not null,
  threshold integer not null,
  claimed_at timestamptz not null default now(),
  sent_at timestamptz
);
create index cin7_usage_alerts_connection_threshold_idx
  on public.cin7_usage_alerts (connection, threshold, claimed_at desc);

alter table public.cin7_usage_events enable row level security;
alter table public.cin7_usage_alerts enable row level security;
revoke all on public.cin7_usage_events, public.cin7_usage_alerts from public, anon, authenticated;
grant select, insert on public.cin7_usage_events to service_role;
grant select, insert, update on public.cin7_usage_alerts to service_role;

create function public.cin7_usage_summary(p_connection text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with modules as (
    select module,
           count(*) as attempts,
           count(*) filter (where http_status = 429) as rate_limited,
           count(*) filter (where http_status is null) as outcome_unknown
    from public.cin7_usage_events
    where connection = p_connection
      and occurred_at > now() - interval '24 hours'
      and occurred_at <= now()
    group by module
  )
  select jsonb_build_object(
    'connection', p_connection,
    'window_start', now() - interval '24 hours',
    'window_end', now(),
    'attempts', coalesce(sum(attempts), 0),
    'estimated_calls', coalesce(sum(attempts - rate_limited), 0),
    'rate_limited', coalesce(sum(rate_limited), 0),
    'outcome_unknown', coalesce(sum(outcome_unknown), 0),
    'modules', coalesce(jsonb_agg(
      jsonb_build_object('module', module, 'attempts', attempts, 'estimated_calls', attempts - rate_limited,
                         'rate_limited', rate_limited, 'outcome_unknown', outcome_unknown)
      order by attempts - rate_limited desc, module), '[]'::jsonb)
  )
  from modules;
$$;

create function public.cin7_usage_claim_alert(p_connection text, p_threshold integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  usage jsonb;
  alert_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_connection || ':' || p_threshold, 0));
  if exists (
    select 1 from public.cin7_usage_alerts
    where connection = p_connection and threshold = p_threshold
      and (sent_at > now() - interval '24 hours'
           or (sent_at is null and claimed_at > now() - interval '15 minutes'))
  ) then
    return null;
  end if;
  usage := public.cin7_usage_summary(p_connection);
  if (usage ->> 'estimated_calls')::bigint < p_threshold then
    return null;
  end if;
  insert into public.cin7_usage_alerts (connection, threshold)
    values (p_connection, p_threshold) returning id into alert_id;
  return usage || jsonb_build_object('id', alert_id);
end;
$$;

create function public.cin7_usage_mark_alert_sent(p_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.cin7_usage_alerts set sent_at = now() where id = p_id and sent_at is null;
$$;

revoke execute on function public.cin7_usage_summary(text),
  public.cin7_usage_claim_alert(text, integer), public.cin7_usage_mark_alert_sent(uuid)
  from public, anon, authenticated;
grant execute on function public.cin7_usage_summary(text),
  public.cin7_usage_claim_alert(text, integer), public.cin7_usage_mark_alert_sent(uuid)
  to service_role;

commit;
