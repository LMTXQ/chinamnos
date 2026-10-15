-- 0019: 会话消息支持图片（外链公益图床，站内不存图）；
--       聊天记录保留 60 天（cron 自动删除 + 读路径过滤），会话骨架与计数不受清理影响
ALTER TABLE messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
