-- 0041: 采集播报账号全局偏好（方案批次四追加，站长需求：懒人配一次，渠道可选跟随/独立）
-- user_digest_prefs：每用户一份全局播报范围（pref_json 格式与渠道 provinces_json 相同：
--   {carrier:[省代码]} 按运营商分组；null = 未设置 = 全收）。
-- user_notify_channels.digest_mode：渠道级范围来源（'follow' 跟随账号全局 | 'custom' 独立配置），
--   默认 follow；存量已配置省份的行迁移时自动置 custom 以保持行为不变。
CREATE TABLE IF NOT EXISTS user_digest_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  pref_json  TEXT,
  updated_at INTEGER NOT NULL
);
ALTER TABLE user_notify_channels ADD COLUMN digest_mode TEXT NOT NULL DEFAULT 'follow';
UPDATE user_notify_channels SET digest_mode = 'custom' WHERE provinces_json IS NOT NULL;
