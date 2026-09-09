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
  buildCin7SalesOrder,
  catalogConfirmationHtmlV18,
  cin7DocumentStatusV25,
  cin7StageV25,
  cin7IsVoidOrderV25,
  normalizeCin7SalesOrderForOperations,
  normalizeRefLooseV24,
  operationsRowsMatchingCin7V25
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

const b2bOrder = {
  Id: 20001,
  Ref: '37130',
  Code: 'SO-37130',
  CustomerOrderNo: 'WO-88421',
  Comments: 'Call the store before delivery.',
  DeliveryInstructions: 'Deliver to receiving door.',
  Status: 'Open',
  Stage: 'New'
};
const normalizedB2B = normalizeCin7SalesOrderForOperations(b2bOrder, {});
assert.strictEqual(normalizedB2B.reference, '37130');
assert.strictEqual(normalizedB2B.cin7_reference, '37130');
assert.match(normalizedB2B.notes, /Work Order \(WO#\): WO-88421/);
assert.match(normalizedB2B.notes, /Cin7 customer notes: Call the store before delivery\./);
assert.match(normalizedB2B.notes, /Cin7 delivery instructions: Deliver to receiving door\./);
assert.strictEqual(normalizedB2B.items[0].work_order, 'WO-88421');

const operationsWithSameRefDifferentWo = [
  { id: 'existing-b2b', order_number: 'Cin7 Ref #37130', reference: '37130' }
];
assert.deepStrictEqual(
  operationsRowsMatchingCin7V25(operationsWithSameRefDifferentWo, b2bOrder).map(row => row.id),
  ['existing-b2b']
);

const catalogOrder = {
  order_number: 'AALS-00102',
  reference: 'AALS-00102',
  user_email: 'vendor@example.com',
  items: [{
    store: 'BBW Store',
    store_num: '0050',
    store_address: '1 Main St',
    store_city: 'Mc Lean',
    store_state: 'VA',
    store_zip: '22102',
    part: 'TEST-SKU',
    description: 'Test product',
    order_qty: 2,
    work_order: 'WO-90001'
  }]
};
const cin7CatalogOrder = buildCin7SalesOrder(catalogOrder, { email: 'admin@example.com' });
assert.strictEqual(cin7CatalogOrder.reference, 'AALS-00102');
assert.strictEqual(cin7CatalogOrder.customerOrderNo, 'WO-90001');
assert.match(cin7CatalogOrder.internalComments, /Work Order: WO-90001/);
assert.match(catalogConfirmationHtmlV18(catalogOrder, 'order', 'vendor@example.com'), /Work Order \(WO#\):<\/b> WO-90001/);

console.log('v26 sync logic tests passed.');
