'use strict';
const routing=require('./tapestry-routing');
const {responseRows,validateExactProducts,attachMarkers,confirmedLines}=require('./catalog-special-request');
const txt=x=>String(x??'').trim();
const unpack=x=>Array.isArray(x)?x[0]:(x?.Quote||x?.quote||x);
const id=x=>txt(x?.id||x?.Id);
function quotePayload(request,prepared,user,buildBBW){
 const rows=request.spr_responses;
 const items=prepared.items.map((item,i)=>({...item,part:rows[i].code,cin7_code:rows[i].code,description:rows[i].description}));
 const record={...prepared,order_number:request.quote_number,items};
 const payload=routing.isTapestry(record)?routing.build(record,user):buildBBW(record,user);
 payload.isApproved=false;payload.stage='New';payload.customerOrderNo=request.spr_wo||request.quote_number;
 payload.internalComments=(routing.isTapestry(record)?'Tapestry · Aqua Team':'BBW Corporate · Gold Team')+' product request '+request.quote_number+'. Quote only; approval is required before any sale. '+txt(request.notes);
 return attachMarkers(payload,request);
}
function verifyQuote(live,request,rows,prepared,payload){
 if(!live||!id(live)||txt(live.reference||live.Reference)!==txt(request.quote_number)||!confirmedLines(live,request,rows))throw Error('Cin7 has not confirmed the exact quote reference and every product row. Review the existing quote before retrying.');
 if(routing.isTapestry(prepared)&&Number(live.memberId??live.MemberId)!==Number(prepared.items[0].tapestry_cin7_member_id))throw Error('Cin7 quote customer does not match the verified Tapestry store.');
 if(!routing.isTapestry(prepared)&&txt(live.company||live.Company)!==txt(payload.company))throw Error('Cin7 Quote customer does not match the BBW customer configuration.');
 if(live.isApproved===true||live.IsApproved===true)throw Error('The Quote is already approved; review its current status in Cin7.');
 return live;
}
function install(app,deps){
 const {verifyCatalogUser,getAuthToken,supabaseRest,cin7Fetch,CIN7_BASE_URL,fetchAllPagesSafe,normalizeCin7Product,buildCin7SalesOrder}=deps;
 const rpc=(name,body,token)=>supabaseRest('rpc/'+name,{method:'POST',body:JSON.stringify(body)},token);
 const read=async key=>unpack(await cin7Fetch(CIN7_BASE_URL+'/Quotes/'+encodeURIComponent(key)));
 async function lookup(ref){
  const escaped=ref.replace(/'/g,"''");
  const raw=await cin7Fetch(CIN7_BASE_URL+'/Quotes?rows=250&page=1&where='+encodeURIComponent("reference='"+escaped+"'"));
  const list=Array.isArray(raw)?raw:(raw?.Quotes||raw?.quotes||raw?.data);
  if(!Array.isArray(list))throw Error('Cin7 quote lookup returned an unrecognized response.');
  if(list.length>=250)throw Error('Quote reference lookup requires manual review.');
  const exact=list.filter(q=>txt(q.reference||q.Reference)===ref);
  if(exact.length>1)throw Error('Multiple Cin7 quotes use this exact reference; manual review is required.');
  return exact.length?read(id(exact[0])):null;
 }
 app.post('/api/complete-catalog-quote',async(req,res)=>{
  let requestId,token,claimed=false;
  try{
   const user=await verifyCatalogUser(req);token=getAuthToken(req);requestId=txt(req.body?.request_id);
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw Error('Invalid request identifier.');
   if(await rpc('catalog_spr_staff_v263',{},token)!==true)return res.status(403).json({success:false,error:'Only authorized AALS staff can answer requests.'});
   let request=(await rpc('catalog_quote_read_v2',{p_request_id:requestId},token)).request;
   if(request.spr_order_id)throw Error('This request already has a sales order. It cannot automatically create a second document.');
   if(request.spr_document_type!=='quote')throw Error('This request has not been enabled for the quote workflow.');
   if(request.spr_cin7_quote_id)return res.json({success:true,complete:true,document_type:'quote',request,message:'Quote already created: '+(request.spr_cin7_quote_number||request.spr_cin7_quote_id)});
   let rows=responseRows(request,request.spr_quote_state&&request.spr_quote_state!=='draft'?request.spr_responses:req.body?.lines);
   const complete=rows.every(r=>r.code&&r.description);
   if(!request.spr_quote_state||request.spr_quote_state==='draft')request=await rpc('catalog_quote_write_v2',{p_request_id:requestId,p_action:'save',p_lines:rows},token);
   if(!complete)return res.json({success:true,complete:false,request,message:'Responses saved. Complete every row to create a Quote.'});
   rows=validateExactProducts(rows,(await fetchAllPagesSafe('products','')).map(normalizeCin7Product));
   const prepared=await routing.prepare(request,supabaseRest,token,'quotes');
   const payload=quotePayload(request,prepared,user,buildCin7SalesOrder);
   // Check the durable response snapshot under a row lock before any write to Cin7.
   const claim=await rpc('catalog_quote_write_v2',{p_request_id:requestId,p_action:'claim',p_lines:rows},token);
   if(claim.state==='sent')return res.json({success:true,complete:true,request:claim.request,message:'Quote already created.'});
   if(!claim.claimed&&claim.state==='sending'&&Date.now()-new Date(claim.request.updated_at).getTime()<120000)return res.status(409).json({success:false,error:'Quote is synchronizing. Wait and refresh; no duplicate will be created.'});
   claimed=claim.claimed;request=claim.request;
   let live=await lookup(request.quote_number);
   if(!live&&claim.claimed){
    const result=unpack(await cin7Fetch(CIN7_BASE_URL+'/Quotes?loadboms=false',{method:'POST',body:JSON.stringify([payload])}));
    if(result?.success===false||result?.Success===false)throw Error('Cin7 quote was not accepted: '+JSON.stringify(result.errors||result.Errors||[]));
    live=id(result)?await read(id(result)):await lookup(request.quote_number);
   }
   if(!live)throw Error('An earlier synchronization requires review. No second Quote was posted.');
   verifyQuote(live,request,rows,prepared,payload);
   request=await rpc('catalog_quote_write_v2',{p_request_id:requestId,p_action:'link',p_cin7_id:id(live),p_cin7_number:txt(live.code||live.Code||request.quote_number)},token);
   return res.json({success:true,complete:true,document_type:'quote',request,message:'Quote created in Cin7: '+(request.spr_cin7_quote_number||request.quote_number)+'. Awaiting review and approval.'});
  }catch(error){
   if(claimed&&requestId&&token)try{await rpc('catalog_quote_write_v2',{p_request_id:requestId,p_action:'review',p_error:error.message},token);}catch(_){}
   return res.status(400).json({success:false,error:error.message});
  }
 });
}
module.exports={install,quotePayload,verifyQuote};
