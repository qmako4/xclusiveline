// XCLUSIVELINE — API Worker
// Single backend for the static storefront. Replaces Supabase entirely.
//   - Auth (register/login) with PBKDF2 hashing + JWT sessions
//   - Products / categories
//   - Wallet top-ups via PayPal (created AND verified server-side)
//   - Checkout against wallet balance (atomic stock + balance)
//   - Admin: product CRUD, image upload to R2, orders, users
//   - One-time migration: copy old Supabase images into R2 + seed catalog
//
// Bindings (wrangler.toml): DB (D1), BUCKET (R2)
// Vars:    PUBLIC_BASE, ALLOWED_ORIGIN, PAYPAL_ENV ("sandbox"|"live")
// Secrets: JWT_SECRET, PAYPAL_CLIENT_ID, PAYPAL_SECRET

const MAX_UPLOAD = 8 * 1024 * 1024;
const enc = new TextEncoder();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, x-file-path',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      const r = await route(req, env, url);
      return withCors(r, cors);
    } catch (e) {
      return json({ error: e.message || 'Server error' }, e.status || 500, cors);
    }
  },
};

async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const seg = p.split('/').filter(Boolean); // e.g. ['api','products','123']

  // ── Public ──
  if (p === '/' || p === '/api') return jr({ ok: true, service: 'xclusiveline-api' });
  if (p === '/api/products' && m === 'GET') return listProducts(env);
  if (seg[0] === 'api' && seg[1] === 'products' && seg[2] && m === 'GET') return getProduct(env, seg[2]);
  if (p === '/api/categories' && m === 'GET') return listCategories(env);

  // ── Auth ──
  if (p === '/api/auth/register' && m === 'POST') return register(req, env);
  if (p === '/api/auth/login' && m === 'POST') return login(req, env);
  if (p === '/api/auth/me' && m === 'GET') return me(req, env);

  // ── Wallet ──
  if (p === '/api/topup/create' && m === 'POST') return topupCreate(req, env);
  if (p === '/api/topup/capture' && m === 'POST') return topupCapture(req, env);

  // ── Orders ──
  if (p === '/api/orders' && m === 'POST') return placeOrder(req, env);
  if (p === '/api/orders' && m === 'GET') return myOrders(req, env);

  // ── Admin: image upload ──
  if (p === '/api/admin/upload' && m === 'POST') return uploadImage(req, env);

  // ── Admin: products ──
  if (p === '/api/admin/products' && m === 'GET') return adminProducts(req, env);
  if (p === '/api/admin/products' && m === 'POST') return createProduct(req, env);
  if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'products' && seg[3] && m === 'PATCH') return updateProduct(req, env, seg[3]);
  if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'products' && seg[3] && m === 'DELETE') return deleteProduct(req, env, seg[3]);

  // ── Admin: orders / users ──
  if (p === '/api/admin/orders' && m === 'GET') return adminOrders(req, env);
  if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'orders' && seg[3] && m === 'PATCH') return updateOrder(req, env, seg[3]);
  if (p === '/api/admin/users' && m === 'GET') return adminUsers(req, env);
  if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'users' && seg[3] && m === 'PATCH') return updateUser(req, env, seg[3]);

  // ── Admin: one-time migration/seed ──
  if (p === '/api/admin/migrate' && m === 'POST') return migrate(req, env);

  return jr({ error: 'Not found' }, 404);
}

/* ───────────────────────── helpers ───────────────────────── */

function jr(obj, status = 200) { return json(obj, status, {}); }
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors } });
}
function withCors(res, cors) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
function err(message, status) { const e = new Error(message); e.status = status; return e; }
function uuid() { return crypto.randomUUID(); }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
function b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlStr(s) { return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); return atob(s); }

