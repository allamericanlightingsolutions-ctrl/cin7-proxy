const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CIN7_USERNAME = process.env.CIN7_USERNAME;
const CIN7_API_KEY = process.env.CIN7_API_KEY;
const CIN7_BASE_URL = (process.env.CIN7_BASE_URL || 'https://api.cin7.com/api/v1').replace(/\/$/, '');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'l.gonzalez@allamericanlightingsolutions.com').toLowerCase();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function authHeader() {
  const creds = Buffer.from(`${CIN7_USERNAME}:${CIN7_API_KEY}`).toString('base64');
  return `Basic ${creds}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cin7Fetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (res.status === 429) {
    await sleep(1000);
    return cin7Fetch(url, options);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Cin7 API error ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return data;
}

async function fetchAllPages(endpoint, extraParams = '') {
  let page = 1;
  const limit = 250;
  let allResults = [];

  while (true) {
    const url = `${CIN7_BASE_URL}/${endpoint}?rows=${limit}&page=${page}${extraParams}`;
    const data = await cin7Fetch(url);
    await sleep(350);

    const items = Array.isArray(data)
      ? data
      : data.ProductList || data.Products || data.BranchList || data.Branches || data.StockList || data.Stock || [];

    if (!items || items.length === 0) break;
    allResults = allResults.concat(items);
    if (items.length < limit) break;
    page++;
  }

  return allResults;
}

async function verifyAdmin(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Proxy missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.');
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new Error('Missing Supabase user token.');

  const userRes = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  if (!userRes.ok) throw new Error('Could not verify Supabase session.');

  const user = await userRes.json();
  const email = String(user.email || '').toLowerCase();

  if (email !== ADMIN_EMAIL) {
    throw new Error(`Only ${ADMIN_EMAIL} can send orders to Cin7.`);
  }

  return user;
}

function cleanText(value, max = 250) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function getFirstItem(order) {
  return Array.isArray(order.items) && order.items.length ? order.items[0] : {};
}

function buildCin7SalesOrder(order, adminUser) {
  const first = getFirstItem(order);
  const orderNumber = cleanText(order.order_number || order.quote_number || `AALS-${Date.now()}`, 30);
  const storeNum = cleanText(first.store_num || '');
  const storeName = cleanText(first.store || `Bath & Body Works${storeNum ? ' Store #' + storeNum : ''}`);
  const requestedBy = cleanText(order.user_email || adminUser.email || '');
  const todayIso = new Date().toISOString();

  const lineItems = (order.items || []).map((item, index) => {
    const code = cleanText(item.cin7_code || item.part || item.vendor_part || '', 100);
    if (!code) return null;

    const qty = Number(item.order_qty || item.qty || 1);
    const comments = [
      item.store_num ? `Store #${item.store_num}` : '',
      item.store ? `Store: ${item.store}` : '',
      item.location ? `Location: ${item.location}` : '',
      item.vendor_part ? `Vendor Part: ${item.vendor_part}` : ''
    ].filter(Boolean).join(' | ');

    return {
      sort: (index + 1) * 10,
      code,
      styleCode: code,
      name: cleanText(item.description || code, 250),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      lineComments: comments
    };
  }).filter(Boolean);

  if (!lineItems.length) {
    throw new Error('Order has no valid line items to send to Cin7.');
  }

  return {
    reference: orderNumber,
    customerOrderNo: orderNumber,
    stage: process.env.CIN7_DRAFT_STAGE || 'New',
    isApproved: false,

    company: process.env.CIN7_CUSTOMER_COMPANY || 'Bath & Body Works',
    memberEmail: process.env.CIN7_MEMBER_EMAIL || '',
    email: requestedBy,

    deliveryCompany: storeNum ? `Bath & Body Works Store #${storeNum}` : 'Bath & Body Works',
    deliveryFirstName: 'BBW',
    deliveryLastName: storeNum ? `Store ${storeNum}` : 'Store',
    deliveryAddress1: cleanText(first.store_address || ''),
    deliveryCity: cleanText(first.store_city || ''),
    deliveryState: cleanText(first.store_state || ''),
    deliveryPostalCode: cleanText(first.store_zip || ''),
    deliveryCountry: cleanText(first.store_country || 'US'),

    billingCompany: process.env.CIN7_CUSTOMER_COMPANY || 'Bath & Body Works',
    billingCountry: 'US',

    internalComments: cleanText(
      `Created from AALS BBW Catalog as Draft/New. Supabase order: ${orderNumber}. Store: ${storeName}${storeNum ? ' #' + storeNum : ''}. Requested by: ${requestedBy}. Final pricing, tax, shipping, and availability to be confirmed in Cin7. Notes: ${order.notes || ''}`,
      2000
    ),

    lineItems,
    createdDate: todayIso
  };
}

