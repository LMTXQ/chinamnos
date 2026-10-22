-- 0037: 用户通知渠道绑定（站外通知推送方案 · 小方案 A）
-- 用户自助绑定站外推送渠道（首期仅企业微信群机器人，渠道注册表后续即插即用）。
-- 凭证 AES-GCM 加密存储（CARDHUB_SECRET 派生，与联系方式加密同源）；接口/日志永不回显明文。
-- 约束：每用户每类型一条（重复绑定顶替）、总数上限 4；collect_report 为采集播报开关（方案 D 启用）。
CREATE TABLE IF NOT EXISTS user_notify_channels (
  id                TEXT PRIMARY KEY,                -- UUID
  user_id           TEXT NOT NULL REFERENCES users(id),
  channel_type      TEXT NOT NULL,                   -- wecom | dingtalk | feishu | pushplus | qmsg | email（首期仅 wecom）
  cred_enc          TEXT NOT NULL,                   -- 凭证 JSON 密文（AES-GCM）
  target_hint       TEXT NOT NULL,                   -- 脱敏展示（如"企业微信机器人 · key 尾号 abcd"）
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | active
  verify_code_hash  TEXT,                            -- 绑定验证码哈希（sha256，激活后置空）
  verify_expires_at INTEGER,                         -- 验证码过期时间（10 分钟）
  collect_report    INTEGER NOT NULL DEFAULT 0,      -- 采集播报开关（方案 D 启用）
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nch_user_type ON user_notify_channels(user_id, channel_type);
CREATE INDEX IF NOT EXISTS idx_nch_user ON user_notify_channels(user_id, status);
