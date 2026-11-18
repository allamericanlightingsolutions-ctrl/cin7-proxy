'use strict';
const assert=require('node:assert/strict');
const {apply,teamPrice}=require('./catalog-team-pricing');
(async()=>{
 const source={reference:'TAP-000006',memberId:293,customerOrderNo:'458522',deliveryPostalCode:'89106',isApproved:false,lineItems:[{code:'FLC75-24V-XL',qty:2,unitPrice:0.01},{code:'NDV7-40K-24V',qty:2,UnitPrice:500,discount:50}]};
 const prices={'FLC75-24V-XL':82.19,'NDV7-40K-24V':101.37};let calls=0;
 const deps={CIN7_BASE_URL:'https://example.test',cin7Fetch:async url=>{calls++;const q=new URL(url).searchParams;const code=q.get('where').match(/^ProductOptionCode='(.+)'$/)[1];return [{productOptionCode:code,status:'Active',retailPrice:999,priceColumns:{retailUSD:999,teamsusd:prices[code]}}];}};
 const result=await apply(source,deps);
 assert.equal(result.lineItems[0].unitPrice,82.19);assert.equal(result.lineItems[1].unitPrice,101.37);
 assert.equal(result.lineItems[1].discount,0);assert.equal(result.lineItems[1].UnitPrice,undefined);
 assert.equal(Math.round(result.lineItems.reduce((sum,l)=>sum+l.qty*l.unitPrice,0)*100)/100,367.12);
 for(const key of ['reference','memberId','customerOrderNo','deliveryPostalCode','isApproved'])assert.equal(result[key],source[key]);
 assert.equal(source.lineItems[0].unitPrice,0.01);assert.equal(calls,2);assert.match(result.internalComments,/TEAMS/);
 calls=0;await apply({...source,lineItems:[source.lineItems[0],source.lineItems[0]]},deps);assert.equal(calls,1);
 for(const val of [null,undefined,'',0,-1,'not a price'])assert.throws(()=>teamPrice({retailPrice:99,priceColumns:{teamsusd:val}},'SKU'),/missing or invalid/);
 assert.throws(()=>teamPrice({retailPrice:99,priceColumns:{retailUSD:99}},'SKU'),/missing or invalid/);
 assert.equal(teamPrice({PriceColumns:[{Key:'teamsusd',Value:12.34}]},'SKU'),12.34);
 for(const list of [[],[{productOptionCode:'OTHER',priceColumns:{teamsusd:1}}],[{productOptionCode:'FLC75-24V-XL',status:'Disabled',priceColumns:{teamsusd:1}}],[{productOptionCode:'FLC75-24V-XL'},{productOptionCode:'FLC75-24V-XL'}]]){
  await assert.rejects(apply({...source,lineItems:[source.lineItems[0]]},{...deps,cin7Fetch:async()=>list}),/Exactly one active/);
 }
 await assert.rejects(apply(source,{...deps,cin7Fetch:async()=>{throw Error('429 rate limited');}}),/429/);
 await assert.rejects(apply({...source,currencyCode:'CAD'},deps),/USD/);
 console.log('TEAMS pricing passed: verified tier values, exact SKUs, no retail/zero fallback, no client price overrides, duplicate SKU deduplication, destination and approval preserved. No live orders written.');
})().catch(e=>{console.error(e);process.exitCode=1;});
