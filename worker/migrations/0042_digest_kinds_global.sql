-- 0042: 接收类型（15 类事件）账号全局偏好（采集播报方案追加，与省份范围同一跟随/独立模式）
-- user_digest_prefs.kinds_json：账号全局事件偏好（null = 全收，与渠道语义一致）
-- user_notify_channels.kinds_mode：渠道事件偏好来源（'follow' 跟随账号全局 | 'custom' 独立配置），
--   存量已配置 kinds 的行自动置 custom 以保持行为不变；provinces 范围仍由 digest_mode 管
ALTER TABLE user_digest_prefs ADD COLUMN kinds_json TEXT;
ALTER TABLE user_notify_channels ADD COLUMN kinds_mode TEXT NOT NULL DEFAULT 'follow';
UPDATE user_notify_channels SET kinds_mode = 'custom' WHERE kinds_json IS NOT NULL;
