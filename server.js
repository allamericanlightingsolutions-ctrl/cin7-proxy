const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CIN7_USERNAME = process.env.CIN7_USERNAME;
const CIN7_API_KEY = process.env.CIN7_API_KEY;

app.use(cors());
app.use(express.json());

// ─── Auth Header ────────────────────────────────────────────────────────────
function authHeader() {
  const creds = Buffer.from(`${CIN7_USERNAME}:${CIN7_API_KEY}`).toString('base64');
  return `Basic ${creds}`;
}

// ─── Rate Limiter (max 3 req/seg a Cin7) ────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cin7Fetch(url) {
  const res = await fetch(url, {
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json'
    }
  });

  if (res.status === 429) {
    await sleep(1000);
    return cin7Fetch(url);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cin7 API error ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── Paginator genérico ──────────────────────────────────────────────────────
async function fetchAllPages(endpoint, extraParams = '') {
  let page = 1;
  const limit = 250;
  let allResults = [];

  while (true) {
    const url = `https://api.cin7.com/api/v1/${endpoint}?rows=${limit}&page=${page}${extraParams}`;
    const data = await cin7Fetch(url);
    await sleep(350);

    const items = Array.isArray(data) ? data :
      data.ProductList || data.Products ||
      data.BranchList  || data.Branches ||
      data.StockList   || data.Stock || [];

    if (!items || items.length === 0) break;
    allResults = allResults.concat(items);
    if (items.length < limit) break;
    page++;
  }

  return allResults;
}

// ─── GET /api/categories ─────────────────────────────────────────────────────
// Lista todas las categorías únicas en Cin7 (útil para diagnóstico)
app.get('/api/categories', async (req, res) => {
  try {
    const products = await fetchAllPages('products', '&fields=ID,SKU,Category');
    const cats = [...new Set(products.map(p => p.Category).filter(Boolean))].sort();
    res.json({ count: cats.length, categories: cats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/products ───────────────────────────────────────────────────────
// Todos los productos de Cin7 (sin stock)
app.get('/api/products', async (req, res) => {
  try {
    const { category } = req.query;
    // ✅ FIX: comillas simples en lugar de dobles para el filtro where
    const params = category
      ? `&fields=ID,SKU,Name,Category,Brand,PriceTier1,UnitCost,ShortDescription,Barcode,UOM,Status,Tags,PictureURL&where=Category%3D'${encodeURIComponent(category)}'`
      : '';
    const products = await fetchAllPages('products', params);
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/stock ──────────────────────────────────────────────────────────
// Niveles de stock reales desde Cin7
app.get('/api/stock', async (req, res) => {
  try {
    const { category, branch } = req.query;

    // ✅ FIX: comillas simples en el filtro where
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

// ─── GET /api/stock/:sku ─────────────────────────────────────────────────────
// Stock de un producto específico por SKU
app.get('/api/stock/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    // ✅ FIX: comillas simples para el filtro SKU
    const encodedSku = encodeURIComponent(`'${sku}'`);
    const url = `https://api.cin7.com/api/v1/products/stocklevels?where=SKU%3D${encodedSku}`;
    const data = await cin7Fetch(url);

    const items = Array.isArray(data) ? data :
      data.StockList || data.Stock || data.Products || [];

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

// ─── GET /api/catalog ────────────────────────────────────────────────────────
// Productos + stock combinados. Usa ?category=BBW|Burlington|Walgreens
app.get('/api/catalog', async (req, res) => {
  try {
    const { category } = req.query;
    // ✅ FIX: comillas simples en el filtro where
    const categoryFilter = category
      ? `&where=Category%3D'${encodeURIComponent(category)}'`
      : '';

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

// ─── GET /api/branches ───────────────────────────────────────────────────────
app.get('/api/branches', async (req, res) => {
  try {
    const data = await cin7Fetch('https://api.cin7.com/api/v1/ref/branch');
    res.json({ success: true, branches: data.BranchList || data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/shipping-rates ────────────────────────────────────────────────
app.post('/api/shipping-rates', async (req, res) => {
  try {
    const { toPostalCode, toCountry, weightLbs } = req.body;
    if (!toPostalCode) return res.status(400).json({ success: false, error: 'toPostalCode required' });

    const SS_KEY = process.env.SS_KEY;
    const SS_SECRET = process.env.SS_SECRET;
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

// ─── POST /api/send-order-email ──────────────────────────────────────────────
app.post('/api/send-order-email', async (req, res) => {
  try {
    const { order, userEmail } = req.body;
    if (!order || !userEmail) return res.status(400).json({ success: false, error: 'Missing order or email' });

    const RESEND_KEY = process.env.RESEND_KEY;
    const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
    const adminEmail = process.env.ADMIN_EMAIL || 'l.gonzalez@allamericanlightingsolutions.com';

    const itemsRows = (order.items || []).map(item => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333">${item.store || ''}${item.store_num ? ' #' + item.store_num : ''}<br><span style="font-size:11px;color:#888">${item.store_address ? item.store_address + ', ' + item.store_city + ' ' + item.store_zip : ''}</span></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#CC0000;font-weight:600">${item.part || ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333">${(item.description || '').split(' Item used in:')[0].split(' Lamp used in:')[0].substring(0, 80)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:center;font-weight:600">${item.order_qty || 0}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:right;color:#065F46;font-weight:600">${item.price || '—'}</td>
      </tr>`).join('');

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:620px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
    <div style="background:#0B1F3A;padding:24px 32px;display:flex;align-items:center">
      <div>
        <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:0.05em">AALS<span style="color:#CC0000"> ///</span></div>
        <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:2px">All American Lighting Solutions</div>
      </div>
    </div>
    <div style="padding:32px">
      <h1 style="font-size:20px;color:#0B1F3A;margin:0 0 8px">Order Confirmation</h1>
      <p style="color:#666;font-size:14px;margin:0 0 24px">Your order has been received and is being processed.</p>
      <div style="background:#f8f9fa;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;gap:32px;flex-wrap:wrap">
        <div><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.08em">Order Number</div><div style="font-size:15px;font-weight:700;color:#0B1F3A;margin-top:3px">${order.order_number}</div></div>
        <div><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.08em">Date</div><div style="font-size:15px;font-weight:700;color:#0B1F3A;margin-top:3px">${new Date(order.created_at).toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'})}</div></div>
        <div><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.08em">Status</div><div style="font-size:15px;font-weight:700;color:#CC0000;margin-top:3px">Pending</div></div>
      </div>
      <h2 style="font-size:14px;font-weight:700;color:#0B1F3A;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px">Order Items</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <thead>
          <tr style="background:#0B1F3A">
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:rgba(255,255,255,0.8);font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Store</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:rgba(255,255,255,0.8);font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Part #</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:rgba(255,255,255,0.8);font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Description</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:rgba(255,255,255,0.8);font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Qty</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;color:rgba(255,255,255,0.8);font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Price</th>
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
      </table>
      <div style="border-top:2px solid #eee;padding-top:16px;margin-bottom:24px">
        <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:14px;color:#555"><span>Subtotal</span><span>$${order.subtotal || '0.00'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:14px;color:#555"><span>Tax (7%)</span><span>$${order.tax || '0.00'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:14px;color:#555"><span>Shipping${order.shipping_service ? ' (' + order.shipping_service + ')' : ''}</span><span>${order.shipping ? '$' + order.shipping : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:10px 0 5px;font-size:16px;font-weight:800;color:#0B1F3A;border-top:1px solid #eee;margin-top:6px"><span>Estimated Total</span><span>$${order.estimated_total || '0.00'}</span></div>
      </div>
      ${order.notes ? `<div style="background:#FFF8E1;border-radius:8px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#555"><strong>📝 Notes:</strong> ${order.notes}</div>` : ''}
      <div style="background:#FDECEA;border-radius:8px;padding:14px 16px;font-size:13px;color:#555;margin-bottom:24px">
        <strong>📋 Note:</strong> This is an estimated total for reference only. Your final invoice will be sent through Cin7 at the end of the month.
      </div>
    </div>
    <div style="background:#f8f9fa;padding:20px 32px;text-align:center;border-top:1px solid #eee">
      <p style="font-size:12px;color:#888;margin:0">All American Lighting Solutions · <a href="https://aals-catalog.netlify.app" style="color:#CC0000;text-decoration:none">aals-catalog.netlify.app</a></p>
    </div>
  </div>
</body>
</html>`;

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

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AALS Cin7 Proxy running ✅', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
