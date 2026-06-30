# XCLUSIVELINE — setup checklist

Your new store is **static frontend on GitHub Pages** + **Cloudflare backend** (Worker API + D1 database + R2 images). No Supabase.

```
index.html            → the storefront (host on GitHub Pages)
data/products-seed.json → your old products (used once by the migration)
cloudflare/
  schema.sql          → database tables
  src/worker.js       → the whole API
  wrangler.toml       → Worker config
```

You already did: created the R2 bucket, enabled its public URL, created the Worker
`xclusiveline-images` and added the `BUCKET` binding + variables. The steps below
finish the job. They need the **Wrangler CLI** (one terminal session) — it's the
only reliable way to create the database and load the schema.

---

## 1. Install Wrangler & log in
```bash
npm install -g wrangler
wrangler login
```

## 2. Create the database
```bash
cd cloudflare
wrangler d1 create xclusiveline
```
Copy the `database_id` it prints into `cloudflare/wrangler.toml` (replace
`REPLACE-WITH-YOUR-D1-DATABASE-ID`).

## 3. Create the tables
```bash
wrangler d1 execute xclusiveline --remote --file=./schema.sql
```

## 4. Set the secrets
```bash
wrangler secret put JWT_SECRET          # paste any long random string (e.g. 40+ chars)
wrangler secret put PAYPAL_CLIENT_ID    # from developer.paypal.com → your app
wrangler secret put PAYPAL_SECRET       # from the same PayPal app
```
While testing, leave `PAYPAL_ENV = "sandbox"` in `wrangler.toml` and use PayPal
**sandbox** credentials. Switch to `"live"` + live credentials when ready for real money.

## 5. Deploy the Worker
```bash
wrangler deploy
```
This re-deploys the full API (auth, wallet, orders, admin) with the D1 + R2 bindings.

## 6. Put the site on GitHub Pages
- Push this repo to GitHub (branch `main`).
- Repo → **Settings → Pages** → Source: **Deploy from a branch** → `main` / root → Save.
- Your store goes live at `https://<your-username>.github.io/xclusiveline/`.
- Then lock down CORS: set `ALLOWED_ORIGIN` in `wrangler.toml` to that exact origin
  (e.g. `https://qmako4.github.io`) and run `wrangler deploy` again.

## 7. Create your admin account
- Open the live site → **Register**. **The first account that registers becomes the admin** automatically.
- Use that account → **Admin** appears in the menu.

## 8. Import your old products (one click)
- Admin panel → **Migrate** tab → **Import old products & images**.
- This pulls your 8 products + their images from the old Supabase storage straight
  into R2 and the new database. Runs once; safe to re-run.

Done — you're fully off Supabase. 🎉

---

## Photo Studio
- Admin panel has a **Photo Studio** link to `admin/photo-studio/`.
- Live URL after GitHub Pages deploys:
  `https://qmako4.github.io/xclusiveline/admin/photo-studio/`
- The photo studio uses its own Worker and R2 bucket so it does not affect the
  main store Worker. Follow `PHOTO_STUDIO_SETUP.md`.

---

## Notes
- **Config in `index.html`** (top of the `<script>`): `API` is your Worker URL,
  `PAYPAL_CLIENT_ID` is your public PayPal client id. Update if they change.
- **Security:** balances and prices are enforced server-side; PayPal top-ups are
  verified server-side before any credit is added (the old store didn't do this).
- **Old users:** the 21 Supabase accounts don't carry over (passwords can't be
  exported). They re-register. There were 0 top-ups and 1 order, so nothing of value is lost.
- **Old store:** the previous Supabase `index.html` is preserved in git history if
  you ever need it.