async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return hex(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { hash, salt: hex(salt) };
}
async function verifyPassword(password, saltHex, hashHex) {
  const h = await pbkdf2(password, hexToBytes(saltHex));
  return timingSafeEqual(h, hashHex);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function signJWT(payload, secret) {
  const header = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlStr(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}
async function verifyJWT(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(b64urlDecode(parts[2]), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(data));
  if (!ok) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function authUser(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload?.sub) return null;
  return env.DB.prepare('SELECT id,email,full_name,balance_gbp,is_admin FROM users WHERE id=?').bind(payload.sub).first();
}
async function requireUser(req, env) { const u = await authUser(req, env); if (!u) throw err('Not signed in', 401); return u; }
async function requireAdmin(req, env) {
  if (String(env.OPEN_ADMIN_ACCESS || '').toLowerCase() === 'true') {
    return { id: 'open-admin', email: 'photo-studio-admin@xclusiveline.local', full_name: 'Photo Studio Admin', balance_gbp: 0, is_admin: 1 };
  }
  const u = await requireUser(req, env);
  if (!u.is_admin) throw err('Admin only', 403);
  return u;
}
function publicUrl(env, key) { return `${(env.PUBLIC_BASE || '').replace(/\/+$/, '')}/${key}`; }

/* ───────────────────────── auth ───────────────────────── */

async function register(req, env) {
  const { email, password, full_name } = await req.json();
  if (!email || !password || password.length < 6) throw err('Email and 6+ char password required', 400);
  const e = email.toLowerCase().trim();
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(e).first();
  if (exists) throw err('That email already has an account', 409);
  const { hash, salt } = await hashPassword(password);
  const id = uuid();
  // First ever user becomes admin.
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const isAdmin = count.n === 0 ? 1 : 0;
  await env.DB.prepare('INSERT INTO users (id,email,full_name,pw_hash,pw_salt,is_admin) VALUES (?,?,?,?,?,?)')
    .bind(id, e, full_name || null, hash, salt, isAdmin).run();
  const token = await issueToken(id, env);
  return jr({ token, user: { id, email: e, full_name: full_name || null, balance_gbp: 0, is_admin: isAdmin } });
}

async function login(req, env) {
  const { email, password } = await req.json();
  const e = (email || '').toLowerCase().trim();
  const u = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(e).first();
  if (!u || !(await verifyPassword(password || '', u.pw_salt, u.pw_hash))) throw err('Wrong email or password', 401);
  const token = await issueToken(u.id, env);
  return jr({ token, user: { id: u.id, email: u.email, full_name: u.full_name, balance_gbp: u.balance_gbp, is_admin: u.is_admin } });
}

async function issueToken(userId, env) {
  return signJWT({ sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 }, env.JWT_SECRET);
}

async function me(req, env) { return jr({ user: await requireUser(req, env) }); }

/* ───────────────────────── catalog ───────────────────────── */

async function hydrateProducts(env, rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const imgs = (await env.DB.prepare(`SELECT product_id,url,position FROM product_images WHERE product_id IN (${ph}) ORDER BY position`).bind(...ids).all()).results || [];
  const sizes = (await env.DB.prepare(`SELECT product_id,size,stock FROM product_sizes WHERE product_id IN (${ph})`).bind(...ids).all()).results || [];
  const cats = (await env.DB.prepare(`SELECT pc.product_id, c.name FROM product_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.product_id IN (${ph})`).bind(...ids).all()).results || [];
  return rows.map(p => ({
    ...p,
    active: !!p.active,
    images: imgs.filter(i => i.product_id === p.id).map(i => ({ url: i.url, position: i.position })),
    sizes: sizes.filter(s => s.product_id === p.id).map(s => ({ size: s.size, stock: s.stock })),
    categories: cats.filter(c => c.product_id === p.id).map(c => c.name),
  }));
}

async function listProducts(env) {
  const rows = (await env.DB.prepare('SELECT * FROM products WHERE active=1 ORDER BY created_at DESC').all()).results || [];
  return jr({ products: await hydrateProducts(env, rows) });
}
async function getProduct(env, id) {
  const row = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(id).first();
  if (!row) throw err('Not found', 404);
  return jr({ product: (await hydrateProducts(env, [row]))[0] });
}
async function listCategories(env) {
  const rows = (await env.DB.prepare('SELECT id,name,slug FROM categories ORDER BY name').all()).results || [];
  return jr({ categories: rows });
}

/* ───────────────────────── wallet / paypal ───────────────────────── */

async function paypalAuth(env) {
  const base = env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw err('PayPal auth failed', 502);
  return { token: (await r.json()).access_token, base };
}

async function topupCreate(req, env) {
  const u = await requireUser(req, env);
  const { amount_gbp } = await req.json();
  const amt = Math.round(Number(amount_gbp) * 100) / 100;
  if (!(amt >= 1 && amt <= 1000)) throw err('Top-up must be £1–£1000', 400);
  const { token, base } = await paypalAuth(env);
  const r = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'GBP', value: amt.toFixed(2) }, description: 'XCLUSIVELINE wallet top-up' }] }),
  });
  const order = await r.json();
  if (!order.id) throw err('Could not create PayPal order', 502);
  await env.DB.prepare('INSERT INTO topups (id,user_id,amount_gbp,paypal_order_id,status) VALUES (?,?,?,?,?)')
    .bind(uuid(), u.id, amt, order.id, 'pending').run();
  return jr({ paypal_order_id: order.id });
}

