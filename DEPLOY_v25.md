# Deploy AALS Cin7 Proxy v25

The Render service shown in the AALS account is already connected to:

`allamericanlightingsolutions-ctrl/cin7-proxy` → branch `main`

## Replace the files in GitHub

1. Extract `AALS_Cin7_Proxy_v25.zip` on your computer.
2. In Render, open `cin7-proxy` and click the GitHub repository name shown
   beside the GitHub icon.
3. In GitHub, confirm that the selected branch is `main`.
4. Choose **Add file → Upload files**.
5. Drag the contents of the extracted folder into GitHub. Confirm replacing
   `server.js`, `package.json`, and `README.md`, and include the `tests` folder.
6. Enter the commit message: `Fix Cin7 Void sync and duplicate references`.
7. Select **Commit changes**.

Do not upload the ZIP itself as a file inside the repository. Upload its
extracted contents.

## Deploy in Render

Render normally deploys the new `main` commit automatically. If it does not:

1. Return to the `cin7-proxy` service in Render.
2. Choose **Manual Deploy → Deploy latest commit**.
3. Wait until the deploy status is **Live**.

Do not change or remove any Environment variables.

## Verify and reconcile

1. Open the Render service URL. It must show:
   `AALS Cin7 Proxy v25 running`.
2. Sign in to AALS Operations.
3. Run the normal **Sync with Cin7** once.
4. Confirm that `AALS-00008` and `AALS-00009` no longer appear as `New`,
   `Shipped`, or other active work.
5. If the portal is intentionally showing all historical statuses, they may
   remain visible only as `Cancelled`. This preserves the audit trail and does
   not treat them as work to fulfill or invoice.

Future Cin7 Sales Orders with document status `Void` will be excluded from
active import even when their Cin7 Stage remains `New`.
