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
