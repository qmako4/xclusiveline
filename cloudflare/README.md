# Image hosting on Cloudflare R2

Product **image files** are stored in a Cloudflare R2 bucket. Supabase is still
used for authentication and the database (including the `product_images` table,
which holds each image's public URL). Browser uploads from the admin panel go
through a small Cloudflare Worker that verifies the Supabase admin session
before writing to R2.

```
Admin browser ──(image + Supabase token)──> Worker ──checks is_admin──> R2 bucket
Storefront    ──(<img src>)──────────────> R2 public domain
```

## One-time setup

### 1. Create the R2 bucket
```bash
npm install -g wrangler
wrangler login
wrangler r2 bucket create xclusiveline-images
```

### 2. Make images publicly readable
In the Cloudflare dashboard → R2 → `xclusiveline-images` → Settings:
- Enable **Public access** (gives an `https://pub-xxxx.r2.dev` URL), **or**
- Attach a **custom domain** (e.g. `images.xclusiveline.com`).

Copy that URL — it is your `PUBLIC_BASE`.

### 3. Configure and deploy the Worker
Edit `wrangler.toml` and set `PUBLIC_BASE` (and `ALLOWED_ORIGIN` for production),
then:
```bash
cd cloudflare
wrangler deploy
```
Note the deployed Worker URL (e.g. `https://xclusiveline-images.<you>.workers.dev`).

### 4. Point the site at R2
In `../index.html`, set the two constants near the top of the `<script>`:
```js
const R2_UPLOAD_URL  = 'https://xclusiveline-images.<you>.workers.dev';
const R2_PUBLIC_BASE = 'https://pub-xxxx.r2.dev'; // your PUBLIC_BASE, no trailing slash
```

## Migrate existing images

Copies every image currently in Supabase Storage into R2 and rewrites the
`product_images.url` rows. Idempotent and re-runnable.

```bash
cd scripts
npm install

export SUPABASE_URL='https://ptucjxjqyvirhumzdggo.supabase.co'
export SUPABASE_SERVICE_KEY='<service_role key from Supabase dashboard>'
export R2_ACCOUNT_ID='<cloudflare account id>'
export R2_ACCESS_KEY_ID='<R2 API token key id>'
export R2_SECRET_ACCESS_KEY='<R2 API token secret>'
export R2_BUCKET='xclusiveline-images'
export R2_PUBLIC_BASE='https://pub-xxxx.r2.dev'

npm run migrate:dry   # preview what will change
npm run migrate       # do it
```

Generate the R2 API keys under: R2 → **Manage R2 API Tokens** → Object Read & Write.

## Notes / caveats
- The `service_role` key is a **secret** — never commit it or expose it client-side.
  It is only used by the migration script, run locally.
- Deleting a product image removes the DB row but leaves the file in R2 (same
  orphaning behaviour as Supabase Storage had). Cleanup can be added later.
- After migrating and confirming the site loads images from R2, you can disable
  the old Supabase Storage bucket.
