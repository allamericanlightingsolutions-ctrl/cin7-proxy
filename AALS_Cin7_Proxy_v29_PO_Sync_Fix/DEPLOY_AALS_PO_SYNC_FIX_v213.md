# AALS PO synchronization fix — v213 / v29

This update makes two corrections:

- An automatically matched PO is shown inside an order only when its PO date is close to the order date (from 30 days before through 180 days after). An exact link saved by an admin is always preserved.
- The Render proxy retries the Cin7 Purchase Orders request without the `ModifiedDate` filter when Cin7 rejects that filter. The portal now displays the actual HTTP/backend error if synchronization still fails.

The integration remains read-only toward Cin7. It only uses `GET /PurchaseOrders`; it does not create or update any Cin7 record.

## Deployment order

1. In Supabase SQL Editor, run `SUPABASE_FIX_RECENT_PO_MATCHING_v213.sql` and wait for **Success**.
2. Deploy `AALS_Cin7_Proxy_v29_PO_Sync_Fix.zip` to the existing Render service.
3. Confirm that `https://cin7-proxy-rtg8.onrender.com/` says **AALS Cin7 Proxy v29 running**.
4. Deploy `AALS_Operations_v213_Netlify.zip` to the existing Netlify Operations site.
5. Refresh the portal, open **PO Information**, and click **Sync Cin7 POs**.

## Expected result

- A current order no longer shows unrelated POs from 2024.
- The PO panel is absent when no recent or explicitly linked PO exists.
- A successful sync reports the number of refreshed records.
- If the sync fails, the portal shows the backend detail (for example, missing v29 endpoint, admin verification, Cin7 API response, or Supabase save error) instead of only “synchronization failed.”

## Important

Do not use **Run and enable RLS** in Supabase. Run the supplied SQL normally; it creates its own security policies and permissions.
