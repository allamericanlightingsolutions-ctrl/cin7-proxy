'use strict';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed=new Set(['approved','authorized','ready_to_pick','waiting_materials','purchase_required']);
function isApproved(order){
 return allowed.has(String(order.status||'').toLowerCase()) && !!(order.authorized_at||order.approved_at||String(order.notes||'').includes('[CATALOG AUTO AUTHORIZATION]'));
}
async function resolve(order,token,rest){
 if(!order||!uuid.test(String(order.id||''))){
  if(order?.catalog_client==='tapestry')throw Error('A saved Tapestry order is required.');
  return {order,teamOrder:false};
 }
 const saved=await rest('orders?select=*&id=eq.'+encodeURIComponent(order.id)+'&limit=1',{},token);
 if(!saved?.[0])throw Error('This saved order is not available to your account.');
 if(saved[0].catalog_client!=='tapestry')return {order,teamOrder:false};
 const verified=await rest('rpc/tapestry_order_approval_v1',{method:'POST',body:JSON.stringify({p_order_id:order.id,p_action:'read'})},token);
 if(!verified?.order||verified.order.catalog_client!=='tapestry'||!isApproved(verified.order))throw Error('Aqua Team approval is required before sending this order to Cin7.');
 return {order:verified.order,teamOrder:true};
}
async function claim(order,token,rest){
 const result=await rest('rpc/tapestry_order_approval_v1',{method:'POST',body:JSON.stringify({p_order_id:order.id,p_action:'claim_sync'})},token);
 if(!result?.claimed)throw Error('This order is already synchronizing or requires AALS review. Refresh My Orders; no duplicate will be sent.');
}
module.exports={isApproved,resolve,claim};
