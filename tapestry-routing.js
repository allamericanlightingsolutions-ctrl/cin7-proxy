'use strict';
const directory=require('./tapestry-store-directory.json');
const text=value=>String(value??'').trim();
const normalized=value=>text(value).toUpperCase().replace(/\s+/g,' ');
const country=value=>({USA:'US','UNITED STATES':'US','UNITED STATES OF AMERICA':'US',CANADA:'CA'})[normalized(value)]||normalized(value);
const state=value=>normalized(value)==='FLORIDA'?'FL':normalized(value);
const postal=value=>normalized(value).replace(/\s+/g,'');
const BILLING_ID=293;
const BILLING=Object.freeze({address1:'710 International Parkway',address2:'',city:'Sunrise',state:'Florida',postalCode:'33325',country:'USA'});
const verified=new WeakSet();
let billingCache=null,billingPending=null;
function isTapestry(record){const first=record?.items?.[0]||{};return record?.catalog_client==='tapestry'||first.catalog_client==='tapestry'||first.client==='Tapestry';}
function unpack(value){return Array.isArray(value)?value[0]:(value?.Contact||value?.contact||value);}
function field(object,name){return object?.[name]??object?.[name[0].toUpperCase()+name.slice(1)];}
function sameBillingAddress(contact,prefix){
 const get=name=>field(contact,prefix?prefix+name[0].toUpperCase()+name.slice(1):name);
 return normalized(get('address1'))===normalized(BILLING.address1)&&normalized(get('city'))==='SUNRISE'&&state(get('state'))==='FL'&&postal(get('postCode'))==='33325'&&country(get('country'))==='US';
}
async function billingContact(deps){
 if(!deps||typeof deps.cin7Fetch!=='function'||!text(deps.CIN7_BASE_URL))throw Error('Tapestry billing integration is not configured on the server.');
 if(billingCache&&billingCache.base===deps.CIN7_BASE_URL&&billingCache.until>Date.now())return billingCache.value;
 if(billingPending&&billingPending.base===deps.CIN7_BASE_URL)return billingPending.promise;
 const pending={base:deps.CIN7_BASE_URL};
 pending.promise=(async()=>{
  const contact=unpack(await deps.cin7Fetch(deps.CIN7_BASE_URL+'/Contacts/'+BILLING_ID));
  if(Number(field(contact,'id'))!==BILLING_ID)throw Error('Cin7 billing contact 293 could not be verified.');
  const company=text(field(contact,'company'));
  if(!/^All American Facilit(?:y|ies) Mainten/i.test(company)||(!sameBillingAddress(contact,'')&&!sameBillingAddress(contact,'postal')))throw Error('Cin7 contact 293 does not match the approved billing company and Sunrise address. Review billing setup before creating an order.');
  const value=Object.freeze({...BILLING,company,id:BILLING_ID,email:text(field(contact,'billingEmail')||field(contact,'email'))});
  billingCache={base:deps.CIN7_BASE_URL,until:Date.now()+15*60*1000,value};return value;
 })();
 billingPending=pending;
 try{return await pending.promise;}finally{if(billingPending===pending)billingPending=null;}
}
function storeKey(item){return text(item?.store_key||item?.store_num);}
function validateDestination(items){
 if(!Array.isArray(items)||!items.length)throw Error('A Tapestry store destination is required.');
 const key=storeKey(items[0]),store=directory[key];
 if(!store||!['Coach','Kate Spade','Stuart Weitzman'].includes(store.brand))throw Error('Select a recognized Tapestry store before creating the order.');
 if(!text(store.a1)||!text(store.ca)||!text(store.sa)||!text(store.z)||!['US','CA'].includes(country(store.co)))throw Error('The selected Tapestry store has an incomplete delivery address.');
 for(const item of items){
  if(storeKey(item)!==key||normalized(item.store_address)!==normalized(store.a1)||normalized(item.store_city)!==normalized(store.ca)||state(item.store_state)!==state(store.sa)||postal(item.store_zip)!==postal(store.z)||country(item.store_country)!==country(store.co))throw Error('Tapestry delivery address does not match the selected store. Correct the saved request before creating its order.');
 }
 return store;
}
async function prepare(record,supabaseRest,token,table='orders',deps){
 if(!isTapestry(record))return record;
 if(!['orders','quotes'].includes(table)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(record.id)))throw Error('Save the Tapestry record in Operations before synchronizing it.');
 const records=await supabaseRest(table+'?select=*&id=eq.'+encodeURIComponent(record.id)+'&catalog_client=eq.tapestry',{},token);
 if(records?.length!==1||!isTapestry(records[0]))throw Error('Tapestry record access could not be verified.');
 const saved=records[0],store=validateDestination(saved.items),billing=await billingContact(deps);
 // Contact 293 is the common customer/billing account. It is never a store delivery ID.
 const prepared={...saved,tapestry_billing:billing,tapestry_store:store,items:saved.items.map(item=>({...item,brand:store.brand,tapestry_cin7_company:billing.company,tapestry_cin7_member_id:billing.id}))};
 verified.add(prepared);return prepared;
}
function build(order,user){
 if(!verified.has(order))throw Error('Verify the saved Tapestry order and billing account before synchronizing it.');
 const first=order.items[0],billing=order.tapestry_billing,store=order.tapestry_store;
 const wo=text(order.customer_po||order.work_order_number||first.work_order),name=text(first.requester_name||user?.email||order.user_email),parts=name.split(/\s+/),firstName=parts.shift()||'Tapestry',lastName=parts.join(' ')||'Requester';
 const lineItems=order.items.map((item,index)=>{const code=text(item.cin7_code||item.part),qty=Number(item.order_qty);if(!code||!Number.isFinite(qty)||qty<=0)throw Error('Invalid Tapestry product row.');return {sort:(index+1)*10,code,styleCode:code,name:text(item.description||code),qty,lineComments:[store.brand,store.n,item.location].filter(Boolean).join(' | ')};});
 return {reference:text(order.order_number),customerOrderNo:wo||text(order.order_number),memberId:billing.id,company:billing.company,firstName,lastName,email:text(order.user_email||user?.email),stage:'New',isApproved:false,
  storeLocationNumber:text(store.officialNumber||store.n),deliveryCompany:store.brand,deliveryFirstName:store.brand,deliveryLastName:'Store '+text(store.officialNumber||store.n),deliveryAddress1:store.a1,deliveryAddress2:'',deliveryCity:store.ca,deliveryState:store.sa,deliveryPostalCode:store.z,deliveryCountry:store.co,
  billingCompany:billing.company,billingAddress1:billing.address1,billingAddress2:billing.address2,billingCity:billing.city,billingState:billing.state,billingPostalCode:billing.postalCode,billingCountry:billing.country,
  internalComments:'Created from Tapestry Catalog. Operations '+text(order.order_number)+'. Aqua Team. Store '+store.n+'. Billing customer/contact 293. Requested by '+name+' <'+text(order.user_email||user?.email)+'>. WO '+wo+'. '+text(order.notes),lineItems,createdDate:new Date().toISOString()};
}
function assertCustomer(live,order){
 if(!isTapestry(order))return;
 if(!verified.has(order))throw Error('The saved Tapestry order has not been verified.');
 const billing=order.tapestry_billing,store=order.tapestry_store;
 if(Number(field(live,'memberId'))!==BILLING_ID||normalized(field(live,'billingCompany'))!==normalized(billing.company)||normalized(field(live,'billingAddress1'))!==normalized(billing.address1)||normalized(field(live,'billingCity'))!==normalized(billing.city)||state(field(live,'billingState'))!=='FL'||postal(field(live,'billingPostalCode'))!=='33325'||country(field(live,'billingCountry'))!=='US')throw Error('Cin7 has not confirmed the approved billing account and address. Review the existing document; do not create another order.');
 if(normalized(field(live,'deliveryCompany'))!==normalized(store.brand)||normalized(field(live,'deliveryAddress1'))!==normalized(store.a1)||normalized(field(live,'deliveryCity'))!==normalized(store.ca)||state(field(live,'deliveryState'))!==state(store.sa)||postal(field(live,'deliveryPostalCode'))!==postal(store.z)||country(field(live,'deliveryCountry'))!==country(store.co))throw Error('Cin7 has not confirmed delivery to the selected Tapestry brand and store. Review the existing document; do not create another order.');
}
// The quote builder and SPR add-to-existing path clone prepared records to select their product lines.
function derive(prepared,changes){if(!verified.has(prepared))throw Error('The original Tapestry order has not been verified.');const result={...prepared,...changes};if(result.tapestry_billing!==prepared.tapestry_billing||result.tapestry_store!==prepared.tapestry_store)throw Error('Tapestry routing cannot be replaced.');validateDestination(result.items);verified.add(result);return result;}
module.exports={isTapestry,prepare,build,assertCustomer,derive};
