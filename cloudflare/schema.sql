-- XCLUSIVELINE — Cloudflare D1 schema
-- Replaces the old Supabase Postgres backend.
-- Apply with:  wrangler d1 execute xclusiveline --remote --file=./schema.sql

PRAGMA foreign_keys = ON;

-- ── Users / accounts ──
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- uuid
  email       TEXT UNIQUE NOT NULL,
  full_name   TEXT,
  pw_hash     TEXT NOT NULL,               -- pbkdf2 hash
  pw_salt     TEXT NOT NULL,               -- per-user salt
  balance_gbp REAL NOT NULL DEFAULT 0,
  is_admin    INTEGER NOT NULL DEFAULT 0,  -- 0/1
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Catalog ──
CREATE TABLE IF NOT EXISTS products (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  brand          TEXT,
  description    TEXT,
  price_gbp      REAL NOT NULL,
  sale_price_gbp REAL,
  size_type      TEXT NOT NULL DEFAULT 'shoe',  -- shoe | clothing
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_images (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pimg_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS product_sizes (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size       TEXT NOT NULL,
  stock      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_psize_product ON product_sizes(product_id);

CREATE TABLE IF NOT EXISTS categories (
  id   TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS product_categories (
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);

-- ── Orders ──
CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  total_gbp  REAL NOT NULL,
  status     TEXT NOT NULL DEFAULT 'paid',  -- paid | shipped | delivered | cancelled
  ship_name  TEXT,
  ship_addr  TEXT,
  ship_city  TEXT,
  ship_post  TEXT,
  ship_country TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    TEXT,
  product_name  TEXT NOT NULL,
  product_brand TEXT,
  size          TEXT,
  price_gbp     REAL NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_oitems_order ON order_items(order_id);

-- ── Wallet top-ups (audit trail) ──
CREATE TABLE IF NOT EXISTS topups (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  amount_gbp      REAL NOT NULL,
  paypal_order_id TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_topups_user ON topups(user_id);