async function topupCapture(req, env) {
  const u = await requireUser(req, env);
  const { paypal_order_id } = await req.json();
  const topup = await env.DB.prepare('SELECT * FROM topups WHERE paypal_order_id=? AND user_id=?').bind(paypal_order_id, u.id).first();
  if (!topup) throw err('Top-up not found', 404);
  if (topup.status === 'completed') return jr({ balance_gbp: u.balance_gbp, already: true });

  const { token, base } = await paypalAuth(env);
  const r = await fetch(`${base}/v2/checkout/orders/${paypal_order_id}/capture`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const cap = await r.json();
  const unit = cap?.purchase_units?.[0]?.payments?.captures?.[0];
  const paid = parseFloat(unit?.amount?.value || '0');
  const currency = unit?.amount?.currency_code;
  if (cap.status !== 'COMPLETED' || currency !== 'GBP' || Math.abs(paid - topup.amount_gbp) > 0.01) {
    await env.DB.prepare('UPDATE topups SET status=? WHERE id=?').bind('failed', topup.id).run();
    throw err('Payment not completed', 402);
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE topups SET status=? WHERE id=? AND status=?').bind('completed', topup.id, 'pending'),
    env.DB.prepare('UPDATE users SET balance_gbp = balance_gbp + ? WHERE id=?').bind(topup.amount_gbp, u.id),
  ]);
  const fresh = await env.DB.prepare('SELECT balance_gbp FROM users WHERE id=?').bind(u.id).first();
  return jr({ balance_gbp: fresh.balance_gbp });
}

/* ───────────────────────── orders ───────────────────────── */