// ─── Existing product/catalog endpoints ──────────────────────────────────────

app.get('/api/categories', async (req, res) => {
  try {
    const products = await fetchAllPages('products', '&fields=ID,SKU,Category');
    const cats = [...new Set(products.map(p => p.Category).filter(Boolean))].sort();
    res.json({ count: cats.length, categories: cats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const { category } = req.query;
    const params = category
      ? `&fields=ID,SKU,Name,Category,Brand,PriceTier1,UnitCost,ShortDescription,Barcode,UOM,Status,Tags,PictureURL&where=Category%3D'${encodeURIComponent(category)}'`
      : '';
    const products = await fetchAllPages('products', params);
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stock', async (req, res) => {
  try {
    const { category, branch } = req.query;
    let params = '';
    if (category) params = `&where=Category%3D'${encodeURIComponent(category)}'`;
    const stockData = await fetchAllPages('products/stocklevels', params);

    let result = stockData;
    if (branch) {
      result = stockData.map(item => {
        const filtered = { ...item };
        if (item.ProductOptions) {
          filtered.ProductOptions = item.ProductOptions.map(opt => ({
            ...opt,
            StockLevels: (opt.StockLevels || []).filter(sl =>
              sl.Name?.toLowerCase().includes(branch.toLowerCase())
            )
          }));
        }
        return filtered;
      });
    }

    const normalized = result.map(item => {
      const options = item.ProductOptions || [];
      let totalAvailable = 0;
      const branchBreakdown = {};
      options.forEach(opt => {
        (opt.StockLevels || []).forEach(sl => {
          const qty = sl.Available ?? sl.OnHand ?? 0;
          totalAvailable += qty;
          if (!branchBreakdown[sl.Name]) branchBreakdown[sl.Name] = 0;
          branchBreakdown[sl.Name] += qty;
        });
      });

      return {
        id: item.ID,
        sku: item.SKU,
        name: item.Name,
        category: item.Category,
        availableQty: totalAvailable,
        branchStock: Object.entries(branchBreakdown).map(([name, qty]) => ({ branch: name, qty })),
        lastUpdated: new Date().toISOString()
      };
    });

    res.json({ success: true, count: normalized.length, stock: normalized });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stock/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const encodedSku = encodeURIComponent(`'${sku}'`);
    const url = `${CIN7_BASE_URL}/products/stocklevels?where=SKU%3D${encodedSku}`;
    const data = await cin7Fetch(url);

    const items = Array.isArray(data) ? data : data.StockList || data.Stock || data.Products || [];
    if (!items || items.length === 0) {
      return res.json({ success: true, sku, availableQty: 0, branchStock: [] });
    }

    const item = items[0];
    const options = item.ProductOptions || [];
    let totalAvailable = 0;
    const branchBreakdown = {};

    options.forEach(opt => {
      (opt.StockLevels || []).forEach(sl => {
        const qty = sl.Available ?? sl.OnHand ?? 0;
        totalAvailable += qty;
        if (!branchBreakdown[sl.Name]) branchBreakdown[sl.Name] = 0;
        branchBreakdown[sl.Name] += qty;
      });
    });

    res.json({
      success: true,
      sku,
      name: item.Name,
      category: item.Category,
      availableQty: totalAvailable,
      branchStock: Object.entries(branchBreakdown).map(([name, qty]) => ({ branch: name, qty })),
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/catalog', async (req, res) => {
  try {
    const { category } = req.query;
    const categoryFilter = category ? `&where=Category%3D'${encodeURIComponent(category)}'` : '';

    const [products, stockData] = await Promise.all([
      fetchAllPages('products', `${categoryFilter}&fields=ID,SKU,Name,Category,Brand,PriceTier1,UnitCost,ShortDescription,Barcode,UOM,Status,Tags,PictureURL`),
      fetchAllPages('products/stocklevels', categoryFilter)
    ]);

    const stockMap = {};
    stockData.forEach(item => {
      const options = item.ProductOptions || [];
      let total = 0;
      const branches = {};
      options.forEach(opt => {
        (opt.StockLevels || []).forEach(sl => {
          const qty = sl.Available ?? sl.OnHand ?? 0;
          total += qty;
          if (!branches[sl.Name]) branches[sl.Name] = 0;
          branches[sl.Name] += qty;
        });
      });
      stockMap[item.SKU] = {
        availableQty: total,
        branchStock: Object.entries(branches).map(([name, qty]) => ({ branch: name, qty }))
      };
    });

    const enriched = products.map(p => ({
      id: p.ID,
      sku: p.SKU,
      name: p.Name,
      category: p.Category,
      brand: p.Brand,
      price: p.PriceTier1 || p.Price || 0,
      costPrice: p.UnitCost || 0,
      description: p.ShortDescription || p.Description || '',
      barcode: p.Barcode,
      unit: p.UOM,
      status: p.Status,
      tags: p.Tags || '',
      image: p.PictureURL || '',
      availableQty: stockMap[p.SKU]?.availableQty ?? null,
      branchStock: stockMap[p.SKU]?.branchStock ?? [],
      stockLastUpdated: new Date().toISOString()
    }));

    res.json({ success: true, count: enriched.length, products: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/branches', async (req, res) => {
  try {
    const data = await cin7Fetch(`${CIN7_BASE_URL}/ref/branch`);
    res.json({ success: true, branches: data.BranchList || data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Shipping rates endpoint, preserved from current proxy ───────────────────

app.post('/api/shipping-rates', async (req, res) => {
  try {
    const { toPostalCode, toCountry, weightLbs } = req.body;
    if (!toPostalCode) return res.status(400).json({ success: false, error: 'toPostalCode required' });

    const SS_KEY = process.env.SS_KEY;
    const SS_SECRET = process.env.SS_SECRET;
    if (!SS_KEY || !SS_SECRET) {
      return res.status(400).json({ success: false, error: 'ShipStation credentials are not configured.' });
    }

    const ssAuth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
    const carriersRes = await fetch('https://ssapi.shipstation.com/carriers', {
      headers: { 'Authorization': `Basic ${ssAuth}`, 'Content-Type': 'application/json' }
    });
    const carriersData = await carriersRes.json();
    const carriers = Array.isArray(carriersData) ? carriersData : [];

    const weight = weightLbs || 1;
    const rateRequests = carriers.map(carrier =>
      fetch('https://ssapi.shipstation.com/shipments/getrates', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${ssAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrierCode: carrier.code,
          fromPostalCode: '33325',
          toCountry: toCountry || 'US',
          toPostalCode,
          weight: { value: weight, units: 'pounds' },
          dimensions: { units: 'inches', length: 12, width: 10, height: 8 }
        })
      }).then(r => r.json()).catch(() => [])
    );

    const allRates = await Promise.all(rateRequests);
    const flatRates = allRates.flat().filter(r => r && r.shipmentCost !== undefined);
    flatRates.sort((a, b) => (a.shipmentCost + a.otherCost) - (b.shipmentCost + b.otherCost));

    const top5 = flatRates.slice(0, 5).map(r => ({
      carrier: r.carrierCode,
      service: r.serviceName,
      cost: parseFloat((r.shipmentCost + r.otherCost).toFixed(2)),
      days: r.transitDays || null
    }));

    res.json({ success: true, rates: top5 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Send approved catalog order to Cin7 as Draft/New Sales Order ─────────────

app.post('/api/send-order-to-cin7', async (req, res) => {
  try {
    const adminUser = await verifyAdmin(req);
    const { order } = req.body;

    if (!order) return res.status(400).json({ success: false, error: 'Missing order payload.' });
    if (String(order.status || '').toLowerCase() !== 'approved') {
      return res.status(400).json({ success: false, error: 'Only approved orders can be sent to Cin7.' });
    }
    if (order.cin7_order_id) {
      return res.status(400).json({ success: false, error: 'This order already has a Cin7 order id.' });
    }

    const salesOrder = buildCin7SalesOrder(order, adminUser);
    const endpoint = `${CIN7_BASE_URL}/SalesOrders?loadboms=false`;

    const cin7Response = await cin7Fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify([salesOrder])
    });

    const result = Array.isArray(cin7Response) ? cin7Response[0] : cin7Response;
    const success = result?.Success === true || result?.success === true || !!result?.Id || !!result?.id;

    if (!success) {
      return res.status(400).json({
        success: false,
        error: result?.Errors?.join('; ') || result?.errors?.join('; ') || result?.Message || result?.message || 'Cin7 rejected the sales order.',
        cin7Response,
        payload: salesOrder
      });
    }

    res.json({
      success: true,
      cin7_order_id: result.Id || result.id,
      cin7_order_number: result.Code || result.code || result.Reference || result.reference || '',
      cin7_status: 'sent_to_cin7_draft',
      cin7Response,
      payload: salesOrder
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Email confirmation endpoint, preserved in simplified form ────────────────

app.post('/api/send-order-email', async (req, res) => {
  try {
    const { order, userEmail } = req.body;
    if (!order || !userEmail) return res.status(400).json({ success: false, error: 'Missing order or email' });

    const RESEND_KEY = process.env.RESEND_KEY;
    if (!RESEND_KEY) return res.status(400).json({ success: false, error: 'RESEND_KEY is not configured.' });

    const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
    const adminEmail = process.env.ADMIN_EMAIL || 'l.gonzalez@allamericanlightingsolutions.com';

    const itemsRows = (order.items || []).map(item => `
      <tr>
        <td>${cleanText(item.store || '')}${item.store_num ? ' #' + cleanText(item.store_num) : ''}</td>
        <td>${cleanText(item.part || item.cin7_code || '')}</td>
        <td>${cleanText(item.description || '', 120)}</td>
        <td>${cleanText(item.order_qty || 0)}</td>
      </tr>
    `).join('');

    const htmlBody = `
      <div style="font-family:Segoe UI,Arial,sans-serif;color:#0B1F3A">
        <h2>AALS Order Confirmation</h2>
        <p>Your order has been received and is being processed.</p>
        <p><b>Order Number:</b> ${cleanText(order.order_number)}</p>
        <p><b>Status:</b> Pending</p>
        <table border="1" cellspacing="0" cellpadding="8" style="border-collapse:collapse">
          <thead><tr><th>Store</th><th>Part #</th><th>Description</th><th>Qty</th></tr></thead>
          <tbody>${itemsRows}</tbody>
        </table>
        ${order.notes ? `<p><b>Notes:</b> ${cleanText(order.notes, 1000)}</p>` : ''}
        <p>Final pricing, tax, shipping, and availability will be confirmed by AALS through Cin7.</p>
      </div>
    `;

    const resCustomer = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `AALS Orders <${fromEmail}>`,
        to: [userEmail],
        subject: `Order Confirmation - ${order.order_number}`,
        html: htmlBody
      })
    });

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `AALS Orders <${fromEmail}>`,
        to: [adminEmail],
        subject: `New Order - ${order.order_number} from ${userEmail}`,
        html: htmlBody
      })
    });

    const data = await resCustomer.json();
    if (data.id) {
      res.json({ success: true, id: data.id });
    } else {
      res.status(400).json({ success: false, error: data.message || 'Failed to send' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'AALS Cin7 Proxy running ✅', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
