# AALS Cin7 Proxy Server

This proxy connects your website to Cin7 Omni's API.

## Deploy to Render

1. Upload this folder to GitHub (or use Render's direct upload)
2. In Render, create a new **Web Service**
3. Set these Environment Variables:
   - `CIN7_USERNAME` = AllAmericanFacilUS
   - `CIN7_API_KEY` = your-api-key
4. Build Command: `npm install`
5. Start Command: `node server.js`

## API Endpoints

- `GET /` — health check
- `GET /api/products` — all products
- `GET /api/stock` — stock levels
- `GET /api/branches` — store branches
- `GET /api/catalog` — products + stock combined (use this one)

## v26: Work Order / Customer PO synchronization

Catalog v87 sends the required vendor Work Order separately from the internal
AALS order number. The proxy now:

- keeps the AALS/Cin7 reference as the primary order reference;
- writes the vendor Work Order to Cin7 `CustomerOrderNo`;
- includes the Work Order in Catalog confirmation emails;
- reads `CustomerOrderNo`, `Customer PO`, or `WO#` from Cin7 B2B orders;
- copies the Work Order plus available customer and delivery notes into
  Operations notes, including a safe backfill for matching existing records;
- never creates a duplicate merely because a Work Order is present.

## v25: Void orders and duplicate prevention

The Cin7-to-Operations sync now treats the Cin7 document `Status` separately
from its operational `Stage`.

- A Sales Order with `Status: Void` is never inserted as active work, even if
  its `Stage` is still `New`, `Processing`, or another active value.
- During synchronization, existing Operations rows with the same normalized
  reference are changed to `cancelled`.
- References such as `AALS-00009` and `Cin7 Ref #AALS-00009` are treated as the
  same business order, preventing Catalog and Cin7 copies from being inserted
  as separate Operations rows.
- Existing non-Void Operations records are not overwritten.

After deploying v25, run the normal Cin7 sync once. This reconciles existing
Void references such as the test orders and prevents them from returning as
active records in future syncs.

Run the local validation with:

```bash
npm test
```