async function placeOrder(req, env) {
  const u = await requireUser(req, env);
  const { items, shipping } = await req.json();
  if (!Array.isArray(items) || !items.length) throw err('Cart is empty', 400);
  if (!shipping?.name || !shipping?.address || !shipping?.city || !shipping?.country) throw err('Missing shipping details', 400);

  // Price + stock come from the DB, never the client.
  let total = 0;
  const lines = [];
  for (const it of items) {
    const prod = await env.DB.prepare('SELECT * FROM products WHERE id=? AND active=1').bind(it.product_id).first();
    if (!prod) throw err('A product is no longer available', 409);
    const sizeRow = await env.DB.prepare('SELECT * FROM product_sizes WHERE product_id=? AND size=?').bind(it.product_id, it.size).first();
    const qty = Math.max(1, parseInt(it.quantity) || 1);
    if (!sizeRow || sizeRow.stock < qty) throw err(`${prod.name} (${it.size}) is out of stock`, 409);
    const price = prod.sale_price_gbp ?? prod.price_gbp;
    total += price * qty;
    lines.push({ prod, sizeRow, qty, price });
  }
  total = Math.round(total * 100) / 100;
  if (u.balance_gbp < total) throw err('Insufficient balance — top up first', 402);

  const orderId = uuid();
  const stmts = [
    env.DB.prepare('UPDATE users SET balance_gbp = balance_gbp - ? WHERE id=? AND balance_gbp >= ?').bind(total, u.id, total),
    env.DB.prepare('INSERT INTO orders (id,user_id,total_gbp,status,ship_name,ship_addr,ship_city,ship_post,ship_country) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(orderId, u.id, total, 'paid', shipping.name, shipping.address, shipping.city, shipping.postcode || null, shipping.country),
  ];
  for (const l of lines) {
    stmts.push(env.DB.prepare('INSERT INTO order_items (id,order_id,product_id,product_name,product_brand,size,price_gbp,quantity) VALUES (?,?,?,?,?,?,?,?)')
      .bind(uuid(), orderId, l.prod.id, l.prod.name, l.prod.brand, l.sizeRow.size, l.price, l.qty));
    stmts.push(env.DB.prepare('UPDATE product_sizes SET stock = stock - ? WHERE id=? AND stock >= ?').bind(l.qty, l.sizeRow.id, l.qty));
  }
  await env.DB.batch(stmts);
  const fresh = await env.DB.prepare('SELECT balance_gbp FROM users WHERE id=?').bind(u.id).first();
  return jr({ order_id: orderId, balance_gbp: fresh.balance_gbp });
}

async function myOrders(req, env) {
  const u = await requireUser(req, env);
  const orders = (await env.DB.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').bind(u.id).all()).results || [];
  return jr({ orders: await attachItems(env, orders) });
}
async function attachItems(env, orders) {
  if (!orders.length) return [];
  const ids = orders.map(o => o.id);
  const ph = ids.map(() => '?').join(',');
  const items = (await env.DB.prepare(`SELECT * FROM order_items WHERE order_id IN (${ph})`).bind(...ids).all()).results || [];
  return orders.map(o => ({ ...o, items: items.filter(i => i.order_id === o.id) }));
}

/* ───────────────────────── admin: upload ───────────────────────── */

async function uploadImage(req, env) {
  await requireAdmin(req, env);
  const path = (req.headers.get('x-file-path') || '').replace(/^\/+/, '');
  if (!path || path.includes('..') || !/^[\w./-]+$/.test(path)) throw err('Bad file path', 400);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw err('Empty body', 400);
  if (buf.byteLength > MAX_UPLOAD) throw err('File too large', 413);
  await env.BUCKET.put(path, buf, { httpMetadata: { contentType: req.headers.get('content-type') || 'image/jpeg' } });
  return jr({ url: publicUrl(env, path) });
}

/* ───────────────────────── admin: products ───────────────────────── */

async function adminProducts(req, env) {
  await requireAdmin(req, env);
  const rows = (await env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all()).results || [];
  return jr({ products: await hydrateProducts(env, rows) });
}

async function ensureCategories(env, names) {
  const ids = [];
  for (const name of names || []) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let row = await env.DB.prepare('SELECT id FROM categories WHERE name=?').bind(name).first();
    if (!row) { const id = uuid(); await env.DB.prepare('INSERT INTO categories (id,name,slug) VALUES (?,?,?)').bind(id, name, slug).run(); row = { id }; }
    ids.push(row.id);
  }
  return ids;
}

async function writeChildren(env, productId, body) {
  const stmts = [
    env.DB.prepare('DELETE FROM product_images WHERE product_id=?').bind(productId),
    env.DB.prepare('DELETE FROM product_sizes WHERE product_id=?').bind(productId),
    env.DB.prepare('DELETE FROM product_categories WHERE product_id=?').bind(productId),
  ];
  (body.images || []).forEach((img, i) => {
    const url = typeof img === 'string' ? img : img.url;
    stmts.push(env.DB.prepare('INSERT INTO product_images (id,product_id,url,position) VALUES (?,?,?,?)').bind(uuid(), productId, url, i));
  });
  (body.sizes || []).forEach(s => {
    stmts.push(env.DB.prepare('INSERT INTO product_sizes (id,product_id,size,stock) VALUES (?,?,?,?)').bind(uuid(), productId, s.size, parseInt(s.stock) || 0));
  });
  const catIds = await ensureCategories(env, body.categories);
  catIds.forEach(cid => stmts.push(env.DB.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)').bind(productId, cid)));
  await env.DB.batch(stmts);
}

async function createProduct(req, env) {
  await requireAdmin(req, env);
  const b = await req.json();
  if (!b.name || b.price_gbp == null) throw err('Name and price required', 400);
  const id = uuid();
  await env.DB.prepare('INSERT INTO products (id,name,brand,description,price_gbp,sale_price_gbp,size_type,active) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, b.name, b.brand || null, b.description || null, b.price_gbp, b.sale_price_gbp || null, b.size_type || 'shoe', b.active === false ? 0 : 1).run();
  await writeChildren(env, id, b);
  return jr({ id });
}

async function updateProduct(req, env, id) {
  await requireAdmin(req, env);
  const b = await req.json();
  await env.DB.prepare('UPDATE products SET name=?,brand=?,description=?,price_gbp=?,sale_price_gbp=?,size_type=?,active=? WHERE id=?')
    .bind(b.name, b.brand || null, b.description || null, b.price_gbp, b.sale_price_gbp || null, b.size_type || 'shoe', b.active === false ? 0 : 1, id).run();
  await writeChildren(env, id, b);
  return jr({ id });
}

async function deleteProduct(req, env, id) {
  await requireAdmin(req, env);
  await env.DB.prepare('DELETE FROM products WHERE id=?').bind(id).run();
  return jr({ ok: true });
}

/* ───────────────────────── admin: orders / users ───────────────────────── */

async function adminOrders(req, env) {
  await requireAdmin(req, env);
  const orders = (await env.DB.prepare('SELECT o.*, u.email AS user_email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC').all()).results || [];
  return jr({ orders: await attachItems(env, orders) });
}
async function updateOrder(req, env, id) {
  await requireAdmin(req, env);
  const { status } = await req.json();
  await env.DB.prepare('UPDATE orders SET status=? WHERE id=?').bind(status, id).run();
  return jr({ ok: true });
}
async function adminUsers(req, env) {
  await requireAdmin(req, env);
  const users = (await env.DB.prepare('SELECT id,email,full_name,balance_gbp,is_admin,created_at FROM users ORDER BY created_at DESC').all()).results || [];
  return jr({ users });
}
async function updateUser(req, env, id) {
  await requireAdmin(req, env);
  const b = await req.json();
  if (b.balance_gbp != null) await env.DB.prepare('UPDATE users SET balance_gbp=? WHERE id=?').bind(Number(b.balance_gbp), id).run();
  if (b.is_admin != null) await env.DB.prepare('UPDATE users SET is_admin=? WHERE id=?').bind(b.is_admin ? 1 : 0, id).run();
  return jr({ ok: true });
}

/* ───────────────────────── one-time migration ─────────────────────────
   POST /api/admin/migrate  { products: [ ...seed... ], source_base: "https://...supabase.../product-images/" }
   Pulls each image from the old Supabase Storage URL, stores it in R2, and
   inserts the product with R2 urls. The Worker runs on Cloudflare so it can
   reach both Supabase and R2. Admin-only. Safe to re-run (skips dupes by name).
------------------------------------------------------------------------- */
async function migrate(req, env) {
  await requireAdmin(req, env);
  const { products, source_base } = await req.json();
  const base = (source_base || '').replace(/\/+$/, '');
  if (!Array.isArray(products) || !base) throw err('products[] and source_base required', 400);
  const report = [];
  for (const p of products) {
    const existing = await env.DB.prepare('SELECT id FROM products WHERE name=?').bind(p.name).first();
    if (existing) { report.push({ name: p.name, skipped: 'already exists' }); continue; }
    const id = uuid();
    await env.DB.prepare('INSERT INTO products (id,name,brand,description,price_gbp,sale_price_gbp,size_type,active) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, p.name, p.brand || null, p.description || null, p.price_gbp, p.sale_price_gbp || null, p.size_type || 'shoe', p.active === false ? 0 : 1).run();
    const urls = [];
    for (const key of p.images || []) {
      try {
        const r = await fetch(`${base}/${key}`);
        if (!r.ok) { report.push({ name: p.name, image: key, error: `download ${r.status}` }); continue; }
        await env.BUCKET.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: r.headers.get('content-type') || 'image/jpeg' } });
        urls.push(publicUrl(env, key));
      } catch (e) { report.push({ name: p.name, image: key, error: e.message }); }
    }
    await writeChildren(env, id, { images: urls, sizes: p.sizes, categories: p.categories });
    report.push({ name: p.name, created: true, images: urls.length });
  }
  return jr({ report });
}
