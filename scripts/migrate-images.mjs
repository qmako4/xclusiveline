#!/usr/bin/env node
// Migrate XCLUSIVELINE product images from Supabase Storage to Cloudflare R2.
//
// For every row in `product_images` whose url still points at Supabase Storage,
// this script downloads the file, uploads it to R2 under the same key, and
// rewrites the row's `url` to the new R2 public URL.
//
// It is idempotent: rows already pointing at R2_PUBLIC_BASE are skipped, so it
// is safe to re-run if interrupted.
//
// Required env vars:
//   SUPABASE_URL          https://ptucjxjqyvirhumzdggo.supabase.co
//   SUPABASE_SERVICE_KEY  Supabase *service_role* key (needed to update rows)
//   R2_ACCOUNT_ID         Cloudflare account id
//   R2_ACCESS_KEY_ID      R2 API token access key id
//   R2_SECRET_ACCESS_KEY  R2 API token secret
//   R2_BUCKET             e.g. xclusiveline-images
//   R2_PUBLIC_BASE        public base URL for serving, no trailing slash
//
// Usage:
//   cd scripts && npm install && node migrate-images.mjs
//   node migrate-images.mjs --dry-run    # report only, no writes

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE,
} = process.env;

const DRY_RUN = process.argv.includes('--dry-run');

const required = {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('Missing env vars:', missing.join(', '));
  process.exit(1);
}

const PUBLIC_BASE = R2_PUBLIC_BASE.replace(/\/+$/, '');
const STORAGE_MARKER = '/storage/v1/object/public/product-images/';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// Derive the storage key (path within the bucket) from a stored url.
function keyFromUrl(url) {
  const i = url.indexOf(STORAGE_MARKER);
  if (i !== -1) return decodeURIComponent(url.slice(i + STORAGE_MARKER.length));
  // Fallback: last two path segments (productId/filename)
  const parts = url.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

async function fetchAllImages() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/product_images?select=id,url&order=id`,
    { headers: sbHeaders }
  );
  if (!res.ok) throw new Error(`List failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateRowUrl(id, url) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/product_images?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Update ${id} failed: ${res.status} ${await res.text()}`);
}

async function run() {
  const rows = await fetchAllImages();
  console.log(`${rows.length} image rows found${DRY_RUN ? ' (dry run)' : ''}`);

  let migrated = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    if (!row.url || row.url.startsWith(PUBLIC_BASE)) { skipped++; continue; }
    const key = keyFromUrl(row.url);
    try {
      const dl = await fetch(row.url);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      const body = Buffer.from(await dl.arrayBuffer());
      const contentType = dl.headers.get('content-type') || 'image/jpeg';
      const newUrl = `${PUBLIC_BASE}/${key}`;

      if (DRY_RUN) {
        console.log(`would migrate #${row.id}  ${key}  (${body.length} bytes) -> ${newUrl}`);
      } else {
        await s3.send(new PutObjectCommand({
          Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType,
        }));
        await updateRowUrl(row.id, newUrl);
        console.log(`migrated #${row.id}  ${key}`);
      }
      migrated++;
    } catch (e) {
      failed++;
      console.error(`FAILED #${row.id} (${key}): ${e.message}`);
    }
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
