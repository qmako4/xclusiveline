# XCLUSIVELINE Photo Studio Setup

This is separate from the main store Worker. The GitHub Pages admin page is:

```text
https://qmako4.github.io/xclusiveline/admin/photo-studio/
```

GitHub Pages is static, so OpenAI and R2 secrets must stay in the separate
Cloudflare Worker in `cloudflare-photo-studio/`.

## What Was Added

```text
admin/photo-studio/index.html        Static admin photo studio page
assets/xclusiveline-studio-background.png
cloudflare-photo-studio/             Separate Worker, R2 binding, env example
```

The studio does not auto-generate when files are uploaded. It only generates
after you press **Generate Images**, then saves only selected generated images to R2.

## Required Cloudflare Resources

Create one R2 bucket for generated XCLUSIVELINE studio images:

```bash
cd cloudflare-photo-studio
wrangler r2 bucket create xclusiveline-media
```

Optional preview bucket for local Wrangler preview:

```bash
wrangler r2 bucket create xclusiveline-media-preview
```

The Worker binding is already set in `cloudflare-photo-studio/wrangler.toml`:

```toml
[[r2_buckets]]
binding = "XCLUSIVELINE_MEDIA"
bucket_name = "xclusiveline-media"
preview_bucket_name = "xclusiveline-media-preview"
```

## Required Secrets

Set these with Wrangler:

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put XCLUSIVELINE_STUDIO_ADMIN_TOKEN
```

Use any long private random value for `XCLUSIVELINE_STUDIO_ADMIN_TOKEN`. Paste
that same token into the collapsed Studio setup section on the admin page.

You can use `XCLUSIVELINE_OPENAI_API_KEY` instead of `OPENAI_API_KEY` if you
prefer business-specific naming:

```bash
wrangler secret put XCLUSIVELINE_OPENAI_API_KEY
```

## Worker Vars

These are already in `cloudflare-photo-studio/wrangler.toml`:

```toml
[vars]
XCLUSIVELINE_OPENAI_IMAGE_MODEL = "gpt-image-2"
XCLUSIVELINE_IMAGE_SIZE = "1200x1600"
XCLUSIVELINE_MAX_BULK_IMAGES = "8"
XCLUSIVELINE_R2_PREFIX = "photo-studio/"
XCLUSIVELINE_ALLOWED_ORIGINS = "http://localhost:8787,http://localhost:3000,http://127.0.0.1:3000,http://127.0.0.1:8080,https://qmako4.github.io"
XCLUSIVELINE_BACKGROUND_URL = "https://qmako4.github.io/xclusiveline/assets/xclusiveline-studio-background.png"
```

Optional public media URL if you enable a public/custom domain for the R2 bucket:

```toml
XCLUSIVELINE_R2_PUBLIC_URL = "https://your-public-r2-domain.example.com"
```

If you do not set `XCLUSIVELINE_R2_PUBLIC_URL`, the admin page still loads
saved images through the Worker using your admin token.

## Deploy

```bash
cd cloudflare-photo-studio
wrangler deploy
```

After deploy, copy the Worker URL, for example:

```text
https://xclusiveline-photo-studio.<your-account>.workers.dev
```

Open the admin page, expand **Studio setup**, then paste the Worker URL and
admin token. The page saves those settings automatically.

## Local Test

```bash
cd cloudflare-photo-studio
copy .dev.vars.example .dev.vars
wrangler dev
```

Then open the GitHub Pages site locally or live and use this Worker URL:

```text
http://127.0.0.1:8787
```

## Important Separation

- Main store Worker: `cloudflare/`
- Photo Studio Worker: `cloudflare-photo-studio/`
- Main store R2 binding: `BUCKET`
- Photo Studio R2 binding: `XCLUSIVELINE_MEDIA`

Do not put OpenAI keys in `index.html`, GitHub Pages settings, or frontend
JavaScript. Keep them only as Cloudflare Worker secrets.
