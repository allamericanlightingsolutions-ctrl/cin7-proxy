// AALS automatic shipping reports - server-only module.
const crypto = require('crypto');
const TZ = 'America/New_York';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const val = (o, keys) => keys.map(k => o?.[k]).find(x => x !== undefined && x !== null && String(x).trim() !== '') ?? '';
const dateLocal = (d, opts) => new Intl.DateTimeFormat('en-US',{timeZone:TZ,...opts}).format(d);
const localParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(d).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const status = r => String(r.status||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
const isReady = r => ['ready_to_pick','ready_for_pick','ready_to_ship'].includes(status(r));
const isShipped = r => ['shipped','delivered'].includes(status(r));
const orderName = r => val(r,['order_number','reference','cin7_ref_number','external_number','id']);
const client = r => val(r,['cin7_customer_name','catalog_client','customer','client','customer_email','user_email','requested_by_email']) || '—';
const team = r => val(r,['requester_team','reporting_group','team','team_name','assigned_team','request_team']) || '—';
const created = r => val(r,['approved_at','approved_date','created_at']);
const localDay = v => {if(!v)return ''; const d=new Date(v);return Number.isFinite(d.getTime())?dateLocal(d,{year:'numeric',month:'2-digit',day:'2-digit'}):'';};
const sortAge = (a,b) => new Date(created(a)||0)-new Date(created(b)||0);
function table(rows, cols){
 if(!rows.length)return '<p>No orders in this section.</p>';
 return '<table cellpadding="7" cellspacing="0" border="1" style="border-collapse:collapse;font:13px Arial;border-color:#d9e1eb;width:100%"><thead><tr style="background:#e9eff6">'+cols.map(c=>'<th align="left">'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+esc(c[1](r))+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
}
const cols=[['Order',orderName],['Team',team],['Customer',client],['Created / approved',r=>created(r)?localDay(created(r)):'—'],['Days waiting',r=>{const d=new Date(created(r));return Number.isFinite(d.getTime())?Math.max(0,Math.floor((Date.now()-d.getTime())/86400000)):'—';}],['Notes / reason',r=>String(val(r,['shipping_issue','delay_reason','notes'])||'—').slice(0,300)]];
function install(app,{sendEmail,fetch}){
 app.post('/api/automatic-shipping-report',async(req,res)=>{
  const secret=process.env.SHIPPING_REPORT_SECRET||'';
  const auth=String(req.headers['x-report-secret']||'');
  const a=Buffer.from(secret),b=Buffer.from(auth);
  if(!secret||a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({success:false,error:'Unauthorized'});
  const p=localParts(new Date());
  const testMode=req.headers['x-report-test']==='true';
  const requestedKind=String(req.headers['x-report-kind']||'morning');
  if(testMode && !['morning','evening'].includes(requestedKind))return res.status(400).json({success:false,error:'Invalid test report type'});
  const kind=testMode?requestedKind:(p.hour==='08'?'morning':p.hour==='17'?'evening':null);
  if(!testMode&&(!kind||['Sat','Sun'].includes(p.weekday)))return res.json({success:true,skipped:'Outside weekday 8 AM / 5 PM Eastern window'});
  const day=`${p.year}-${p.month}-${p.day}`;
  const db=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  if(!db||!key)return res.status(500).json({success:false,error:'Supabase service configuration missing'});
  const recipients=String(process.env.SHIPPING_REPORT_RECIPIENTS||'').split(',').map(x=>x.trim()).filter(x=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if(!recipients.length)return res.status(500).json({success:false,error:'SHIPPING_REPORT_RECIPIENTS missing'});
  if(testMode && (recipients.length!==1 || recipients[0].toLowerCase()!=='l.gonzalez@aalsusa.com'))return res.status(400).json({success:false,error:'Test mode requires only the approved test recipient'});
  const headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  const logUrl=`${db}/rest/v1/aals_shipping_report_runs`;
  let claimed=false;
  try{
   if(!testMode){
    const claim=await fetch(logUrl,{method:'POST',headers:{...headers,Prefer:'return=representation'},body:JSON.stringify({report_day:day,report_type:kind,status:'processing'})});
    if(claim.status===409)return res.json({success:true,skipped:'Report already claimed for this day'});
    if(!claim.ok)throw new Error('Could not claim report run: '+claim.status+' '+(await claim.text()).slice(0,250));
    claimed=true;
   }
   const rows=[];let offset=0;
   while(true){
    const response=await fetch(`${db}/rest/v1/orders?select=*&order=id.asc&limit=500&offset=${offset}`,{headers});
    if(!response.ok)throw new Error('Could not read Operations orders: '+response.status);
    const batch=await response.json();rows.push(...batch);
    if(batch.length<500)break;offset+=500;
    if(offset>100000)throw new Error('Order pagination safety limit reached');
   }
   const ready=rows.filter(isReady).sort(sortAge);
   let html,subject;
   if(kind==='morning'){
    subject=`AALS | 8 AM Ready to Pick | ${day} | ${ready.length} pending`;
    html=`<h2>AALS – Morning shipping queue</h2><p>${esc(day)} · 8:00 AM Eastern</p><p><b>${ready.length} Ready to Pick orders pending shipment</b>, oldest first.</p>`+table(ready,cols);
   }else{
    const shipped=rows.filter(r=>isShipped(r)&&localDay(r.shipped_at)===dateLocal(new Date(),{year:'numeric',month:'2-digit',day:'2-digit'}));
    subject=`AALS | 5 PM Shipping Summary | ${day} | ${ready.length} still pending`;
    html=`<h2>AALS – End-of-day shipping report</h2><p>${esc(day)} · 5:00 PM Eastern</p><p><b>${shipped.length} confirmed shipped today</b> (requires a shipment date); <b>${ready.length} Ready to Pick still pending</b>.</p><h3>Shipped today</h3>`+table(shipped,cols.slice(0,4))+`<h3>Ready to Pick still pending</h3>`+table(ready,cols)+`<p>Delay reasons are shown only when recorded in Operations. Orders awaiting materials are excluded from the Ready to Pick queue.</p>`;
   }
   const sender=process.env.SMTP_USER||process.env.FROM_EMAIL;
   if(testMode)subject='[TEST] '+subject;
   await sendEmail({fromEmail:sender,to:recipients,subject,html});
   if(!testMode){
    const update=await fetch(`${logUrl}?report_day=eq.${day}&report_type=eq.${kind}`,{method:'PATCH',headers,body:JSON.stringify({status:'sent',sent_at:new Date().toISOString(),order_count:ready.length})});
    if(!update.ok)console.error('Shipping report sent but logging failed:',update.status);
   }
   return res.json({success:true,testMode,day,kind,recipients:recipients.length,pending:ready.length});
  }catch(e){
   console.error('Shipping report failed:',e);
   return res.status(500).json({success:false,error:e.message,claimed});
  }
 });
}
module.exports={install};
