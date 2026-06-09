const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Your Cin7 credentials (set these as environment variables in Render)
const CIN7_USERNAME = process.env.CIN7_USERNAME;
const CIN7_API_KEY = process.env.CIN7_API_KEY;

app.use(cors());
app.use(express.json());

// Helper: build Basic Auth header
function authHeader() {
  const creds = Buffer.from(`${CIN7_USERNAME}:${CIN7_API_KEY}`).toString('base64');
  return `Basic ${creds}`;
}

// Helper: fetch all pages from Cin7
async function fetchAllPages(endpoint) {
  let page = 1;
  const limit = 100;
  let allResults = [];

  while (true) {
    const url = `https://inventory.dearsystems.com/ExternalApi/v2/${endpoint}?limit=${limit}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': authHeader(),
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cin7 API error ${res.status}: ${text}`);
    }

    const data = await res.json();

    // Cin7 returns different root keys depending on endpoint
    const items = data.ProductList || data.Products || data.BranchList ||
                  data.Branches || data.StockList || data.Stock || [];

    if (!items || items.length === 0) break;
    allResults = allResults.concat(items);
    if (items.length < limit) break;
    page++;
  }

  return allResults;
}

// GET /api/products — fetch all products
app.get('/api/products', async (req, res) => {
  try {
    const products = await fetchAllPages('product');
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/stock — fetch stock levels
app.get('/api/stock', async (req, res) => {
  try {
    const stock = await fetchAllPages('ref/product/stock');
    res.json({ success: true, count: stock.length, stock });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/branches — fetch all branches/locations
app.get('/api/branches', async (req, res) => {
  try {
    const url = `https://inventory.dearsystems.com/ExternalApi/v2/ref/branch`;
    const res2 = await fetch(url, {
      headers: {
        'Authorization': authHeader(),
        'Content-Type': 'application/json'
      }
    });
    const data = await res2.json();
    res.json({ success: true, branches: data.BranchList || data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/catalog — combined products + stock in one call
app.get('/api/catalog', async (req, res) => {
  try {
    const [products, stock] = await Promise.all([
      fetchAllPages('product'),
      fetchAllPages('ref/product/stock').catch(() => [])
    ]);

    // Map stock by SKU
    const stockMap = {};
    stock.forEach(s => {
      if (s.SKU) stockMap[s.SKU] = s.Available ?? s.OnHand ?? 0;
    });

    // Enrich products with stock
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
      stock: stockMap[p.SKU] ?? null,
      status: p.Status,
      tags: p.Tags || '',
      image: p.PictureURL || '',
    }));

    res.json({ success: true, count: enriched.length, products: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/shipping-rates — get ShipStation rates
app.post('/api/shipping-rates', async (req, res) => {
  try {
    const { toPostalCode, toCountry, weightLbs } = req.body;
    if (!toPostalCode) return res.status(400).json({ success: false, error: 'toPostalCode required' });

    const SS_KEY = process.env.SS_KEY;
    const SS_SECRET = process.env.SS_SECRET;
    const ssAuth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');

    // Get available carriers first
    const carriersRes = await fetch('https://ssapi.shipstation.com/carriers', {
      headers: { 'Authorization': `Basic ${ssAuth}`, 'Content-Type': 'application/json' }
    });
    const carriersData = await carriersRes.json();
    const carriers = Array.isArray(carriersData) ? carriersData : [];

    // Fetch rates for each carrier in parallel
    const weight = weightLbs || 1;
    const rateRequests = carriers.map(carrier =>
      fetch('https://ssapi.shipstation.com/shipments/getrates', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${ssAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrierCode: carrier.code,
          fromPostalCode: '33325',
          toCountry: toCountry || 'US',
          toPostalCode: toPostalCode,
          weight: { value: weight, units: 'pounds' },
          dimensions: { units: 'inches', length: 12, width: 10, height: 8 }
        })
      }).then(r => r.json()).catch(() => [])
    );

    const allRates = await Promise.all(rateRequests);
    const flatRates = allRates.flat().filter(r => r && r.shipmentCost !== undefined);

    // Sort by total cost
    flatRates.sort((a, b) => (a.shipmentCost + a.otherCost) - (b.shipmentCost + b.otherCost));

    // Return top 5 cheapest options
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AALS Cin7 Proxy running ✅', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
