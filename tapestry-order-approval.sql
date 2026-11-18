-- Tapestry orders require explicit Aqua Team approval. No historical rows are changed.
create or replace function public.tapestry_order_approval_v1(p_order_id uuid, p_action text default 'read')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 actor uuid:=auth.uid(); actor_email text:=lower(coalesce(auth.jwt()->>'email',''));
 role_name text:=public.tapestry_member_role_v1(); staff boolean:=public.tapestry_staff_v1();
 record public.orders; did_approve boolean:=false; did_claim boolean:=false;
begin
 if actor is null or actor_email='' then raise exception 'A signed-in session is required.' using errcode='42501';end if;
 if p_action not in ('read','approve','claim_sync') then raise exception 'Unsupported action.';end if;
 select * into record from public.orders where id=p_order_id and catalog_client='tapestry' for update;
 if not found or not public.tapestry_record_access_v1(record.user_id) then raise exception 'This Tapestry order is not available to your account.' using errcode='42501';end if;
 if p_action='approve' then
  if not (coalesce(role_name,'')='team' or coalesce(staff,false)) then raise exception 'Only Aqua Team or authorized AALS staff can approve Tapestry orders.' using errcode='42501';end if;
  if record.spr_active_request is not null then raise exception 'This order is managed by its Special Product Request.';end if;
  if record.status in ('created','pending_approval','quote_in_progress') then
   if coalesce(record.tracking,record.tracking_number,'')<>'' then raise exception 'An order with tracking cannot be approved again.';end if;
   if coalesce(nullif(btrim(record.work_order_number),''),nullif(btrim(record.customer_po),''),nullif(btrim(record.items->0->>'work_order'),''),nullif(btrim(record.items->0->>'customer_po'),'')) is null then raise exception 'The Work Order number is required before approval.';end if;
   if jsonb_typeof(record.items) is distinct from 'array' or jsonb_array_length(record.items)=0 then raise exception 'Products are required before approval.';end if;
   update public.orders set status='approved',approved_by=actor_email,approved_by_email=actor_email,approved_at=now(),authorized_by=actor,authorized_by_email=actor_email,authorized_at=now(),updated_at=now(),updated_by_email=actor_email,updated_by_user_id=actor::text where id=record.id returning * into record;
   did_approve:=true;
  elsif record.status not in ('approved','authorized','ready_to_pick','waiting_materials','purchase_required') then
   raise exception 'This order is no longer awaiting approval.';
  end if;
 end if;
 if p_action='claim_sync' then
  if record.status not in ('approved','authorized','ready_to_pick','waiting_materials','purchase_required') or (record.authorized_at is null and record.approved_at is null and position('[CATALOG AUTO AUTHORIZATION]' in coalesce(record.notes,''))=0) then raise exception 'Aqua Team approval is required before sending this order to Cin7.';end if;
  if nullif(btrim(record.cin7_order_id),'') is null and coalesce(record.cin7_status,'')<>'tapestry_approval_sending' then
   update public.orders set cin7_status='tapestry_approval_sending',updated_at=now() where id=record.id returning * into record;
   did_claim:=true;
  end if;
 end if;
 return jsonb_build_object('order',to_jsonb(record),'approved_now',did_approve,'claimed',did_claim);
end;$$;
revoke all on function public.tapestry_order_approval_v1(uuid,text) from public,anon;
grant execute on function public.tapestry_order_approval_v1(uuid,text) to authenticated;

create or replace function public.tapestry_pending_order_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 if new.catalog_client='tapestry' and new.spr_active_request is null and auth.uid() is not null and coalesce(new.source,'')<>'cin7' and coalesce(new.external_source,'')<>'cin7_sales_orders' then
  new.status:='pending_approval';new.approved_by:=null;new.approved_by_email:=null;new.approved_at:=null;new.authorized_by:=null;new.authorized_by_email:=null;new.authorized_at:=null;
 end if;
 return new;
end;$$;
create trigger zzz_tapestry_pending_order_v1 before insert on public.orders for each row execute function public.tapestry_pending_order_v1();
