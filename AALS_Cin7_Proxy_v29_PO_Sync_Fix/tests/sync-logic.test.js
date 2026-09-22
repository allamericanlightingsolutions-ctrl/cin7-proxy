const assert = require('assert');
const Module = require('module');

// The validation exercises pure sync helpers without opening a web server or
// requiring installed production dependencies.
const originalLoad = Module._load;
Module._load = function mockProductionDependencies(request, parent, isMain) {
  if (request === 'express') {
    const express = () => new Proxy({}, { get: () => () => {} });
    express.json = () => () => {};
    return express;
  }
  if (request === 'cors') return () => () => {};
  if (request === 'node-fetch') return async () => { throw new Error('Network access is disabled in unit tests.'); };
  return originalLoad(request, parent, isMain);
};

const {
  cin7DocumentStatusV25,
  cin7StageV25,
  cin7IsVoidOrderV25,
  normalizeCin7SalesOrderForOperations,
  normalizeRefLooseV24,
  operationsRowsMatchingCin7V25,
  normalizeCin7PoStatusV28,
  normalizeCin7PurchaseOrderForOperationsV28
} = require('../server');
Module._load = originalLoad;

const voidWithActiveStage = {
  Id: 19618,
  Ref: 'AALS-00009',
  Status: 'Void',
  Stage: 'New',
  CreatedDate: '2026-09-03T18:40:00Z'
};

assert.strictEqual(cin7DocumentStatusV25(voidWithActiveStage), 'Void');
assert.strictEqual(cin7StageV25(voidWithActiveStage), 'New');
assert.strictEqual(cin7IsVoidOrderV25(voidWithActiveStage), true);

const normalizedVoid = normalizeCin7SalesOrderForOperations(voidWithActiveStage, { email: 'admin@example.com' });
assert.strictEqual(normalizedVoid.status, 'cancelled');
assert.strictEqual(normalizedVoid.cin7_status, 'Void');
assert.strictEqual(normalizedVoid.cin7_stage, 'New');

assert.strictEqual(normalizeRefLooseV24('Cin7 Ref #AALS-00009'), 'aals-00009');
assert.strictEqual(normalizeRefLooseV24(' AALS-00009 '), 'aals-00009');

const operationsRows = [
  { id: 'catalog-row', order_number: 'AALS-00009', external_source: 'catalog', status: 'new' },
  { id: 'cin7-row', order_number: 'Cin7 Ref #AALS-00009', external_source: 'cin7_sales_orders', external_id: '19618', status: 'new' },
  { id: 'other-row', order_number: 'AALS-00100', external_source: 'catalog', status: 'new' }
];

const matches = operationsRowsMatchingCin7V25(operationsRows, voidWithActiveStage);
assert.deepStrictEqual(matches.map(row => row.id).sort(), ['catalog-row', 'cin7-row']);

const activeOrder = { Id: 20000, Ref: 'AALS-00101', Status: 'Open', Stage: 'New' };
assert.strictEqual(cin7IsVoidOrderV25(activeOrder), false);
assert.strictEqual(normalizeCin7SalesOrderForOperations(activeOrder, {}).status, 'new');

const purchaseOrder = {
  Id: 991,
  Reference: 'PO-AALS-37385',
  CustomerOrderNo: 'AALS-00041A / 353503',
  Status: 'Open',
  CreatedDate: '2026-09-21T12:00:00Z',
  ModifiedDate: '2026-09-22T13:00:00Z',
  EstimatedDeliveryDate: '2026-09-26T00:00:00Z',
  TrackingCode: '1Z999AA10123456784',
  Company: { Name: 'Example Supplier' },
  LineItems: [
    { Id: 1, Code: 'CTL2830-P', Name: 'WHITE PAR30 GIMBAL TRACK HEAD', Qty: 4 },
    { Id: 2, Code: '479626', Name: 'PHILIPS F32T8', Qty: 10 }
  ]
};
const normalizedPurchaseOrder = normalizeCin7PurchaseOrderForOperationsV28(purchaseOrder, { email: 'admin@example.com' });
assert.strictEqual(normalizeCin7PoStatusV28(purchaseOrder), 'Ordered');
assert.strictEqual(normalizedPurchaseOrder.source_key, 'cin7_purchase_order:991');
assert.strictEqual(normalizedPurchaseOrder.sync_read_only, true);
assert.strictEqual(normalizedPurchaseOrder.po_number, 'PO-AALS-37385');
assert.strictEqual(normalizedPurchaseOrder.work_order, 'AALS-00041A / 353503');
assert.strictEqual(normalizedPurchaseOrder.sku, 'CTL2830-P | 479626');
assert.ok(normalizedPurchaseOrder.quantity.includes('CTL2830-P: 4'));
assert.strictEqual(normalizedPurchaseOrder.etd, '2026-09-26');

console.log('v25/v29 sync logic tests passed.');
