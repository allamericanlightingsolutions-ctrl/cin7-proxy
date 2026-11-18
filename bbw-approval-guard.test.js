'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const guard=require('./tapestry-approval-guard');
const id='11111111-2222-4333-8444-555555555555';
test('BBW automatic authorization does not require a team approval RPC',async()=>{
 const order={id,source:'catalog',catalog_client:'bbw',status:'ready_to_pick',authorized_at:'2026-11-18T00:00:00Z',items:[{client:'Bath & Body Works',part:'TEST'}]};let calls=0;
 const result=await guard.resolve(order,'token',async path=>{calls++;assert.match(path,/^orders\?/);return [order];});assert.equal(calls,1);assert.equal(result.teamOrder,false);assert.equal(result.order,order);
});
test('Tapestry retains Aqua approval before Cin7',async()=>{
 const saved={id,catalog_client:'tapestry',status:'pending_approval'};
 await assert.rejects(guard.resolve({id},'token',async path=>path.startsWith('orders?')?[saved]:{order:saved}),/Aqua Team approval/);
});
test('Tapestry still uses saved items and durable send claim',async()=>{
 const saved={id,catalog_client:'tapestry',status:'approved',approved_at:'2026-11-18T00:00:00Z',items:[{part:'saved'}]};
 const result=await guard.resolve({id,items:[{part:'forged'}]},'token',async path=>path.startsWith('orders?')?[saved]:{order:saved});assert.equal(result.order,saved);assert.equal(result.teamOrder,true);
 await assert.rejects(guard.claim(saved,'token',async()=>({claimed:false})),/already synchronizing/);
});
