-- 第 5 期 · 管理后台增强：审计日志 + 帖子管理支撑索引

-- 审计日志：记录所有管理端写操作（who / what / when / 详情）
CREATE TABLE IF NOT EXISTS audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     TEXT NOT NULL,                -- 操作者 users.id
  actor_email  TEXT NOT NULL,                -- 冗余存储，操作者被删后仍可追溯
  action       TEXT NOT NULL,                -- review_post | close_post | delete_post | ban_user | unban_user | set_role | update_setting | relay_handle
  target_type  TEXT NOT NULL,                -- post | user | setting | relay
  target_id    TEXT,                         -- 目标对象 id / key
  detail_json  TEXT NOT NULL DEFAULT '{}',   -- 动作详情（approve/reason/value...）
  ip           TEXT,                         -- 操作来源 IP（CF-Connecting-IP）
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at DESC);

-- 管理端帖子列表筛选（status+board 维度，现有索引不含 board 组合）
CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board, status, created_at DESC);
