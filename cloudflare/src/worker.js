// XCLUSIVELINE — R2 image upload Worker
//
// Bridges browser uploads from the admin panel to a Cloudflare R2 bucket.
// The browser cannot hold R2 credentials, so it sends the image plus the
// logged-in user's Supabase access token here. This Worker verifies the
// session against Supabase and confirms the user is an admin (profiles.is_admin)
// before writing the object to R2 — mirroring the previous Supabase Storage rules.
//
// Bindings / vars (see wrangler.toml):
//   BUCKET            R2 bucket binding
//   SUPABASE_URL      e.g. https://ptucjxjqyvirhumzdggo.supabase.co
//   SUPABASE_ANON_KEY Supabase anon key (used as apikey header)
//   PUBLIC_BASE       Public base URL for serving images (R2 public/custom domain)
//   ALLOWED_ORIGIN    CORS origin, e.g. https://qmako4.github.io (use * for testing)

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB safety cap

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, x-file-path',
      'Access-Control-Max-Age': '86400',
    };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

    // ── Authn: validate the Supabase session ──
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Missing token' }, 401, cors);

    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Invalid session' }, 401, cors);
    const user = await userRes.json();
    if (!user?.id) return json({ error: 'Invalid session' }, 401, cors);

    // ── Authz: must be an admin ──
    const profRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin`,
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
    );
    const profs = await profRes.json().catch(() => []);
    if (!profs?.[0]?.is_admin) return json({ error: 'Not authorized' }, 403, cors);

    // ── Validate the destination path ──
    const path = (req.headers.get('x-file-path') || '').replace(/^\/+/, '');
    if (!path || path.includes('..') || !/^[\w./-]+$/.test(path)) {
      return json({ error: 'Bad file path' }, 400, cors);
    }

    // ── Read + store the object ──
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: 'Empty body' }, 400, cors);
    if (buf.byteLength > MAX_BYTES) return json({ error: 'File too large' }, 413, cors);

    const contentType = req.headers.get('content-type') || 'image/jpeg';
    await env.BUCKET.put(path, buf, { httpMetadata: { contentType } });

    const base = (env.PUBLIC_BASE || '').replace(/\/+$/, '');
    return json({ url: `${base}/${path}` }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}
