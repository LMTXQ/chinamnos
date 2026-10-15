-- 第 3 期 · 号卡中心（cardhub 独占，§5.2）

CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,           -- 随机 12 位 base62（不可预测，防遍历枚举）
  user_id        TEXT NOT NULL REFERENCES users(id),
  board          TEXT NOT NULL,              -- lost(寻物启事·求购) | found(失物招领·出让) | rent(租赁中心)
  status         TEXT NOT NULL,              -- pending|open|rejected|closed|expired
  carrier        TEXT NOT NULL,              -- cmcc|unicom|telecom|cbn
  province       TEXT NOT NULL,              -- 省份编码
  city           TEXT NOT NULL,              -- 城市名（必填）
  title          TEXT NOT NULL,
  descr          TEXT NOT NULL,
  extra_json     TEXT NOT NULL DEFAULT '{}', -- 板块配置字段（rent_direction/price/...）
  images_json    TEXT NOT NULL DEFAULT '[]', -- [{key,w,h}] ≤3，R2 key（第3期可空）
  contacts_json  TEXT NOT NULL DEFAULT '[]', -- 见 §9.1
  contact_policy TEXT NOT NULL,              -- public|users|relay_online|relay_owner
  ttl_days       INTEGER NOT NULL,           -- 7|15|30|60|90
  price_num      INTEGER,                    -- extra 中解析出的价格（分），仅排序用，可空
  tags_json      TEXT NOT NULL DEFAULT '[]',
  expiry_notified_at INTEGER,                -- 到期提醒已发送时间
  reject_reason  TEXT,
  reviewer_id    TEXT REFERENCES users(id),
  submitted_at   INTEGER NOT NULL,           -- 最近一次提交/重提时间
  reviewed_at    INTEGER,
  expires_at     INTEGER,                    -- open 时 = reviewed_at + ttl
  closed_at      INTEGER,                    -- 成交/下架时间
  close_reason   TEXT,                       -- deal | withdraw | admin_takedown
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_public
  ON posts(board, carrier, province, city, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_posts_user_status ON posts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_expires ON posts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_posts_closed ON posts(status, closed_at);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  post_id       TEXT NOT NULL REFERENCES posts(id),
  seller_id     TEXT NOT NULL REFERENCES users(id),
  buyer_user_id TEXT REFERENCES users(id),   -- 登录买家可空
  buyer_email   TEXT NOT NULL,               -- 游客必填；登录买家自动取账号邮箱
  buyer_name    TEXT,
  status        TEXT NOT NULL DEFAULT 'open',-- open | closed
  close_cause   TEXT,                        -- cap | post_gone | manual
  msg_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_unique_user
  ON conversations(post_id, buyer_user_id) WHERE buyer_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_unique_email
  ON conversations(post_id, buyer_email) WHERE buyer_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conv_buyer ON conversations(buyer_email, status);
CREATE INDEX IF NOT EXISTS idx_conv_seller ON conversations(seller_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_role     TEXT NOT NULL,             -- seller | buyer
  body            TEXT NOT NULL,             -- 纯文本 ≤500 字
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS relay_requests (
  id            TEXT PRIMARY KEY,
  post_id       TEXT NOT NULL REFERENCES posts(id),
  buyer_name    TEXT NOT NULL,
  buyer_contact TEXT NOT NULL,               -- 买家留的微信/QQ/邮箱
  note          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',-- open | handled | ignored
  handler_id    TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  handled_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_relay_status ON relay_requests(status, created_at);
