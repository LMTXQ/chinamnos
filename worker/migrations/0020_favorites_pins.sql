-- 0020: 帖子收藏 + 精华置顶
--   favorites：用户收藏（下架/成交帖保留记录，仅标记状态，由列表按帖子现状态渲染）
--   posts.pinned_at：精华置顶时间戳（NULL=未置顶；多帖置顶时按 pinned_at DESC 排前，最后置顶的最前）
CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_post ON favorites(post_id);
ALTER TABLE posts ADD COLUMN pinned_at INTEGER;
