-- Scoped BBW approval audit; direct browser writes to this table are not granted.
create table if not exists public.bbw_order_approvals_v1 (
 order_id uuid primary key references public.orders(id) on delete cascade,
 approved_by_user uuid not null,
 approved_by_email text not null,
 approved_at timestamptz not null default now(),
 approved_items jsonb not null,
 sync_claimed_at timestamptz
);
alter table public.bbw_order_approvals_v1 enable row level security;
revoke all on public.bbw_order_approvals_v1 from public,anon,authenticated;

create or replace function public.bbw_can_approve_order_v1()
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
 lower(coalesce(auth.jwt()->>'email','')) in ('goldteam@allamericanfacilities.com','constructionteam@allamericanfacilities.com','l.gonzalez@allamericanlightingsolutions.com','l.gonzalez@aalsusa.com','r.soviero@allamericanfacilities.com')
 or exists(select 1 from public.aals_admin_users a where lower(a.email)=lower(auth.jwt()->>'email') and a.is_active=true));
$$;
revoke all on function public.bbw_can_approve_order_v1() from public,anon;
grant execute on function public.bbw_can_approve_order_v1() to authenticated;

create or replace function public.bbw_order_approval_v1(p_order_id uuid,p_action text default 'read')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); email text:=lower(coalesce(auth.jwt()->>'email',''));
 can_approve boolean:=public.bbw_can_approve_order_v1();
 r public.orders; audit public.bbw_order_approvals_v1; approved_now boolean:=false; claimed boolean:=false; approved_for_sync boolean:=false;
begin
 if actor is null or email='' then raise exception 'A signed-in session is required.' using errcode='42501';end if;
 if p_action is null or p_action not in ('read','approve','claim_sync') then raise exception 'Unsupported action.';end if;
 select * into r from public.orders where id=p_order_id for update;
 if not found or coalesce(r.catalog_client,'')='tapestry' or not (coalesce(r.catalog_client,'')='bbw' or coalesce(r.items->0->>'client','')='Bath & Body Works') or coalesce(r.source,'')<>'catalog' or coalesce(r.external_source,'')='cin7_sales_orders' or coalesce(r.order_number,r.reference,'') !~ '^AALS-[0-9]+$'
 then raise exception 'This BBW catalog order is not available.' using errcode='42501';end if;
 if not coalesce(can_approve,false) and r.user_id is distinct from actor then raise exception 'This BBW order is not available to your account.' using errcode='42501';end if;
 if r.spr_active_request is not null then raise exception 'This order is managed by its Special Product Request.';end if;
 select * into audit from public.bbw_order_approvals_v1 where order_id=r.id;
 if p_action='approve' then
  if not coalesce(can_approve,false) then raise exception 'Only Gold Team, Construction Team or authorized AALS administrators can approve BBW orders.' using errcode='42501';end if;
  if r.status in ('created','pending_approval','quote_in_progress') then
   if nullif(btrim(r.cin7_order_id),'') is not null or coalesce(r.tracking,r.tracking_number,'')<>'' then raise exception 'A linked or shipped order cannot be approved again.';end if;
   if audit.sync_claimed_at is not null then raise exception 'This order already has a synchronization claim. Ask AALS to review it.';end if;
   if coalesce(nullif(btrim(r.work_order_number),''),nullif(btrim(r.customer_po),''),nullif(btrim(r.items->0->>'work_order'),''),nullif(btrim(r.items->0->>'customer_po'),'')) is null then raise exception 'The Work Order number is required before approval.';end if;
   if jsonb_typeof(r.items) is distinct from 'array' or jsonb_array_length(r.items)=0 then raise exception 'Products are required before approval.';end if;
   insert into public.bbw_order_approvals_v1(order_id,approved_by_user,approved_by_email,approved_items)
   values(r.id,actor,email,r.items)
   on conflict(order_id) do update set approved_by_user=excluded.approved_by_user,approved_by_email=excluded.approved_by_email,approved_at=now(),approved_items=excluded.approved_items;
   update public.orders set status='approved',approved_by=email,approved_by_email=email,approved_at=now(),authorized_by=actor,authorized_by_email=email,authorized_at=now(),updated_at=now(),updated_by_email=email,updated_by_user_id=actor::text where id=r.id returning * into r;
   approved_now:=true;
  elsif r.status not in ('approved','authorized','ready_to_pick','waiting_materials','purchase_required') then raise exception 'This order is no longer awaiting approval.';end if;
  select * into audit from public.bbw_order_approvals_v1 where order_id=r.id;
 end if;
 approved_for_sync:=r.status in ('approved','authorized','ready_to_pick','waiting_materials','purchase_required') and (
  (audit.order_id is not null and audit.approved_items=r.items)
  or (r.catalog_client is distinct from 'bbw' and position('[BBW APPROVAL REQUIRED]' in coalesce(r.notes,''))=0 and (r.authorized_at is not null or r.approved_at is not null or position('[CATALOG AUTO AUTHORIZATION]' in coalesce(r.notes,''))>0)));
 if p_action='claim_sync' then
  if not coalesce(approved_for_sync,false) then raise exception 'BBW Team approval is required before sending this order to Cin7.';end if;
  if nullif(btrim(r.cin7_order_id),'') is null and coalesce(r.cin7_status,'')<>'bbw_approval_sending' and audit.sync_claimed_at is null then
   update public.orders set cin7_status='bbw_approval_sending',updated_at=now() where id=r.id returning * into r;
   update public.bbw_order_approvals_v1 set sync_claimed_at=now() where order_id=r.id;
   claimed:=true;
  end if;
 end if;
 return jsonb_build_object('order',to_jsonb(r),'can_approve',can_approve,'approved_now',approved_now,'approved_for_sync',coalesce(approved_for_sync,false),'claimed',claimed);
