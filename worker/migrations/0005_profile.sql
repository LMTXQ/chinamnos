-- 0005: 用户资料扩展——联系方式（可公开）与管理员上传头像
ALTER TABLE users ADD COLUMN contact TEXT;               -- 联系方式（QQ/微信/手机号等，自填自管）
ALTER TABLE users ADD COLUMN contact_public INTEGER DEFAULT 0; -- 是否公开：1=点头像可见
ALTER TABLE users ADD COLUMN avatar TEXT;                -- 头像 dataURL（仅管理员可上传，≤80KB）
ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER;  -- 头像版本（作缓存破坏参数）
