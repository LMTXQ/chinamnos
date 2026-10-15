-- 0021: 活动集锦（资费页）：用户提交运营商活动 → 管理员审核 → 公开展示
--   province 空串 = 全国活动（展示时随资费页当前省份匹配「本省+全国」）
--   ends_at 选填截止时间：到期由 Cron 置 expired（读路径同时过滤双保险）
--   审核权限=管理员及以上（与工具箱的仅站长不同），全部管理操作写 audit_log
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  carrier TEXT NOT NULL,
  province TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  descr TEXT NOT NULL DEFAULT '',
  ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  submitted_by TEXT NOT NULL,
  reviewer_id TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_act_public ON activities(status, carrier, province);
CREATE INDEX IF NOT EXISTS idx_act_submitter ON activities(submitted_by, status);
CREATE INDEX IF NOT EXISTS idx_act_expire ON activities(status, ends_at);