end;$$;
revoke all on function public.bbw_order_approval_v1(uuid,text) from public,anon;
grant execute on function public.bbw_order_approval_v1(uuid,text) to authenticated;

-- Define now, attach after the server and catalog have been deployed.
create or replace function public.bbw_pending_order_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if old.catalog_client='bbw' then
   if new.catalog_client is distinct from old.catalog_client or new.source is distinct from old.source or new.external_source is distinct from old.external_source then raise exception 'The BBW catalog origin cannot be changed.';end if;
  end if;
  return new;
 end if;
 if auth.uid() is not null and (new.catalog_client='bbw' or (coalesce(new.catalog_client,'')<>'tapestry' and new.items->0->>'client'='Bath & Body Works')) and new.spr_active_request is null and coalesce(new.source,'')='catalog' and coalesce(new.external_source,'')<>'cin7_sales_orders' and coalesce(new.order_number,new.reference,'') ~ '^AALS-[0-9]+$' then
  new.catalog_client:='bbw';new.status:='pending_approval';new.approved_by:=null;new.approved_by_email:=null;new.approved_at:=null;new.authorized_by:=null;new.authorized_by_email:=null;new.authorized_at:=null;
 end if;
 return new;
end;$$;

create or replace function public.bbw_catalog_approval_orders_v1(p_offset integer default 0,p_limit integer default 200)
returns setof public.orders language plpgsql security definer set search_path='' as $$
begin
 if not public.bbw_can_approve_order_v1() then raise exception 'BBW Team approval access required.' using errcode='42501';end if;
 return query select o.* from public.orders o where o.catalog_client='bbw' and o.source='catalog' and coalesce(o.external_source,'')='' and coalesce(o.order_number,o.reference,'') ~ '^AALS-[0-9]+$' order by o.created_at desc,o.id offset greatest(coalesce(p_offset,0),0) limit least(greatest(coalesce(p_limit,200),1),200);
end;$$;
revoke all on function public.bbw_catalog_approval_orders_v1(integer,integer) from public,anon;
grant execute on function public.bbw_catalog_approval_orders_v1(integer,integer) to authenticated;

-- Activate only after the backend guard and the BBW catalog are published.
drop trigger if exists zzz_bbw_pending_order_v1 on public.orders;
create trigger zzz_bbw_pending_order_v1 before insert or update on public.orders for each row execute function public.bbw_pending_order_v1();
