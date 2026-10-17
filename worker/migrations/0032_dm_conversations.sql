-- 0032: 会话模型支持私信（dm）——conversations 解耦帖子
-- ▸ post_id 由 NOT NULL 放宽为可空（私信会话无帖子；交易会话不变）
-- ▸ 新增 kind 列：'post'（交易会话，默认值，存量行全部归为 post）| 'dm'（私信会话）
-- ▸ SQLite 不能直接放宽 NOT NULL，走标准重建表流程；defer_foreign_keys 推迟 FK 检查
--   到事务结束（D1 migration 文件为单事务 batch，届时新表已完成改名，messages 等子表引用可解析）
-- ▸ (post_id, buyer_user_id) 唯一索引补 post_id IS NOT NULL 条件：否则私信会话
--   (NULL, 同一买家) 多行会误撞唯一约束（对不同的私聊对象应允许各建一条）
PRAGMA defer_foreign_keys = ON;
CREATE TABLE conversations_new (
  id            TEXT PRIMARY KEY,
  post_id       TEXT REFERENCES posts(id),   -- 交易会话必填；私信会话为空
  kind          TEXT NOT NULL DEFAULT 'post',-- post | dm
  seller_id     TEXT NOT NULL REFERENCES users(id),
  buyer_user_id TEXT REFERENCES users(id),
  buyer_email   TEXT NOT NULL,
  buyer_name    TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  close_cause   TEXT,
  msg_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO conversations_new
  (id, post_id, kind, seller_id, buyer_user_id, buyer_email, buyer_name, status, close_cause, msg_count, created_at, updated_at)
SELECT id, post_id, 'post', seller_id, buyer_user_id, buyer_email, buyer_name, status, close_cause, msg_count, created_at, updated_at
FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_unique_user
  ON conversations(post_id, buyer_user_id) WHERE buyer_user_id IS NOT NULL AND post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_unique_email
  ON conversations(post_id, buyer_email) WHERE buyer_user_id IS NULL AND post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_buyer ON conversations(buyer_email, status);
CREATE INDEX IF NOT EXISTS idx_conv_seller ON conversations(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_conv_kind_pair ON conversations(kind, seller_id, buyer_user_id);
