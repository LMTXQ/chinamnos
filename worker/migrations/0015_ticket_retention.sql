-- 0015: 工单保留期 + 用户累计计数（永久统计，清理数据后仍保留）
-- tickets.closed_at：关闭时间（已关闭工单保留 30 天，Cron 超期永久删除）
-- users.tickets_total：累计提交工单数（创建时 +1，工单被清理后不减）
-- users.posts_closed：累计完成帖数（帖子以 deal 成交关闭时 +1，被清理后不减）
ALTER TABLE tickets ADD COLUMN closed_at INTEGER;
UPDATE tickets SET closed_at = updated_at WHERE status = 'closed';

ALTER TABLE users ADD COLUMN tickets_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN posts_closed INTEGER NOT NULL DEFAULT 0;
