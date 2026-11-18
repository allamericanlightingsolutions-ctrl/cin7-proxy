'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const guard=require('./tapestry-approval-guard');
const id='11111111-2222-4333-8444-555555555555';
function rest(saved,approved,claimed=true){return async(path,options)=>path.startsWith('orders?')?[saved]:JSON.parse(options.body).p_action==='read'?{order:saved,approved_for_sync:approved}:{claimed};}
test('BBW pending cannot be sent even with a forged approved payload',async()=>{
 const saved={id,source:'catalog',catalog_client:'bbw',status:'pending_approval'};
 await assert.rejects(guard.resolve({...saved,status:'approved',authorized_at:'today'},'token',rest(saved,false)),/BBW Team approval/);
});
test('BBW uses approved saved items instead of browser items',async()=>{
 const saved={id,source:'catalog',catalog_client:'bbw',status:'approved',items:[{part:'original'}]};
 const result=await guard.resolve({id,items:[{part:'forged'}]},'token',rest(saved,true));
 assert.equal(result.teamOrder,true);assert.equal(result.order,saved);
});
test('old BBW orders are recognized by client',async()=>{
 const saved={id,source:'catalog',items:[{client:'Bath & Body Works'}]};
 await assert.rejects(guard.resolve({id},'token',rest(saved,false)),/BBW Team approval/);
});
test('Tapestry retains Aqua approval requirement',async()=>{
 const saved={id,catalog_client:'tapestry',status:'pending_approval'};
 await assert.rejects(guard.resolve({id},'token',rest(saved,true)),/Aqua Team approval/);
});
test('unrelated catalog flows are retained',async()=>{
 const saved={id,source:'catalog',catalog_client:'other'},payload={id,items:['original']};
 const result=await guard.resolve(payload,'token',rest(saved,false));assert.equal(result.order,payload);assert.equal(result.teamOrder,false);
});
test('claims use correct RPC and reject duplicate sends',async()=>{
 for(const catalog of ['bbw','tapestry']){
 let path;await guard.claim({id,catalog_client:catalog},'token',async(p)=>{path=p;return {claimed:true};});assert.equal(path,'rpc/'+catalog+'_order_approval_v1');
 await assert.rejects(guard.claim({id,catalog_client:catalog},'token',rest({},false,false)),/already synchronizing/);
 }
});
test('unsaved requests are denied',async()=>{await assert.rejects(guard.resolve({},'token',()=>{}),/saved catalog order/);});
