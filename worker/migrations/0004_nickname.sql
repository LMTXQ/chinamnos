-- 0004: 用户自建昵称（对外展示用，避免暴露邮箱前缀）
ALTER TABLE users ADD COLUMN nickname TEXT;
