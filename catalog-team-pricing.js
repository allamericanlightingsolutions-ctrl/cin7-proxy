'use strict';
// Server-side pricing for catalog writes. Browser-supplied prices are never trusted.
const column='teamsusd';
const text=x=>String(x??'').trim();
const field=(row,name)=>row?.[name]??row?.[name[0].toUpperCase()+name.slice(1)];
function rows(result){
 const list=Array.isArray(result)?result:result?.ProductOptions||result?.productOptions||result?.data;
 if(!Array.isArray(list))throw Error('Cin7 product pricing could not be verified.');
 return list;
}
function teamPrice(option,code){
 const columns=field(option,'priceColumns');
 const entries=Array.isArray(columns)?columns.map(x=>[x.key??x.Key,x.value??x.Value]):Object.entries(columns||{});
 const matches=entries.filter(([key])=>text(key).toLowerCase()===column);
 const value=matches.length===1?matches[0][1]:null;
 const price=typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;
 if(!Number.isFinite(price)||price<=0)throw Error('TEAMS price is missing or invalid for SKU '+code+'. AALS must confirm this price before the order can be sent to Cin7.');
 return price;
}
async function apply(payload,{cin7Fetch,CIN7_BASE_URL}){
 if(!Array.isArray(payload?.lineItems)||!payload.lineItems.length)throw Error('Catalog products are required for TEAMS pricing.');
 if(payload.currencyCode&&text(payload.currencyCode).toUpperCase()!=='USD')throw Error('Catalog TEAMS pricing is configured in USD.');
 const prices=new Map();
 for(const line of payload.lineItems){
  const code=text(line.code);
  if(!code)throw Error('An exact SKU is required for TEAMS pricing.');
  if(prices.has(code))continue;
  const query=new URLSearchParams({rows:'250',page:'1',where:"ProductOptionCode='"+code.replace(/'/g,"''")+"'"});
  const options=rows(await cin7Fetch(CIN7_BASE_URL+'/ProductOptions?'+query));
  if(options.length>=250)throw Error('Cin7 SKU pricing lookup is incomplete for '+code+'.');
  const matches=options.filter(option=>text(field(option,'productOptionCode')||field(option,'code'))===code&&text(field(option,'status')).toLowerCase()!=='disabled');
  if(matches.length!==1)throw Error('Exactly one active Cin7 product option is required for TEAMS pricing: '+code+'.');
  prices.set(code,teamPrice(matches[0],code));
 }
 const marker='[AALS CATALOG PRICING: TEAMS / teamsusd]';
 return {...payload,currencyCode:'USD',internalComments:[payload.internalComments,marker].filter(Boolean).join('\n'),lineItems:payload.lineItems.map(line=>{
  const clean={...line,unitPrice:prices.get(text(line.code)),discount:0};
  delete clean.UnitPrice;delete clean.Discount;delete clean.uomPrice;delete clean.UomPrice;
  return clean;
 })};
}
module.exports={apply,teamPrice};
