-- 0043: 公告新增推送开关（采集播报方案追加）
-- user_digest_prefs.announce_push：账号级公告开关（0 关默认 / 1 开）
-- user_notify_channels.announce_push：渠道级三态（NULL=跟随账号全局 / 1=开 / 0=关）
ALTER TABLE user_digest_prefs ADD COLUMN announce_push INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_notify_channels ADD COLUMN announce_push INTEGER;
