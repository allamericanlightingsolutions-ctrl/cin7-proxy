# Deploy AALS Operations v212 + Cin7 Proxy v28

Deploy in this order:

1. **Supabase:** run `SUPABASE_ADD_CIN7_PO_READONLY_SYNC_v212.sql` once in the SQL Editor.
2. **Render:** deploy `AALS_Cin7_Proxy_v28_PO_Sync.zip` to the existing `cin7-proxy` service.
3. **Netlify:** deploy `AALS_Operations_v212_Netlify.zip` to the existing Operations site.
4. Sign out and sign back in, open **PO Information**, then select **Sync Cin7 POs**.

## What the sync does

- Reads Purchase Orders from Cin7.
- Adds or refreshes them in Supabase without duplicates.
- Keeps the existing **Add PO Information** option for manual PO records.
- Cross-references POs with Operations orders by AALS/Cin7 reference, WO, Customer Order Number, and SKU/quantity.
- Displays PO number, product/SKU, quantity, status, ordered date, ETD, ETA, and tracking inside the related order.

## What the sync never does

- It does not create, edit, receive, cancel, or delete a PO in Cin7.
- It does not send manual portal PO records to Cin7.
- It does not change an Operations order status automatically.
- It does not expose supplier or cost information to team users.

The portal reads cached PO data from Supabase first, so ordinary page navigation remains fast. An incremental refresh runs only for an authenticated admin and can also be started with the manual button.
