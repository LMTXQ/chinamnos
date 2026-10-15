-- 第 1 期 · common 共享层（§5.2、§16.5）
-- settings / rate_buckets / usage_counters 归 common 共享层：owner 唯一写、各系统只读

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

-- 限流桶（KV 免费版不可用，用 D1 行表替代）
CREATE TABLE IF NOT EXISTS rate_buckets (
  bucket_key TEXT PRIMARY KEY,              -- 如 mail:rcp:a@b.c:2026-09-27 / sendcode:ip:1.2.3.4
  count      INTEGER NOT NULL,
  reset_at   INTEGER NOT NULL
);

-- 低频指标计数（高频指标走 CF GraphQL Analytics / Analytics Engine，不落 D1）
CREATE TABLE IF NOT EXISTS usage_counters (
  day        TEXT NOT NULL,          -- YYYY-MM-DD（UTC）
  metric     TEXT NOT NULL,          -- email_sent
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

-- 种子配置（§4.1；写入接口在第 4 期管理台提供，本期代码只读）
INSERT OR IGNORE INTO settings (key, value_json, updated_by, updated_at) VALUES
  ('module_cardhub_enabled', 'false', 'seed', 0),
  ('turnstile_enforced', 'true', 'seed', 0);
