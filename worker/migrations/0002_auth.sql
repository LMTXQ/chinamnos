-- 第 2 期 · 账号系统（auth 独占，禁止业务字段，§5.2）

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                -- ulid
  email         TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,                   -- SHA-256(K)；K 为前端 PBKDF2 派生密钥（§15.2）
  k_salt        TEXT NOT NULL,                   -- 前端派生盐（16B 随机，base64）
  k_iter        INTEGER NOT NULL,                -- 前端迭代数（注册时校验 ∈ [10万, 1000万]）
  email_verified INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'user',    -- user | admin | owner
  status        TEXT NOT NULL DEFAULT 'active',  -- active | banned
  ban_reason    TEXT,
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);

CREATE TABLE IF NOT EXISTS auth_codes (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,                      -- register | reset
  code_hash  TEXT NOT NULL,                      -- 6位码的 SHA-256（不明文存）
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  request_ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_authcodes_email_purpose ON auth_codes(email, purpose, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,                       -- 随机 256bit 令牌的 SHA-256
  ua         TEXT,
  request_ip TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
