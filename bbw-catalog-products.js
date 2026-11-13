'use strict';

const table = 'bbw_catalog_products';
const fields = 'sku,product';
const skuKey = value => String(value || '').trim().toUpperCase();

function list(result, key) {
  return Array.isArray(result) ? result : Array.isArray(result?.[key]) ? result[key] : [];
}

function install(app, { verifyCatalogUser, verifyAdmin, supabaseRest, serviceKey, cin7Fetch, baseUrl, normalizeCin7Product }) {
  function database(path, options = {}) {
    if (!serviceKey) throw new Error('Catalog storage is unavailable.');
    return supabaseRest(path, {
      ...options,
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, ...options.headers },
      signal: AbortSignal.timeout(10000)
    });
  }

  app.get('/api/bbw/catalog-products', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await verifyCatalogUser(req); }
    catch { return res.status(401).json({ error: 'Please sign in to the catalog.' }); }
    try {
      const products = [];
      for (let offset = 0; ; offset += 500) {
        const rows = await database(table + '?select=' + fields + '&order=sku&limit=500&offset=' + offset);
        if (!Array.isArray(rows)) throw new Error('Invalid saved catalog data');
        products.push(...rows);
        if (rows.length < 500) break;
      }
      return res.json({ products });
    } catch (error) {
      console.warn('BBW catalog products read failed:', error.message);
      return res.status(503).json({ error: 'Saved catalog additions are temporarily unavailable.' });
    }
  });

  app.post('/api/bbw/catalog-products', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await verifyAdmin(req, { staticOnly: true }); }
    catch { return res.status(403).json({ error: 'An authorized BBW administrator is required.' }); }
    const sku = skuKey(req.body?.sku);
    if (!sku || sku.length > 80 || /[\u0000-\u001f\u007f]/.test(sku) || sku === '07-WPTSR-3CCT') {
      return res.status(400).json({ error: 'Enter a valid Cin7 SKU for the BBW catalog.' });
    }
    try {
      const query = new URLSearchParams({ rows: '10', where: "ProductOptionCode='" + sku.replace(/'/g, "''") + "'" });
      const response = await cin7Fetch(baseUrl + '/ProductOptions?' + query);
      const matches = list(response, 'ProductOptions').filter(row => skuKey(row.productOptionCode ?? row.ProductOptionCode ?? row.code ?? row.Code) === sku);
      if (!matches.length) return res.status(404).json({ error: 'No exact Cin7 product option matched that SKU.' });
      const ids = [...new Set(matches.map(row => Number(row.productId ?? row.ProductId)))];
      if (ids.length !== 1 || !Number.isSafeInteger(ids[0]) || ids[0] < 1 || matches.length !== 1) {
        return res.status(409).json({ error: 'This SKU is ambiguous in Cin7. Check the product option code.' });
      }
      const raw = await cin7Fetch(baseUrl + '/Products/' + ids[0]);
      const item = normalizeCin7Product(raw);
      if (!item.name || Number(item.id) !== ids[0]) throw new Error('Cin7 returned an incomplete product.');
      const { brand, category, barcode, supplierCode, styleCode, uom, weight, length, width, height } = item.specs;
      const { option1, option2, option3 } = matches[0];
      const variant = [option1 ?? matches[0].Option1, option2 ?? matches[0].Option2, option3 ?? matches[0].Option3].filter(Boolean).join(' / ');
      const product = {
        code: sku, name: [item.name, variant].filter(Boolean).join(' · '),
        description: item.description, pdfDescription: item.pdfDescription, image: item.image,
        specs: { brand, category, barcode, supplierCode, styleCode, uom, weight, length, width, height }
      };
      const rows = await database(table + '?on_conflict=sku&select=' + fields, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ sku, product, updated_at: new Date().toISOString() })
      });
      if (rows?.[0]?.sku !== sku) throw new Error('Catalog storage did not confirm the update.');
      return res.json(rows[0]);
    } catch (error) {
      if (Number.isFinite(error.retryAfterSeconds)) {
        res.set('Retry-After', String(error.retryAfterSeconds));
        return res.status(429).json({ error: 'Cin7 is limiting requests. Please try again later.' });
      }
      console.warn('BBW catalog product sync failed:', error.message);
      return res.status(503).json({ error: 'The product could not be synchronized. Please try again.' });
    }
  });
}

module.exports = { install };
