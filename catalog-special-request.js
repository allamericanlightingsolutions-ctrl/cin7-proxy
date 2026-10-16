'use strict';
const tapestryRouting=require('./tapestry-routing');

const txt = value => String(value == null ? '' : value).trim();
function responseRows(request, input) {
  if (request.spr_source !== 'catalog' || request.spr_version !== 108) throw new Error('Only new Catalog special requests use automatic orders.');
  if (!Array.isArray(request.items) || !request.items.length || request.items.length > 30) throw new Error('Invalid requested products.');
  if (!Array.isArray(input) || input.length !== request.items.length) throw new Error('Answer every original product row.');
  return input.map((row, index) => {
    const qty = Number(request.items[index].order_qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid quantity in row ' + (index + 1));
    return {code:txt(row.code), description:txt(row.description)};
  });
}
function validateExactProducts(rows, products) {
  return rows.map((row, index) => {
    if (!row.code || !row.description) throw new Error('Complete the code and description in row ' + (index + 1));
    const matches = products.filter(p => [p.code, p.sku, ...(p.optionCodes || [])].some(code => txt(code) === row.code));
    const ids = new Set(matches.map(p => txt(p.id) || JSON.stringify(p)));
    if (ids.size !== 1) throw new Error('Row ' + (index + 1) + ': SKU "' + row.code + '" must match exactly one Cin7 product. No approximate matches are used.');
    return row;
  });
}
function unpack(value) {
  if (Array.isArray(value)) return value[0];
  return value && (value.SalesOrder || value.salesOrder || value);
}
function salesId(order) { return txt(order && (order.id || order.Id)); }
function assertOpen(order) {
  if (!order || !salesId(order)) throw new Error('The existing sales order could not be verified in Cin7.');
  const stage = txt(order.stage || order.Stage || order.status || order.Status).toLowerCase();
  const forbidden = /invoice|dispatch|ship|cancel|void|complete|closed/.test(stage);
  const dates = ['invoiceDate','InvoiceDate','dispatchedDate','DispatchedDate','fullyDispatchedDate','FullyDispatchedDate','cancelledDate','CancelledDate'];
  const realDate=value=>!!txt(value)&&!/^000[01]-/.test(txt(value));
  const invoice=Number(order.invoiceNumber || order.InvoiceNumber || 0)>0;
  const shipped=(order.lineItems || order.LineItems || []).some(line=>Number(line.qtyShipped || line.QtyShipped || 0)>0);
  if (forbidden || dates.some(key => realDate(order[key])) || invoice || shipped || order.isVoid === true || order.IsVoid === true || txt(order.isVoid || order.IsVoid).toLowerCase()==='true') throw new Error('The Cin7 order is already invoiced, dispatched or closed. Its products cannot be changed automatically.');
  if (!Array.isArray(order.lineItems || order.LineItems)) throw new Error('The existing Cin7 lines could not be verified.');
}
function marker(request) { return '[AALS-SPR:' + request.id + ']'; }
function confirmedLines(order, request, rows) {
  const lines = order && (order.lineItems || order.LineItems) || [];
  const selected = lines.filter(line => txt(line.lineComments || line.LineComments).includes(marker(request)));
  if (selected.length !== rows.length) return false;
  return rows.every((row,index) => {
    const tag = marker(request) + ':' + index;
    const match = selected.filter(line => {const comment=txt(line.lineComments || line.LineComments);return comment===tag || comment.startsWith(tag + ' ');});
    return match.length === 1 && txt(match[0].code || match[0].Code) === row.code &&
      Number(match[0].qty ?? match[0].Qty) === Number(request.items[index].order_qty);
  });
}
function exactReferences(order, reference) {
  return ['reference','Reference','ref','Ref','code','Code','customerOrderNo','CustomerOrderNo'].some(key => txt(order[key]) === txt(reference));
}
function attachMarkers(payload, request, indices) {
  payload.lineItems.forEach((line, index) => {
    line.lineComments = marker(request) + ':' + (indices ? indices[index] : index) + ' ' + txt(line.lineComments);
  });
  return payload;
}

function install(app, deps) {
  const {verifyCatalogUser,getAuthToken,supabaseRest,cin7Fetch,CIN7_BASE_URL,fetchAllPagesSafe,normalizeCin7Product,normalizeCin7OrderList,buildCin7SalesOrder,applyApprovedInventoryV37} = deps;
  const rpc = (name, body, token) => supabaseRest('rpc/' + name, {method:'POST',body:JSON.stringify(body)}, token);
  const readLive = async id => unpack(await cin7Fetch(CIN7_BASE_URL + '/SalesOrders/' + encodeURIComponent(id)));
  const exactLookup = async ref => {
    // Use only exact API-filtered reference results; no loose normalization or fuzzy fallback.
    const escaped = txt(ref).replace(/'/g, "''");
    const raw = await cin7Fetch(CIN7_BASE_URL + '/SalesOrders?rows=250&page=1&where=' + encodeURIComponent("reference='" + escaped + "'"));
    const list = normalizeCin7OrderList(raw).filter(order => exactReferences(order, ref));
    if (list.length >= 250) throw new Error('Exact order lookup is incomplete; manual review is required.');
    if (list.length > 1) throw new Error('More than one exact Cin7 reference exists. Manual review is required.');
    return list[0] ? readLive(salesId(list[0])) : null;
  };
  const findTarget = async (request, token) => {
    const ref = txt(request.spr_target_reference);
    const values = await supabaseRest('orders?select=*&or=' + encodeURIComponent('(order_number.eq."' + ref.replace(/["\\]/g, '\\$&') + '",reference.eq."' + ref.replace(/["\\]/g, '\\$&') + '",cin7_order_number.eq."' + ref.replace(/["\\]/g, '\\$&') + '")'), {}, token);
    const exact = (values || []).filter(o => [o.order_number,o.reference,o.cin7_order_number].some(v => txt(v) === ref));
    if (exact.length !== 1 || !exact[0].cin7_order_id) throw new Error('Enter the exact number of one existing, synchronized Catalog order.');
    const target=exact[0];
    if ((target.catalog_client||'bbw')!==(request.catalog_client||'bbw'))throw new Error('The existing order belongs to another catalog.');
    if (target.user_id !== request.user_id || txt(target.items?.[0]?.store_num) !== txt(request.items?.[0]?.store_num)) throw new Error('The order must belong to this requester and store.');
    if (txt(target.customer_po || target.work_order_number || target.items?.[0]?.work_order || target.items?.[0]?.customer_po) !== txt(request.spr_wo)) throw new Error('WO does not match the existing order.');
    const live = await readLive(target.cin7_order_id);
    assertOpen(live);
    return target;
  };

  const completeCatalogSalesOrder = async (req,res) => {
    let requestId,token,linked=false;
    try {
      const user = await verifyCatalogUser(req);
      token=getAuthToken(req);
      if (!await rpc('catalog_spr_staff_v263',{},token)) return res.status(403).json({success:false,error:'Only authorized AALS staff can answer requests.'});
      requestId=txt(req.body?.request_id);
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('Invalid request identifier.');
      let saved=await rpc('catalog_spr_order_v263',{p_request_id:requestId},token);
      let request=saved.request,order=saved.order;
      if (!request.spr_order_id && (request.spr_document_type==='quote' || request.spr_cin7_quote_id || ['sending','sent','review_required'].includes(request.spr_quote_state))) throw new Error('An existing or pending Cin7 Quote must be reviewed before creating a Sales Order. No second document was created.');
      let rows=responseRows(request,request.spr_order_id ? request.spr_responses : req.body?.lines);
      const complete=rows.every(row => row.code && row.description);
      if (!request.spr_order_id) {
        if (complete) {
          await tapestryRouting.prepare(request,supabaseRest,token,'quotes');
          rows=validateExactProducts(rows,(await fetchAllPagesSafe('products','')).map(normalizeCin7Product));
          if (request.spr_destination==='existing') await findTarget(request,token);
        }
        saved=await rpc('catalog_spr_complete_v263',{p_request_id:requestId,p_lines:rows,p_complete:complete},token);
        if (!complete) return res.json({success:true,complete:false,message:'Responses saved. Complete every row to create the order.'});
        request=saved.request;order=saved.order;
      }
      linked=true;
      order=await tapestryRouting.prepare(order,supabaseRest,token);
      if (request.spr_sync_state==='sent') return res.json({success:true,complete:true,order,message:'This request is already linked to its sales order.'});
      const claim=await rpc('catalog_spr_sync_v263',{p_request_id:requestId,p_action:'claim'},token);
      let live;
      if (!claim.claimed) {
        // A prior uncertain write is reconciled by reading only. Never repeat POST/PUT blindly.
        if (claim.state==='sending' && Date.now()-new Date(request.updated_at).getTime()<120000) return res.status(409).json({success:false,linked:true,error:'This request is synchronizing. Please wait, then refresh; it will not create another order.'});
        if (claim.state==='other_request_sending') return res.status(409).json({success:false,linked:true,error:'Another request is synchronizing this order. Please try again after it finishes.'});
        live=order.cin7_order_id ? await readLive(order.cin7_order_id) : await exactLookup(order.order_number);
        if (!live || !confirmedLines(live,request,rows)) throw new Error('A previous sync is pending or requires review. No additional Cin7 order has been created. Check the exact reference in Cin7 before resolving it.');
      } else if (request.spr_destination==='existing') {
        live=await readLive(order.cin7_order_id);
        if (!confirmedLines(live,request,rows)) {
          assertOpen(live);
          const newItems=(order.items || []).filter(item => txt(item.spr_request_id)===requestId);
          if (newItems.length!==rows.length) throw new Error('Linked product rows do not match the request.');
          const added=attachMarkers(buildCin7SalesOrder({...order,items:newItems},user),request);
          const old=live.lineItems || live.LineItems;
          const last=Math.max(0,...old.map(line => Number(line.sort || line.Sort)||0));
          added.lineItems.forEach((line,index) => {line.sort=last+(index+1)*10;});
          // Preserve every existing line and its Cin7 identifiers/prices.
          await cin7Fetch(CIN7_BASE_URL + '/SalesOrders?loadboms=false',{method:'PUT',body:JSON.stringify([{id:Number(salesId(live)),lineItems:old.concat(added.lineItems)}])});
          live=await readLive(salesId(live));
        }
      } else {
        live=await exactLookup(order.order_number);
        if (!live) {
          const payload=attachMarkers(buildCin7SalesOrder(order,user),request);
          // Request submission authorizes the sale. Use SalesOrders, never Quotes.
          payload.stage='New';payload.isApproved=true;payload.customerOrderNo=request.spr_wo;
          payload.internalComments='Sales Order from catalog request '+request.quote_number+'. Authorized by requester submission. WO '+request.spr_wo+'. '+txt(order.notes);
          const result=unpack(await cin7Fetch(CIN7_BASE_URL + '/SalesOrders?loadboms=false',{method:'POST',body:JSON.stringify([payload])}));
          if(result?.success===false||result?.Success===false)throw new Error('Cin7 Sales Order was not accepted: '+JSON.stringify(result.errors||result.Errors||[]));
          const id=salesId(result);
          live=id ? await readLive(id) : await exactLookup(order.order_number);
        }
      }
      if (!live || !confirmedLines(live,request,rows)) throw new Error('Cin7 has not confirmed every requested product. The request is linked and requires review; it will not create another order.');
      if (tapestryRouting.isTapestry(order) && Number(live.memberId??live.MemberId)!==Number(order.items[0].tapestry_cin7_member_id)) throw new Error('Cin7 customer does not match the verified Tapestry store.');
      if (!tapestryRouting.isTapestry(order) && txt(live.company||live.Company)!==txt(buildCin7SalesOrder(order,user).company)) throw new Error('Cin7 customer does not match the BBW customer configuration.');
      if (request.spr_destination!=='existing' && txt(live.reference||live.Reference)!==txt(order.order_number)) throw new Error('Cin7 Sales Order reference does not match the linked portal order.');
      if (request.spr_document_type==='sales_order' && request.spr_destination!=='existing') {
        if(String(live.isApproved??live.IsApproved).toLowerCase()!=='true')throw new Error('Cin7 has not confirmed approval of this Sales Order. Review the same order; no duplicate was created.');
        if(txt(live.customerOrderNo||live.CustomerOrderNo)!==txt(request.spr_wo))throw new Error('Cin7 work order does not match this request.');
      }
      order=await rpc('catalog_spr_link_v263',{p_request_id:requestId,p_cin7_id:salesId(live),p_cin7_number:txt(live.code || live.Code || live.reference || live.Reference)},token);
      let inventory;
      try { inventory=await applyApprovedInventoryV37(order,token); } catch(error) { inventory={status:'waiting_materials',message:'Stock verification is pending: '+error.message}; }
      await rpc('catalog_spr_sync_v263',{p_request_id:requestId,p_action:'done'},token);
      return res.json({success:true,complete:true,order:{...order,status:inventory.status || order.status},inventory,message:request.spr_destination==='existing'?'Products added to the existing sales order.':'Sales order created. Print / Save as PDF is available.'});
    } catch(error) {
      if (linked && requestId && token) {
        try { await rpc('catalog_spr_sync_v263',{p_request_id:requestId,p_action:'review',p_error:error.message},token); } catch(_) {}
      }
      return res.status(400).json({success:false,linked,error:error.message});
    }
  };
  app.post('/api/complete-catalog-special-request',completeCatalogSalesOrder);
  app.post('/api/complete-catalog-sales-order',completeCatalogSalesOrder);
  return completeCatalogSalesOrder;
}
module.exports={install,responseRows,validateExactProducts,assertOpen,confirmedLines,attachMarkers,exactReferences};

