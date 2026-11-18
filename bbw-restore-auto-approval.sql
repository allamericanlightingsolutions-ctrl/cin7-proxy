-- Restore BBW automatic authorization. Do not re-run bbw-order-approval.sql.
-- No order records are deleted or changed. Retain any audit history.
drop trigger if exists zzz_bbw_pending_order_v1 on public.orders;
revoke execute on function public.bbw_can_approve_order_v1() from authenticated;
revoke execute on function public.bbw_order_approval_v1(uuid,text) from authenticated;
revoke execute on function public.bbw_catalog_approval_orders_v1(integer,integer) from authenticated;
