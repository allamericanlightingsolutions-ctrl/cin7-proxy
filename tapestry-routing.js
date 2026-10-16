'use strict';
const text=value=>String(value??'').trim();
function isTapestry(record){const first=record?.items?.[0]||{};return record?.catalog_client==='tapestry'||first.catalog_client==='tapestry'||first.client==='Tapestry';}
async function prepare(record,supabaseRest,token,table='orders'){
  if(!isTapestry(record))return record;
  if(!/^[0-9a-f-]{36}$/i.test(text(record.id)))throw Error('Save the Tapestry record in Operations before synchronizing it.');
  const records=await supabaseRest(table+'?select=*&id=eq.'+encodeURIComponent(record.id)+'&catalog_client=eq.tapestry',{},token);
  if(records?.length!==1)throw Error('Tapestry record access could not be verified.');
  const saved=records[0],first=saved.items?.[0]||{},key=text(first.store_key||first.store_num);
  const rows=await supabaseRest('tapestry_store_mappings?select=*&store_key=eq.'+encodeURIComponent(key),{},token);
  const mapping=rows?.[0];
  if(!mapping||!text(mapping.cin7_company)||!Number.isSafeInteger(Number(mapping.cin7_member_id))||Number(mapping.cin7_member_id)<=0)throw Error('Cin7 customer/contact mapping is required for '+key+'. Ask Lorna to configure the selected store; no BBW customer will be used.');
  const store=mapping.store_data||{};
  if(saved.items.some(item=>text(item.store_key||item.store_num)!==key||item.store_address!==store.a1||item.store_zip!==store.z||item.store_country!==store.co))throw Error('Tapestry destination does not match the saved store.');
  return {...saved,items:saved.items.map(item=>({...item,tapestry_cin7_company:text(mapping.cin7_company),tapestry_cin7_member_id:Number(mapping.cin7_member_id),brand:mapping.brand}))};
}
function build(order,user){
  const first=order.items?.[0]||{},company=text(first.tapestry_cin7_company),member=Number(first.tapestry_cin7_member_id);
  if(!company||!Number.isSafeInteger(member)||member<=0)throw Error('Verified Tapestry store mapping is required before creating a Cin7 order.');
  const wo=text(order.customer_po||order.work_order_number||first.work_order),name=text(first.requester_name||user?.email||order.user_email),parts=name.split(/\s+/),firstName=parts.shift()||'Tapestry',lastName=parts.join(' ')||'Requester';
  const lineItems=(order.items||[]).map((item,index)=>{const code=text(item.cin7_code||item.part),qty=Number(item.order_qty);if(!code||!Number.isFinite(qty)||qty<=0)throw Error('Invalid Tapestry product row.');return {sort:(index+1)*10,code,styleCode:code,name:text(item.description||code),qty,lineComments:[item.brand,item.store,item.store_num?'Store '+item.store_num:'',item.location].filter(Boolean).join(' | ')};});
  if(!lineItems.length)throw Error('No Tapestry products to order.');
  return {reference:text(order.order_number),customerOrderNo:wo||text(order.order_number),memberId:member,company,firstName,lastName,email:text(order.user_email||user?.email),stage:'New',isApproved:false,deliveryCompany:text(first.store)||'Tapestry',deliveryFirstName:firstName,deliveryLastName:lastName,deliveryAddress1:text(first.store_address),deliveryCity:text(first.store_city),deliveryState:text(first.store_state),deliveryPostalCode:text(first.store_zip),deliveryCountry:text(first.store_country),billingCompany:company,billingEmail:text(order.user_email||user?.email),internalComments:'Created from Tapestry Catalog. Operations '+text(order.order_number)+'. Aqua Team. WO '+wo+'. '+text(order.notes),lineItems,createdDate:new Date().toISOString()};
}
module.exports={isTapestry,prepare,build};

