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


// --- v12 Cin7 tracking/status extraction helpers ---
function firstValueV12(obj, keys){
  for(const k of keys){
    if(obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  }
  return null;
}
function deepFindValueV12(obj, keyRegex, maxDepth=4){
  const seen=new Set();
  function walk(x,depth){
    if(!x || depth>maxDepth || seen.has(x))return null;
    if(typeof x==='object')seen.add(x);
    if(Array.isArray(x)){
      for(const item of x){
        const v=walk(item,depth+1);
        if(v!==null && v!==undefined && String(v).trim()!=='')return v;
      }
      return null;
    }
    if(typeof x==='object'){
      for(const [k,v] of Object.entries(x)){
        if(keyRegex.test(k) && v!==null && v!==undefined && String(v).trim()!=='')return v;
      }
      for(const v of Object.values(x)){
        const found=walk(v,depth+1);
        if(found!==null && found!==undefined && String(found).trim()!=='')return found;
      }
    }
    return null;
  }
  return walk(obj,0);
}
function cin7TrackingInfoV12(order){
  const tracking = firstValueV12(order, [
    'tracking','trackingNumber','tracking_number','TrackingNumber','TrackingNo','trackingNo',
    'consignmentNumber','ConsignmentNumber','shipmentTracking','ShipmentTracking'
  ]) || deepFindValueV12(order, /(tracking|consignment).*?(number|no)?$/i);

  const carrier = firstValueV12(order, [
    'carrier','Carrier','shippingCarrier','ShippingCarrier','shipCarrier','ShipCarrier',
    'deliveryCompany','DeliveryCompany','freightProvider','FreightProvider'
  ]) || deepFindValueV12(order, /(carrier|deliveryCompany|freightProvider|shippingProvider)/i);

  const eta = firstValueV12(order, [
    'eta','ETA','estimatedDelivery','EstimatedDelivery','deliveryDate','DeliveryDate',
    'requiredBy','RequiredBy'
  ]) || deepFindValueV12(order, /(eta|estimatedDelivery|deliveryDate|requiredBy)/i);

  const etd = firstValueV12(order, [
    'etd','ETD','dispatchDate','DispatchDate','shippedDate','ShippedDate',
    'shipDate','ShipDate'
  ]) || deepFindValueV12(order, /(etd|dispatchDate|shippedDate|shipDate)/i);

  const status = firstValueV12(order, ['status','Status','stage','Stage','orderStatus','OrderStatus']);
  const shipMethod = firstValueV12(order, ['shipMethod','ShipMethod','shippingMethod','ShippingMethod','deliveryMethod','DeliveryMethod']);

  return {
    tracking: tracking ? String(tracking).trim() : null,
    carrier: carrier ? String(carrier).trim() : (shipMethod ? String(shipMethod).trim() : null),
    eta: eta || null,
    etd: etd || null,
    cin7_status: status ? String(status).trim() : null,
    ship_method: shipMethod ? String(shipMethod).trim() : null
  };
}
function mapCin7StatusV12(status, tracking){
  const s=String(status||'').toLowerCase();
  if(/cancel/.test(s))return 'cancelled';
  if(/deliver|complete|fulfilled|closed/.test(s))return 'delivered';
  if(/dispatch|shipp|transit|picked/.test(s) || tracking)return 'shipped';
  if(/approved|authorized|release|pick|pack|process/.test(s))return 'processing';
  if(/quote|approval|pending/.test(s))return 'pending_approval';
  if(/new|draft/.test(s))return 'created';
  return null;
}


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

async function fetchAllPagesSafe(endpoint, extraParams = '') {
  let page = 1;
  const limit = 250;
  let allResults = [];

  while (true) {
    const joiner = extraParams ? '&' : '';
    const url = `${CIN7_BASE_URL}/${endpoint}?rows=${limit}&page=${page}${joiner}${extraParams}`;
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

function pickFirst(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
      return obj[key];
    }
  }
  return '';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeImageList(p) {
  const result = [];
  const direct = pickFirst(p, [
    'PictureURL','PictureUrl','ImageURL','ImageUrl','Image','Photo','PhotoURL','ProductImage','ThumbnailURL'
  ]);
  if (direct) result.push(String(direct));

  for (const key of ['images','Images','productImages','ProductImages']) {
    const arr = Array.isArray(p[key]) ? p[key] : [];
    arr.forEach(img => {
      if (typeof img === 'string') result.push(img);
      else {
        const link = img.link || img.url || img.URL || img.ImageURL || img.PictureURL;
        if (link) result.push(String(link));
      }
    });
  }
  return [...new Set(result.filter(Boolean))];
}


function normalizeProductOptions(p) {
  const options = Array.isArray(p.productOptions) ? p.productOptions
    : Array.isArray(p.ProductOptions) ? p.ProductOptions
    : [];

  return options.map(opt => ({
    id: pickFirst(opt, ['id','ID','Id','productOptionId','ProductOptionId']),
    code: pickFirst(opt, ['code','Code','productOptionCode','ProductOptionCode','sku','SKU']),
    barcode: pickFirst(opt, ['barcode','Barcode','productOptionBarcode','ProductOptionBarcode']),
    supplierCode: pickFirst(opt, ['supplierCode','SupplierCode']),
    option1: pickFirst(opt, ['option1','Option1']),
    option2: pickFirst(opt, ['option2','Option2']),
    option3: pickFirst(opt, ['option3','Option3']),
    size: pickFirst(opt, ['size','Size']),
    weight: pickFirst(opt, ['weight','Weight']),
    retailPrice: pickFirst(opt, ['retailPrice','RetailPrice']),
    wholesalePrice: pickFirst(opt, ['wholesalePrice','WholesalePrice']),
    vipPrice: pickFirst(opt, ['vipPrice','VipPrice']),
    specialPrice: pickFirst(opt, ['specialPrice','SpecialPrice']),
    stockAvailable: pickFirst(opt, ['stockAvailable','StockAvailable']),
    stockOnHand: pickFirst(opt, ['stockOnHand','StockOnHand'])
  })).filter(opt => opt.code || opt.barcode || opt.supplierCode);
}

function getPrimaryProductCode(p, options) {
  return pickFirst(p, ['code','SKU','Sku','Code','ProductCode'])
    || pickFirst(options[0] || {}, ['code','barcode','supplierCode'])
    || pickFirst(p, ['styleCode','StyleCode']);
}


function normalizeCin7Product(p) {
  const descriptionHtml = pickFirst(p, [
    'description','Description','ShortDescription','LongDescription','ProductDescription','WebDescription','Notes'
  ]);

  const pdfDescriptionHtml = pickFirst(p, [
    'pdfDescription','PdfDescription','specification','Specification','Specifications','specifications'
  ]);

  const images = normalizeImageList(p);
  const image = images[0] || '';
  const productOptions = normalizeProductOptions(p);
  const primaryCode = getPrimaryProductCode(p, productOptions);

  const specs = {
    brand: pickFirst(p, ['brand','Brand']),
    category: pickFirst(p, ['category','Category']),
    subCategory: pickFirst(p, ['subCategory','SubCategory']),
    barcode: pickFirst(p, ['barcode','Barcode','BarcodeNumber']),
    uom: pickFirst(p, ['uom','UOM','UnitOfMeasure']),
    status: pickFirst(p, ['status','Status']),
    tags: pickFirst(p, ['tags','Tags']),
    supplierCode: pickFirst(p, ['supplierCode','SupplierCode']),
    styleCode: pickFirst(p, ['styleCode','StyleCode']),
    productType: pickFirst(p, ['productType','ProductType']),
    productSubtype: pickFirst(p, ['productSubtype','ProductSubtype']),
    size: pickFirst(p, ['size','Size']),
    weight: pickFirst(p, ['weight','Weight','UnitWeight']),
    length: pickFirst(p, ['length','Length']),
    width: pickFirst(p, ['width','Width']),
    height: pickFirst(p, ['height','Height']),
    volume: pickFirst(p, ['volume','Volume']),
    option1: pickFirst(p, ['option1','Option1']),
    option2: pickFirst(p, ['option2','Option2']),
    option3: pickFirst(p, ['option3','Option3']),
    optionLabel1: pickFirst(p, ['optionLabel1','OptionLabel1']),
    optionLabel2: pickFirst(p, ['optionLabel2','OptionLabel2']),
    optionLabel3: pickFirst(p, ['optionLabel3','OptionLabel3']),
    pdfUpload: pickFirst(p, ['pdfUpload','PdfUpload','specSheet','SpecSheet']),
    customFields: p.customFields || p.CustomFields || {}
  };

  return {
    id: pickFirst(p, ['id','ID','Id','productID','ProductID']),
    sku: primaryCode,
    code: primaryCode,
    name: pickFirst(p, ['name','Name','ProductName']),
    category: specs.category,
    brand: specs.brand,
    price: pickFirst(p, ['retailPrice','PriceTier1','Price','RetailPrice']) || 0,
    wholesalePrice: pickFirst(p, ['wholesalePrice','WholesalePrice']) || 0,
    costPrice: pickFirst(p, ['unitCost','UnitCost','CostPrice','Cost']) || 0,
    description: stripHtml(descriptionHtml),
    descriptionHtml,
    pdfDescription: stripHtml(pdfDescriptionHtml),
    pdfDescriptionHtml,
    barcode: specs.barcode,
    unit: specs.uom,
    status: specs.status,
    tags: specs.tags,
    image,
    images,
    specs,
    productOptions,
    optionCodes: productOptions.map(opt => opt.code).filter(Boolean),
    raw: p
  };
}


async function verifyAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    throw new Error('Missing Authorization token.');
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase environment variables.');
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  const user = await userRes.json().catch(() => null);

  if (!userRes.ok || !user?.email) {
    throw new Error('Could not verify Supabase user.');
  }

  const email = String(user.email || '').toLowerCase();

  const staticAdmins = String(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  const fallbackAdmins = [
    'l.gonzalez@allamericanlightingsolutions.com',
    'l.gonzalez@aalsusa.com',
    'e.suarez@allamericanlightingsolutions.com'
  ];

  if ([...staticAdmins, ...fallbackAdmins].includes(email)) {
    return { ...user, email };
  }

  // Shared Supabase admin table fallback
  try {
    const adminCheckUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/aals_admin_users?select=email,is_active&email=eq.${encodeURIComponent(email)}&is_active=eq.true`;
    const adminRes = await fetch(adminCheckUrl, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });
    const adminRows = await adminRes.json().catch(() => []);
    if (adminRes.ok && Array.isArray(adminRows) && adminRows.length) {
      return { ...user, email };
    }
  } catch (err) {
    console.warn('Shared admin table check failed:', err.message);
  }

  throw new Error(`Only AALS admins can send orders to Cin7. Current user: ${email}`);
}


function cleanText(value, max = 250) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function getFirstItem(order) {
  return Array.isArray(order.items) && order.items.length ? order.items[0] : {};
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function buildCin7SalesOrder(order, adminUser) {
  const first = getFirstItem(order);
  const orderNumber = cleanText(order.order_number || order.quote_number || `AALS-${Date.now()}`, 30);
  const storeNum = cleanText(first.store_num || '');
  const storeName = cleanText(first.store || `Bath & Body Works${storeNum ? ' Store #' + storeNum : ''}`);
  const requestedBy = cleanText(order.user_email || adminUser.email || '');
  const todayIso = new Date().toISOString();
  const memberEmail = cleanText(process.env.CIN7_MEMBER_EMAIL || '');
  const customerEmail = cleanText(process.env.CIN7_CUSTOMER_EMAIL || '');
  const fallbackEmail = cleanText(process.env.CIN7_FALLBACK_EMAIL || process.env.ADMIN_EMAIL || 'orders@aalsusa.com');
  const orderEmail = cleanText(order.user_email || adminUser.email || '');
  const cin7Email = isValidEmail(customerEmail) ? customerEmail : (isValidEmail(orderEmail) ? orderEmail : fallbackEmail);

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

  const salesOrder = {
    reference: orderNumber,
    customerOrderNo: orderNumber,
    stage: process.env.CIN7_DRAFT_STAGE || 'New',
    isApproved: false,

    company: process.env.CIN7_CUSTOMER_COMPANY || 'Bath & Body Works',

    // Cin7 requires these contact fields when MemberId is zero / no existing contact is matched.
    firstName: process.env.CIN7_FIRST_NAME || 'BBW',
    lastName: process.env.CIN7_LAST_NAME || (storeNum ? `Store ${storeNum}` : 'Store'),
    phone: process.env.CIN7_PHONE || '',

    deliveryCompany: storeNum ? `Bath & Body Works Store #${storeNum}` : 'Bath & Body Works',
    deliveryFirstName: process.env.CIN7_FIRST_NAME || 'BBW',
    deliveryLastName: process.env.CIN7_LAST_NAME || (storeNum ? `Store ${storeNum}` : 'Store'),
    deliveryAddress1: cleanText(first.store_address || ''),
    deliveryCity: cleanText(first.store_city || ''),
    deliveryState: cleanText(first.store_state || ''),
    deliveryPostalCode: cleanText(first.store_zip || ''),
    deliveryCountry: cleanText(first.store_country || 'US'),

    billingCompany: process.env.CIN7_CUSTOMER_COMPANY || 'Bath & Body Works',
    billingFirstName: process.env.CIN7_FIRST_NAME || 'BBW',
    billingLastName: process.env.CIN7_LAST_NAME || (storeNum ? `Store ${storeNum}` : 'Store'),
    billingEmail: cin7Email,
    billingCountry: 'US',

    internalComments: cleanText(
      `Created from AALS BBW Catalog as Draft/New. Supabase order: ${orderNumber}. Store: ${storeName}${storeNum ? ' #' + storeNum : ''}. Requested by: ${requestedBy}. Final pricing, tax, shipping, and availability to be confirmed in Cin7. Notes: ${order.notes || ''}`,
      2000
    ),

    lineItems,
    createdDate: todayIso
  };

  // Cin7 requires Email when MemberId is 0.
  // MemberEmail is optional and only sent when explicitly configured as a valid e-mail.
  salesOrder.email = cin7Email;
  if (isValidEmail(memberEmail)) salesOrder.memberEmail = memberEmail;

  return salesOrder;
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
    const { category, raw } = req.query;
    const params = category ? `where=Category%3D'${encodeURIComponent(category)}'` : '';
    const products = await fetchAllPagesSafe('products', params);
    const normalized = raw === '1' ? products : products.map(normalizeCin7Product);
    res.json({ success: true, count: normalized.length, products: normalized });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/product-sample', async (req, res) => {
  try {
    const data = await cin7Fetch(`${CIN7_BASE_URL}/products?rows=5&page=1`);
    const items = Array.isArray(data)
      ? data
      : data.ProductList || data.Products || [];
    res.json({
      success: true,
      count: items.length,
      fields: items[0] ? Object.keys(items[0]) : [],
      sample: items.slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/product-details/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').replace(/'/g, "''");
    const data = await cin7Fetch(`${CIN7_BASE_URL}/products?rows=10&page=1&where=code%3D'${encodeURIComponent(code)}'`);
    const items = Array.isArray(data)
      ? data
      : data.ProductList || data.Products || [];
    const normalized = items.map(normalizeCin7Product);
    res.json({ success: true, count: normalized.length, products: normalized });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/catalog-code-index', async (req, res) => {
  try {
    const { includeRaw = '0' } = req.query;
    const products = await fetchAllPagesSafe('products', '');
    const normalized = products.map(normalizeCin7Product);

    const index = {};
    normalized.forEach(p => {
      const keys = [
        p.code,
        p.sku,
        ...(p.optionCodes || []),
        p.specs?.supplierCode,
        p.specs?.styleCode,
        p.barcode
      ].filter(Boolean);

      [...new Set(keys.map(k => String(k).trim()).filter(Boolean))].forEach(key => {
        index[key.toUpperCase()] = {
          id: p.id,
          code: p.code,
          sku: p.sku,
          name: p.name,
          image: p.image,
          images: p.images,
          description: p.description,
          descriptionHtml: p.descriptionHtml,
          pdfDescription: p.pdfDescription,
          pdfDescriptionHtml: p.pdfDescriptionHtml,
          brand: p.brand,
          category: p.category,
          specs: p.specs,
          optionCodes: p.optionCodes,
          productOptions: p.productOptions,
          raw: includeRaw === '1' ? p.raw : undefined
        };
      });
    });

    res.json({
      success: true,
      count: Object.keys(index).length,
      productCount: normalized.length,
      index
    });
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
    const { category, includeStock = '1', raw } = req.query;
    const params = category ? `where=Category%3D'${encodeURIComponent(category)}'` : '';

    // Safer call: Cin7 Omni can reject unsupported `fields` parameters.
    // We fetch the product object as-is, then normalize image/spec fields in the proxy.
    const products = await fetchAllPagesSafe('products', params);

    let stockData = [];
    let stockError = null;
    if (includeStock !== '0') {
      try {
        stockData = await fetchAllPagesSafe('products/stocklevels', params);
      } catch (stockErr) {
        stockError = stockErr.message;
      }
    }

    const stockMap = {};
    stockData.forEach(item => {
      const options = item.ProductOptions || [];
      let total = 0;
      const branches = {};
      options.forEach(opt => {
        (opt.StockLevels || []).forEach(sl => {
          const qty = sl.Available ?? sl.OnHand ?? 0;
          total += qty;
          const branchName = sl.Name || sl.Branch || 'Unknown';
          if (!branches[branchName]) branches[branchName] = 0;
          branches[branchName] += qty;
        });
      });

      const sku = item.SKU || item.Code || item.ProductCode;
      if (sku) {
        stockMap[sku] = {
          availableQty: total,
          branchStock: Object.entries(branches).map(([name, qty]) => ({ branch: name, qty }))
        };
      }
    });

    const enriched = products.map(p => {
      const normalized = normalizeCin7Product(p);
      const stock = stockMap[normalized.sku] || stockMap[normalized.code] || {};
      return {
        ...normalized,
        availableQty: stock.availableQty ?? null,
        branchStock: stock.branchStock ?? [],
        stockLastUpdated: new Date().toISOString(),
        raw: raw === '1' ? p : undefined
      };
    });

    res.json({
      success: true,
      count: enriched.length,
      products: enriched,
      stockWarning: stockError
    });
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



// ─── Cin7 → Operations import helpers ────────────────────────────────────────

function getAuthToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function supabaseRest(path, options = {}, token = '') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Proxy missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.');
  }

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path.replace(/^\//, '')}`;
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: token ? `Bearer ${token}` : `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Supabase REST error ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return data;
}

function normalizeCin7OrderList(data) {
  if (Array.isArray(data)) return data;
  return data?.SalesOrderList
    || data?.SalesOrders
    || data?.Orders
    || data?.OrderList
    || data?.Data
    || data?.data
    || [];
}

function normalizeCin7LineItems(order) {
  const rawItems =
    order.LineItems
    || order.lineItems
    || order.Items
    || order.items
    || order.OrderLines
    || order.orderLines
    || [];

  return (Array.isArray(rawItems) ? rawItems : []).map((line, index) => {
    const code = cleanText(pickFirst(line, [
      'Code', 'code', 'ProductCode', 'productCode', 'SKU', 'Sku', 'sku',
      'OptionCode', 'optionCode', 'ItemCode', 'itemCode'
    ]), 100);

    const description = cleanText(pickFirst(line, [
      'Name', 'name', 'ProductName', 'productName', 'Description', 'description',
      'ItemDescription', 'itemDescription'
    ]), 500);

    const qtyRaw = pickFirst(line, ['Qty', 'qty', 'Quantity', 'quantity', 'OrderedQty', 'orderedQty']);
    const qty = Number(qtyRaw || 1) || 1;

    return {
      store: cleanText(pickFirst(order, ['Company', 'company', 'Customer', 'customer', 'CustomerName', 'customerName']), 120),
      store_num: cleanText(pickFirst(order, ['Reference', 'reference', 'CustomerReference', 'customerReference']), 80),
      store_address: cleanText(pickFirst(order, ['DeliveryAddress1', 'deliveryAddress1', 'ShipAddress1', 'shipAddress1']), 180),
      store_city: cleanText(pickFirst(order, ['DeliveryCity', 'deliveryCity', 'ShipCity', 'shipCity']), 80),
      store_state: cleanText(pickFirst(order, ['DeliveryState', 'deliveryState', 'ShipState', 'shipState']), 40),
      store_zip: cleanText(pickFirst(order, ['DeliveryPostalCode', 'deliveryPostalCode', 'ShipPostCode', 'shipPostCode']), 30),
      store_country: cleanText(pickFirst(order, ['DeliveryCountry', 'deliveryCountry', 'ShipCountry', 'shipCountry']), 50),
      part: code || `CIN7-LINE-${index + 1}`,
      cin7_code: code,
      vendor_part: cleanText(pickFirst(line, ['SupplierCode', 'supplierCode', 'VendorPart', 'vendorPart']), 100),
      description: description || 'Cin7 imported line item',
      order_qty: qty,
      location: cleanText(pickFirst(line, ['Location', 'location', 'Bin', 'bin']), 120),
      cin7_line_payload: line
    };
  });
}


function normalizeCin7SalesOrderForOperations(order, adminUser) {
  const id = String(pickFirst(order, [
    'Id', 'ID', 'id', 'SalesOrderID', 'salesOrderId', 'OrderId', 'orderId'
  ]) || '');

  const code = cleanText(pickFirst(order, [
    'Code', 'code', 'OrderNumber', 'orderNumber', 'Number', 'number',
    'SalesOrderNumber', 'salesOrderNumber', 'InvoiceNumber', 'invoiceNumber'
  ]), 100);

  const reference = cleanText(pickFirst(order, [
    // Cin7 Sales Orders list uses Ref. This is the number AALS wants to track.
    'Ref', 'ref', 'SalesOrderRef', 'salesOrderRef', 'SalesOrderReference', 'salesOrderReference',
    'Reference', 'reference', 'CustomerReference', 'customerReference',
    'CustomerOrderNo', 'customerOrderNo', 'PONumber', 'poNumber', 'PO'
  ]), 160);

  const stage = cleanText(pickFirst(order, [
    'Stage', 'stage', 'Status', 'status', 'OrderStatus', 'orderStatus'
  ]), 100);

  const status = stage ? stage.toLowerCase().replace(/\s+/g, '_') : 'imported_from_cin7';

  const createdAt = pickFirst(order, [
    'CreatedDate', 'createdDate', 'CreatedAt', 'createdAt', 'Date', 'date',
    'OrderDate', 'orderDate'
  ]) || new Date().toISOString();

  const updatedAt = pickFirst(order, [
    'ModifiedDate', 'modifiedDate', 'UpdatedAt', 'updatedAt', 'LastModifiedDate',
    'lastModifiedDate'
  ]) || new Date().toISOString();

  const customerName = cleanText(pickFirst(order, [
    'Company', 'company', 'Customer', 'customer', 'CustomerName', 'customerName',
    'AccountName', 'accountName', 'BillingCompany', 'billingCompany',
    'DeliveryCompany', 'deliveryCompany'
  ]), 180);

  const customerEmail = cleanText(pickFirst(order, [
    'Email', 'email', 'CustomerEmail', 'customerEmail', 'BillingEmail', 'billingEmail',
    'ContactEmail', 'contactEmail'
  ]), 180);

  const memberName = cleanText(pickFirst(order, [
    'Member', 'member', 'MemberName', 'memberName', 'SalesRep', 'salesRep',
    'SalesRepresentative', 'salesRepresentative'
  ]), 180);

  const createdBy = cleanText(pickFirst(order, [
    'CreatedBy', 'createdBy', 'User', 'user', 'EnteredBy', 'enteredBy'
  ]), 180);

  const displayNumber = reference || code || id || `CIN7-${Date.now()}`;
  const prefixedDisplayNumber = /^cin7/i.test(displayNumber) ? displayNumber : (reference ? `Cin7 Ref #${displayNumber}` : `Cin7 #${displayNumber}`);

  let items = normalizeCin7LineItems(order);
  if (!items.length) {
    items = [{
      store: customerName || 'Cin7 Customer',
      store_num: reference || code || id,
      store_address: cleanText(pickFirst(order, ['DeliveryAddress1','deliveryAddress1','ShipAddress1','shipAddress1']), 180),
      store_city: cleanText(pickFirst(order, ['DeliveryCity','deliveryCity','ShipCity','shipCity']), 80),
      store_state: cleanText(pickFirst(order, ['DeliveryState','deliveryState','ShipState','shipState']), 40),
      store_zip: cleanText(pickFirst(order, ['DeliveryPostalCode','deliveryPostalCode','ShipPostCode','shipPostCode']), 30),
      store_country: cleanText(pickFirst(order, ['DeliveryCountry','deliveryCountry','ShipCountry','shipCountry']), 50),
      part: code || reference || id || 'CIN7-ORDER',
      cin7_code: code,
      vendor_part: '',
      description: `Imported Cin7 Sales Order ${displayNumber}`,
      order_qty: 1,
      location: 'Cin7',
      cin7_line_payload: null
    }];
  } else {
    items = items.map(item => ({
      ...item,
      store: item.store || customerName || 'Cin7 Customer',
      store_num: item.store_num || reference || code || id
    }));
  }

  const total = Number(pickFirst(order, [
    'Total', 'total', 'GrandTotal', 'grandTotal', 'OrderTotal', 'orderTotal',
    'TotalIncTax', 'totalIncTax'
  ]) || 0) || null;

  return {
    order_number: prefixedDisplayNumber,
    reference: reference || displayNumber,
    ref: reference || displayNumber,
    user_email: customerEmail || customerName || 'Imported from Cin7',
    created_by_email: 'Imported from Cin7',
    requested_by: customerName || customerEmail || 'Cin7',
    items,
    notes: [
      'Imported from Cin7.',
      customerName ? `Customer: ${customerName}` : '',
      customerEmail ? `Customer email: ${customerEmail}` : '',
      memberName ? `Member/Sales rep: ${memberName}` : '',
      createdBy ? `Cin7 created by: ${createdBy}` : '',
      reference ? `Reference: ${reference}` : '',
      stage ? `Cin7 status/stage: ${stage}` : ''
    ].filter(Boolean).join('\n'),
    subtotal: null,
    tax: null,
    shipping: null,
    estimated_total: total,
    status,
    source: 'cin7',
    external_source: 'cin7_sales_orders',
    external_id: id || reference || code,
    external_number: displayNumber,
    cin7_order_id: id,
    cin7_order_number: code || displayNumber,
    cin7_ref_number: reference || displayNumber,
    cin7_status: status,
    cin7_stage: stage,
    cin7_reference: reference || displayNumber,
    cin7_customer_name: customerName,
    cin7_customer_email: customerEmail,
    cin7_member_name: memberName,
    cin7_created_by: createdBy,
    imported_from_cin7: true,
    imported_at: new Date().toISOString(),
    cin7_payload: order,
    created_at: createdAt,
    updated_at: updatedAt
  };
}


function cin7CreatedMillisV14(order) {
  const raw = pickFirst(order, [
    'CreatedDate', 'createdDate', 'CreatedAt', 'createdAt', 'Date', 'date',
    'OrderDate', 'orderDate'
  ]);
  const d = new Date(raw || 0);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function cin7RefValueV14(order) {
  const v = cleanText(pickFirst(order, [
    'Ref', 'ref', 'SalesOrderRef', 'salesOrderRef', 'SalesOrderReference', 'salesOrderReference',
    'Reference', 'reference', 'CustomerReference', 'customerReference',
    'CustomerOrderNo', 'customerOrderNo', 'PONumber', 'poNumber', 'PO',
    'Code', 'code'
  ]), 160);
  return v || '';
}

function cin7RefNumericV14(order) {
  const m = String(cin7RefValueV14(order)).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

function sortCin7SalesOrdersLikeCin7V14(items) {
  return (items || []).slice().sort((a, b) => {
    const cd = cin7CreatedMillisV14(b) - cin7CreatedMillisV14(a);
    if (cd !== 0) return cd;
    const rn = cin7RefNumericV14(b) - cin7RefNumericV14(a);
    if (rn !== 0) return rn;
    return String(cin7RefValueV14(b)).localeCompare(String(cin7RefValueV14(a)));
  });
}

async function fetchCin7SalesOrdersForImport({ rows = 175, pages = 2 } = {}) {
  const safeRows = Math.min(Math.max(parseInt(rows, 10) || 100, 1), 250);
  const safePages = Math.min(Math.max(parseInt(pages, 10) || 2, 1), 20);
  const all = [];

  for (let page = 1; page <= safePages; page++) {
    const url = `${CIN7_BASE_URL}/SalesOrders?rows=${safeRows}&page=${page}`;
    const data = await cin7Fetch(url);
    const items = normalizeCin7OrderList(data);

    if (!items.length) break;
    all.push(...items);
    if (items.length < safeRows) break;
    await sleep(350);
  }

  return sortCin7SalesOrdersLikeCin7V14(all);
}

// ─── Import Cin7 Sales Orders into Operations Portal ─────────────────────────

app.post('/api/sync-cin7-orders-to-operations', async (req, res) => {
  try {
    const adminUser = await verifyAdmin(req);
    const token = getAuthToken(req);

    const rows = req.body?.rows || req.query.rows || 175;
    const pages = req.body?.pages || req.query.pages || 2;

    const cin7Orders = await fetchCin7SalesOrdersForImport({ rows, pages });
    const normalized = cin7Orders
      .map(order => normalizeCin7SalesOrderForOperations(order, adminUser))
      .filter(order => order.external_id || order.external_number)
      .sort((a, b) => {
        const ad = new Date(a.created_at || 0).getTime() || 0;
        const bd = new Date(b.created_at || 0).getTime() || 0;
        if (bd !== ad) return bd - ad;
        const ar = String(a.cin7_reference || a.reference || '').match(/(\d+)/);
        const br = String(b.cin7_reference || b.reference || '').match(/(\d+)/);
        return (br ? parseInt(br[1], 10) : -1) - (ar ? parseInt(ar[1], 10) : -1);
      });

    if (!normalized.length) {
      return res.json({
        success: true,
        imported: 0,
        message: 'No Cin7 sales orders found to import.',
        rows,
        pages
      });
    }

    const imported = await supabaseRest(
      'orders?on_conflict=external_source,external_id',
      {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(normalized)
      },
      token
    );

    res.json({
      success: true,
      fetched: cin7Orders.length,
      imported: Array.isArray(imported) ? imported.length : normalized.length,
      source: 'cin7_sales_orders',
      rows,
      pages,
      orders: (Array.isArray(imported) ? imported : normalized).map(o => ({
        id: o.id,
        order_number: o.order_number,
        external_id: o.external_id,
        cin7_order_id: o.cin7_order_id,
        cin7_order_number: o.cin7_order_number,
        cin7_reference: o.cin7_reference,
        reference: o.reference,
        status: o.status
      }))
    });
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
  res.json({ status: 'AALS Cin7 Proxy v11 running ✅', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});


// --- v12 NOTE FOR CIN7 IMPORT ENDPOINT ---
// In the Cin7 import/sync mapping, add these fields to the Supabase upsert payload:
//
// const shipV12 = cin7TrackingInfoV12(cin7Order);
// const mappedStatusV12 = mapCin7StatusV12(shipV12.cin7_status, shipV12.tracking);
//
// payload.tracking = shipV12.tracking || payload.tracking || null;
// payload.tracking_number = shipV12.tracking || payload.tracking_number || null;
// payload.carrier = shipV12.carrier || payload.carrier || null;
// payload.etd = shipV12.etd || payload.etd || null;
// payload.eta = shipV12.eta || payload.eta || null;
// payload.ship_method = shipV12.ship_method || payload.ship_method || null;
// payload.cin7_status = shipV12.cin7_status || payload.cin7_status || null;
// if(mappedStatusV12) payload.status = mappedStatusV12;
//
// This lets Operations sync tracking/carrier/ETA/ETD whenever Cin7 returns those values.


// --- v13 Cin7 reference-number note ---
// AALS Operations should display and track Cin7 Sales Orders by the Cin7 Ref column.
// The import normalization above now prioritizes Ref / Reference / SalesOrderRef over invoice/order number.
// Cin7 quotes that appear in the Sales Orders list as Draft, Quote Approval Pending, or related stages
// are imported through the same SalesOrders sync endpoint and retain their Cin7 Ref.


// --- v14 Cin7 sync behavior note ---
// The sync now requests a safer limited batch by default (175 x 2 pages) and sorts Cin7 imports
// by Created Date and Ref so Operations visually matches the Cin7 Sales Orders list more closely.


// --- v15 Cin7 sync limit note ---
// Sync default is intentionally limited to approximately 350 records
// using 175 rows x 2 pages to avoid Supabase statement timeouts.
