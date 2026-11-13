'use strict';

const stores = require('./tapestry-store-directory.json');
const MINIMUM_CENTS = 2499;
const standardServices = /^(ups_ground|ups_ground_saver|fedex_ground|fedex_home_delivery|usps_ground_advantage(?:_package)?|ups_standard)$/i;
const standardNames = /^(?:UPS Ground(?: Saver)?|FedEx Ground|FedEx Home Delivery|USPS Ground Advantage(?: - Package)?|UPS Standard)$/i;

function standardRate(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap(rate => {
    if (!rate) return [];
    const name = String(rate.serviceName || '').replace(/[®™]/g, '').trim();
    if (!standardServices.test(rate.serviceCode || '') && !standardNames.test(name)) return [];
    const cost = Number(rate.shipmentCost);
    const other = Number(rate.otherCost ?? 0);
    return rate.shipmentCost != null && Number.isFinite(cost) && cost > 0 && Number.isFinite(other) && other >= 0
      ? [{ cents: Math.round(cost * 100) + Math.round(other * 100), service: name || rate.serviceCode }] : [];
  }).sort((a, b) => a.cents - b.cents)[0];
}

function install(app, { fetch, verifyCatalogUser }) {
  app.post('/api/tapestry/shipping-estimate', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await verifyCatalogUser(req);
    } catch {
      return res.status(401).json({ status: 'unavailable' });
    }

    const { storeNumber, packages } = req.body || {};
    const store = typeof storeNumber === 'string' && Object.hasOwn(stores, storeNumber) ? stores[storeNumber] : null;
    const manual = () => res.json({ status: 'manual' });
    if (!store || !['US', 'CA'].includes(store.co) || !store.z || !store.sa || !store.ca ||
        !Array.isArray(packages) || !packages.length || packages.length > 50) return manual();
    if (packages.some(box => !box || !Number.isSafeInteger(box.quantity) || box.quantity < 1 || box.quantity > 500 || !['weightLbs','lengthIn','widthIn','heightIn'].every(
      key => typeof box[key] === 'number' && Number.isFinite(box[key]) && box[key] > 0 && box[key] <= 100
    )) || packages.reduce((sum, box) => sum + box.weightLbs * box.quantity, 0) > 100) return manual();

    const { SS_KEY, SS_SECRET } = process.env;
    if (!SS_KEY || !SS_SECRET) return res.status(503).json({ status: 'unavailable' });
    const headers = { Authorization: 'Basic ' + Buffer.from(SS_KEY + ':' + SS_SECRET).toString('base64'), 'Content-Type': 'application/json' };
    const signal = AbortSignal.timeout(10000);
    async function shipStation(path, body) {
      const response = await fetch('https://ssapi.shipstation.com/' + path, {
        headers, signal, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
      });
      if (!response.ok) throw new Error('ShipStation rates unavailable');
      return response.json();
    }
    try {
      const carriers = await shipStation('carriers');
      if (!Array.isArray(carriers)) throw new Error('Invalid carrier response');
      const codes = [...new Set(carriers.map(carrier => carrier?.code).filter(code => /^(ups|fedex|stamps_com|usps|endicia)(?:$|_)/i.test(code || '')))].slice(0, 8);
      if (!codes.length) return manual();
      async function quotePackage(box) {
        const results = await Promise.allSettled(codes.map(carrierCode => shipStation('shipments/getrates', {
          carrierCode, fromPostalCode: '33325', toPostalCode: store.z, toCountry: store.co,
          toState: store.sa, toCity: store.ca, residential: false,
          weight: { value: box.weightLbs, units: 'pounds' },
          dimensions: { units: 'inches', length: box.lengthIn, width: box.widthIn, height: box.heightIn }
        })));
        const eligible = standardRate(results.flatMap(result => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []));
        if (!eligible && results.every(result => result.status === 'rejected')) throw new Error('All carrier requests failed');
        return eligible;
      }
      const rates = [];
      // Limit concurrent carrier requests as the number of distinct parcels grows.
      for (let i = 0; i < packages.length; i += 3) {
        rates.push(...await Promise.all(packages.slice(i, i + 3).map(quotePackage)));
      }
      if (rates.some(rate => !rate)) return manual();
      const cents = rates.reduce((sum, rate, index) => sum + rate.cents * packages[index].quantity, 0);
      return res.json({ status: 'estimated', amount: Math.max(MINIMUM_CENTS, cents) / 100, currency: 'USD',
        service: [...new Set(rates.map(rate => rate.service))].join(' / ') });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });
}
module.exports = { install };
