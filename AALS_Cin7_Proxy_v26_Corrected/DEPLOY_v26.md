# Deploy AALS Cin7 Proxy v26

The Render service is connected to:

`allamericanlightingsolutions-ctrl/cin7-proxy` → branch `main`

## Replace the files in GitHub

1. Extract `AALS_Cin7_Proxy_v26.zip` on your computer.
2. Open the GitHub repository linked from the Render `cin7-proxy` service.
3. Confirm that the selected branch is `main`.
4. Choose **Add file → Upload files**.
5. Upload the extracted contents, replacing `server.js`, `package.json`, and
   `README.md`, and include `tests` and `DEPLOY_v26.md`.
6. Commit with: `Sync Work Order and B2B notes to Operations`.

Do not upload the ZIP itself into the repository. Upload the extracted files.
Do not change or remove any Render Environment variables.

## Deploy and verify

1. Render should deploy the new `main` commit automatically. Otherwise choose
   **Manual Deploy → Deploy latest commit**.
2. Open the Render service URL and confirm it says
   `AALS Cin7 Proxy v26 running`.
3. Publish `AALS_Catalog_v87_Netlify.zip` in Netlify.
4. Submit one Catalog test order with a WO#.
5. Confirm the WO# appears as the Cin7 Customer Order / PO number and in the
   confirmation email.
6. Run **Sync Cin7 Orders** in Operations.
7. Confirm the same WO# is searchable and appears in the order notes.

For native Cin7 B2B orders, the proxy reads the Customer PO / Customer Order
Number provided during B2B checkout. If that field is empty in Cin7, the proxy
cannot invent a WO#; it will still import the Cin7 reference normally.
