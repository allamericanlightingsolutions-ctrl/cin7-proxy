'use strict';
const value=(o,keys)=>keys.map(k=>o?.[k]).find(v=>v!==undefined&&v!==null&&String(v).trim()!=='');
const ref=o=>String(value(o,['Ref','ref','Reference','reference','SalesOrderRef','salesOrderRef'])||'').trim().replace(/^Cin7\s*Ref\s*#?\s*/i,'').toLowerCase();
const id=o=>String(value(o,['Id','id','ID'])||'').trim();
function catalog(row){return [row.reference,row.order_number].some(v=>/^AALS-\d{4,}$/i.test(String(v||'').trim()));}
function invoiceData(order,from,to){
 const number=String(value(order,['InvoiceNumber','invoiceNumber'])||'').trim();
 const date=String(value(order,['InvoiceDate','invoiceDate'])||'').slice(0,10);
 const shipped=String(value(order,['DispatchedDate','dispatchedDate'])||'');
 const voided=value(order,['IsVoid','isVoid']);
 if(voided===true||String(voided).toLowerCase()==='true'||/void|cancel/i.test(String(value(order,['Status','status','Stage','stage'])||'')))return null;
 if(!/^\d+$/.test(number)||Number(number)<=0||!/^\d{4}-\d{2}-\d{2}$/.test(date)||(!Number.isFinite(Date.parse(shipped))||Number(shipped.slice(0,4))<1900)||date<from||date>to)return null;
 return {invoice_number:number,invoice_date:date,dispatched_date:shipped,cin7_order_id:id(order),cin7_reference:String(value(order,['Ref','ref','Reference','reference'])||''),invoice_total:value(order,['Total','total'])??'',currency:value(order,['CurrencyCode','currencyCode'])||'',tracking:String(value(order,['TrackingCode','trackingCode'])||''),carrier:String(value(order,['LogisticsCarrier','logisticsCarrier'])||'')};
}
function makeStatement(orders,rows,from,to){
 const catalogs=rows.filter(catalog),report=[],ambiguous=new Set(),seen=new Set();
 for(const order of orders){const invoice=invoiceData(order,from,to);if(!invoice)continue;
 const matches=catalogs.filter(row=>{const linked=[row.cin7_order_id,row.external_source==='cin7_sales_orders'?row.external_id:null].filter(x=>x!=null&&String(x).trim()!=='').map(String);return linked.length?linked.every(x=>x===id(order)):[row.reference,row.order_number].some(x=>ref({Reference:x})===ref(order));});
 if(matches.length>1){matches.forEach(x=>ambiguous.add(x.id));continue;}if(matches.length!==1)continue;
 const key=id(order);if(!key||seen.has(key))continue;seen.add(key);
 const row=matches[0];report.push({...invoice,operations_order_id:row.id,aals_order_number:row.reference||row.order_number,requester:row.user_email||row.created_by_email||'',work_order:row.work_order_number||row.customer_po||value(order,['CustomerOrderNo','customerOrderNo'])||'',items:(order.LineItems||order.lineItems||[]).map(line=>({sku:value(line,['Code','code'])||'',description:value(line,['Name','name'])||'',quantity_shipped:value(line,['QtyShipped','qtyShipped'])??'',unit_price:value(line,['UnitPrice','unitPrice'])??''})),catalog_items:row.items||[]});
 }
 return {rows:report.sort((a,b)=>a.invoice_date.localeCompare(b.invoice_date)||a.invoice_number.localeCompare(b.invoice_number)),ambiguous_catalog_orders:ambiguous.size};
}
module.exports={catalog,invoiceData,makeStatement};
