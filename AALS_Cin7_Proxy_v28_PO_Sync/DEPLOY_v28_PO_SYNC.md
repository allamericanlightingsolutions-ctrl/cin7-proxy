# AALS Cin7 Proxy v28 — Purchase Order read-only sync

This version adds a one-way synchronization from Cin7 Purchase Orders to the Operations portal.

## Safety rule

The new integration only uses `GET /api/v1/PurchaseOrders` in Cin7. It does not send POST, PUT, PATCH, or DELETE requests to Cin7 Purchase Orders.

## Deployment order

1. In Supabase SQL Editor, run `SUPABASE_ADD_CIN7_PO_READONLY_SYNC_v212.sql` from the Operations package.
2. In the existing Render `cin7-proxy` service, deploy the files in this package. Keep the current environment variables.
3. Optional: add `CIN7_PO_SYNC_START_DATE` with an ISO date such as `2026-01-01T00:00:00.000Z`. If omitted, that value is the default.
4. Deploy `AALS_Operations_v212_Netlify.zip` to the existing Netlify Operations site.
5. Sign in as an admin, open **PO Information**, and click **Sync Cin7 POs**.

## New endpoints

- `POST /api/sync-cin7-purchase-orders-to-operations`
- `GET /api/cin7-purchase-orders-sync-status`

Both endpoints require an authenticated AALS admin session.

## Expected behavior

- Existing manual PO records remain editable.
- Cin7 PO records are marked `Cin7 · read only`.
- A Cin7 PO refresh updates only Cin7-owned fields and preserves local notes and links.
- Matching uses the Cin7 Customer Order Number, Operations reference, WO, and SKU/quantity fallback.
- The sync never changes an Operations order status automatically.
