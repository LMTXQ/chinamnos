-- 0031: 站内通知中心（系统→用户 单向通知）
-- 所有"系统→用户"事件统一入箱：审核结果（情报/社群/工具/帖子）、到期自动下架下展、管理组下架、在线沟通新消息。
-- 无虚拟发件账号：发送者「用户管理组」为前端展示层概念（kind→图标/文案映射），数据库不建系统账号。
-- 单向不可回复、无条数上限（不走 conversations/messages 交易对话体系）。
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,               -- UUID
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,                  -- act_approved | act_rejected | chat_approved | chat_rejected
                                             -- act_retired | act_expired | link_approved | link_rejected
                                             -- post_approved | post_rejected | post_closed | post_expired | dm_message
  ref_id     TEXT,                           -- 关联对象 id（前端跳转定位）
  title      TEXT NOT NULL,                  -- 一行标题（≤120 字）
  body       TEXT,                           -- 完整内容（驳回原因 / 展示时序说明，≤1000 字）
  created_at INTEGER NOT NULL,
  read_at    INTEGER                         -- NULL = 未读
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id, read_at);
