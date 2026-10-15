-- 0013: 工单系统（用户 → 管理组正式沟通通道，全站基础功能，不受号卡模块开关控制）
-- tickets.scope：all=管理组全员可见 | admin=仅被指定成员（target_id）+站长+创建者可见
-- tickets.status：open=球在管理组（配额语义：同用户 open ≤3）| replied=球在用户 | closed=已关闭
-- ticket_no 展示编号起始 2001（与帖子 1001 段区分）
CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,             -- 随机 base62（防枚举）
  ticket_no     INTEGER NOT NULL,             -- 展示编号
  user_id       TEXT NOT NULL REFERENCES users(id),
  scope         TEXT NOT NULL DEFAULT 'all',  -- all | admin
  target_id     TEXT REFERENCES users(id),    -- scope=admin 时的指定管理组成员
  category      TEXT NOT NULL,                -- 举报|申诉|建议|咨询|其他
  title         TEXT NOT NULL,                -- ≤60 字
  status        TEXT NOT NULL DEFAULT 'open',
  close_reason  TEXT,                         -- user | resolved | invalid
  last_reply_at INTEGER NOT NULL,
  last_reply_by TEXT NOT NULL DEFAULT 'user', -- user | admin
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_no ON tickets(ticket_no);
CREATE INDEX IF NOT EXISTS idx_tickets_inbox ON tickets(status, last_reply_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_target ON tickets(target_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL,                   -- user | admin（管理组成员统一 admin）
  sender_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,                   -- 纯文本 ≤500 字
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tmsg_ticket ON ticket_messages(ticket_id, created_at);
