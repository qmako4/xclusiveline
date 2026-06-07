# Cloudflare backend

This folder is the entire backend for XCLUSIVELINE (no Supabase):

- `schema.sql` — D1 database tables (users, products, orders, wallet, etc.)
- `src/worker.js` — the API Worker (auth, catalog, wallet/PayPal, checkout, admin, one-time migration)
- `wrangler.toml` — Worker config (R2 + D1 bindings, vars)

**Full step-by-step setup is in [`../SETUP.md`](../SETUP.md).**

Quick reference:
```bash
wrangler d1 create xclusiveline                                  # then paste id into wrangler.toml
wrangler d1 execute xclusiveline --remote --file=./schema.sql    # create tables
wrangler secret put JWT_SECRET                                   # + PAYPAL_CLIENT_ID, PAYPAL_SECRET
wrangler deploy
```
