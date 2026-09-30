'use strict';

const AALS_BRANCH = 'ALL AMERICAN LIGHTING SOLUTIONS, FLORIDA';
const key = value => String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const normalizedStatus = value => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const val = (obj, fields) => fields.map(field => obj?.[field]).find(value => value !== undefined && value !== null && value !== '');
const isTrue = value => value === true || value === 1 || /^(true|1)$/i.test(String(value || ''));

function unavailable(reason, branch = AALS_BRANCH) {
  return {status:'waiting_materials', verified:false, branch, shortages:[], checkedAt:new Date().toISOString(), warning:String(reason || 'Inventory unavailable')};
}

function evaluateInventory(items, stock, {branch = AALS_BRANCH, cin7Order = null} = {}) {
  try {
    if (!Array.isArray(items) || !items.length) return unavailable('Order lines are missing; manual review is required.', branch);
    if (!Array.isArray(stock)) return unavailable('Cin7 stock response is invalid.', branch);
    const branchKey = key(branch);
    if (!stock.some(row => (row.branchStock || []).some(b => key(b.branch) === branchKey))) return unavailable('The AALS inventory branch is missing from the stock response.', branch);
    const required = new Map();
    for (const item of items) {
      const raw = item.cin7_line_payload || item;
      const sku = key(val(item, ['cin7_code','sku','SKU','code','Code','product_code','part']) || val(raw, ['Code','code']));
      const ordered = Number(val(raw, ['Qty','qty']) ?? val(item, ['order_qty','quantity','Quantity','qty','Qty']));
      const shipped = Number(val(raw, ['QtyShipped','qtyShipped','qty_shipped']) ?? val(item, ['qty_shipped','fulfilled_qty']) ?? 0);
      if (!sku || /^CIN7-(LINE|ORDER)/.test(sku) || !Number.isFinite(ordered) || ordered < 0 || !Number.isFinite(shipped) || shipped < 0) return unavailable('A product SKU or quantity could not be verified.', branch);
      if (val(raw, ['SizeCodes','sizeCodes','Size','size'])) return unavailable('A size-based product needs manual stock review.', branch);
      const qty = Math.max(ordered - shipped, 0);
      if (qty > 0) required.set(sku, (required.get(sku) || 0) + qty);
    }
    if (!required.size) return unavailable('No outstanding product quantity was found.', branch);

    // Cin7 Available = SOH - OpenSales. Only restore this order's own open
    // quantity when its verified Cin7 document reserves at the same branch.
    const orderBranchId = val(cin7Order, ['BranchId','branchId']);
    const reserves = cin7Order && (isTrue(val(cin7Order, ['IsApproved','isApproved'])) || ['open','approved'].includes(normalizedStatus(val(cin7Order,['Status','status']))));
    const own = new Map();
    if (reserves) for (const line of cin7Order.LineItems || cin7Order.lineItems || []) {
      const sku = key(val(line,['Code','code']));
      const qty = Math.max(Number(val(line,['Qty','qty']) || 0) - Number(val(line,['QtyShipped','qtyShipped']) || 0), 0);
      if (sku && Number.isFinite(qty)) own.set(sku, (own.get(sku) || 0) + qty);
    }
    const stockMap = new Map(stock.map(row => [key(row.sku || row.code), row]));
    const shortages = [];
    for (const [sku, requested] of required) {
      const row = stockMap.get(sku), b = (row?.branchStock || []).find(item => key(item.branch) === branchKey);
      let available = b ? Number(b.qty) : 0;
      if (!Number.isFinite(available)) return unavailable('Cin7 returned an invalid stock quantity for '+sku+'.', branch);
      if (b && orderBranchId != null && b.branchId != null && String(orderBranchId) === String(b.branchId)) {
        const open = Number(b.openSales), onHand = Number(b.stockOnHand);
        if (Number.isFinite(open) && open >= 0) available += Math.min(own.get(sku) || 0, open);
        if (Number.isFinite(onHand)) available = Math.min(available, onHand);
      }
      if (!b || available < requested) shortages.push({sku, requested, available:Math.max(available,0), reason:row?'Insufficient stock at AALS Warehouse':'SKU not found in Cin7 stock'});
    }
    return {status:shortages.length?'waiting_materials':'ready_to_pick', verified:true, branch, shortages, checkedAt:new Date().toISOString(), warning:''};
  } catch (error) { return unavailable(error?.message || 'Inventory check failed.', branch); }
}

function inventoryNotes(notes, decision, approvalPending = false) {
  const base = String(notes || '').replace(/\n?\[AALS INVENTORY V37\][\s\S]*?\[\/AALS INVENTORY V37\]/g,'').trim();
  const lines = ['[AALS INVENTORY V37]', 'Branch: '+decision.branch, 'Checked: '+decision.checkedAt,
    'Availability: '+(decision.status === 'ready_to_pick' ? 'Ready to Pick' : 'Waiting for Materials'),
    approvalPending ? 'Commercial authorization: pending. Inventory availability does not authorize picking.' : '',
    decision.verified ? '' : 'Manual inventory review required: '+decision.warning,
    ...decision.shortages.map(item => item.sku+': requested '+item.requested+', available '+item.available+' ('+item.reason+')'),
    '[/AALS INVENTORY V37]'].filter(Boolean).join('\n');
  return [base,lines].filter(Boolean).join('\n\n');
}

function needsInitialInventory(row) {
  const s = normalizedStatus(row.status);
  return !(/cancel|void|^shipped$|^dispatched$|^fully_dispatched$|transit|deliver|complete|close|hold|declin|refund/.test(s)) && !row.tracking_number && !row.tracking && !val(row.cin7_payload,['DispatchedDate','dispatchedDate']);
}

function isAwaitingApprovedInventory(row) {
  return ['approved','authorized','quote_approved'].includes(normalizedStatus(row.status));
}

module.exports = {AALS_BRANCH, evaluateInventory, unavailable, inventoryNotes, needsInitialInventory, isAwaitingApprovedInventory};

function isCatalog(row) {
 return [row.order_number,row.reference,row.cin7_reference].some(value=>/^AALS-\d+$/i.test(String(value||'').replace(/^Cin7\s*Ref\s*#?\s*/i,''))) || String(row.notes||'').includes('[CATALOG AUTO AUTHORIZATION]');
}
function initialStatus(row, decision) {
 return isCatalog(row) ? decision.status : decision.verified && decision.status==='ready_to_pick' ? 'pending_approval' : 'quote_in_progress';
}
function canRecheck(row) {
 const s=normalizedStatus(row.status);
 if(row.tracking || row.tracking_number)return false;
 if(['approved','authorized','quote_approved'].includes(s)) return true;
 return ['waiting_materials','ready_to_pick'].includes(s) && (isCatalog(row) || String(row.notes||'').includes('[AALS INVENTORY V37]'));
}
module.exports.isCatalog=isCatalog;module.exports.initialStatus=initialStatus;module.exports.canRecheck=canRecheck;
