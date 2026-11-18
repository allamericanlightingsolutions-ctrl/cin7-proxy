'use strict';
const assert=require('node:assert/strict');
const {resolve,claim,isApproved}=require('./tapestry-approval-guard');
const id='00000000-0000-4000-8000-000000000001';
(async()=>{
 const saved={id,catalog_client:'tapestry',status:'approved',approved_at:'2026-11-18T12:00:00Z',user_email:'creator@example.test',items:[{part:'REAL-SKU',order_qty:2}]};
 const rest=async(path,options)=>path.startsWith('orders?')?[saved]:{order:saved};
 const result=await resolve({id,items:[{part:'INJECTED-SKU'}]},'team-session',rest);
 assert.equal(result.teamOrder,true);assert.equal(result.order.items[0].part,'REAL-SKU');assert.equal(result.order.user_email,'creator@example.test');
 await assert.rejects(resolve({id},'session',async p=>p.startsWith('orders?')?[{...saved,status:'pending_approval'}]:{order:{...saved,status:'pending_approval'}}),/approval is required/);
 await assert.rejects(resolve({id},'session',async()=>[]),/not available/);
 await assert.rejects(resolve({catalog_client:'tapestry'},'session',rest),/saved Tapestry/);
 assert.equal(isApproved({...saved,status:'cancelled'}),false);assert.equal(isApproved({...saved,status:'shipped'}),false);
 assert.equal(isApproved({...saved,status:'ready_to_pick',approved_at:null,notes:'[CATALOG AUTO AUTHORIZATION]'}),true);
 const bbw={id,user_email:'bbw@example.test'};assert.equal((await resolve(bbw,'session',async()=>[bbw])).teamOrder,false);
 let claimed=false;const lockingRest=async()=>({claimed:!claimed&&(claimed=true)});
 await claim(saved,'session',lockingRest);await assert.rejects(claim(saved,'session',lockingRest),/already synchronizing/);
 console.log('Approval guard passed: pending/foreign orders rejected, stored products used, same-team creator preserved, duplicate sync blocked, BBW unchanged.');
})().catch(e=>{console.error(e);process.exitCode=1;});
