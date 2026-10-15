-- 0017: 联系渠道多开（contact_policy 单选互斥 → 可见性 + 渠道开关任意组合）
--   contact_visibility: 'public' | 'users' | 'hidden'（直联联系方式的展示范围）
--   allow_chat:  在线沟通开关（0/1）
--   allow_relay: 站长中转开关（0/1）
--   contact_policy 列保留为兼容冗余（写入路径同步维护，读取路径逐步切换）
ALTER TABLE posts ADD COLUMN contact_visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE posts ADD COLUMN allow_chat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN allow_relay INTEGER NOT NULL DEFAULT 0;

-- 旧单选策略映射
UPDATE posts SET contact_visibility = 'public', allow_chat = 0, allow_relay = 0 WHERE contact_policy = 'public';
UPDATE posts SET contact_visibility = 'users',  allow_chat = 0, allow_relay = 0 WHERE contact_policy = 'users';
UPDATE posts SET contact_visibility = 'hidden', allow_chat = 1, allow_relay = 0 WHERE contact_policy = 'relay_online';
UPDATE posts SET contact_visibility = 'hidden', allow_chat = 0, allow_relay = 1 WHERE contact_policy = 'relay_owner';
