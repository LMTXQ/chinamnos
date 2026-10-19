-- 0034: 会话删除（微信式隐藏）——双方各自从自己的会话列表移除，对方不受影响
-- ▸ hidden_seller / hidden_buyer：各自视角的隐藏标记（0=可见，1=已从我的列表移除）
-- ▸ 对方发新消息时清双方标记（会话重新出现，微信同款）；主动复用会话（dm/帖子在线沟通）
--   清发起方标记（用户主动找回）
ALTER TABLE conversations ADD COLUMN hidden_seller INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN hidden_buyer INTEGER NOT NULL DEFAULT 0;
