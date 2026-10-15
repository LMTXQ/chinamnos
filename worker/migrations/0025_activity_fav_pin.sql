-- 0025: 情报酒馆收藏 + 置顶
--   act_favorites：用户收藏（情报酒馆独立于 posts.favorites，语义与清理周期不同故不共用）
--   activities.pinned_at：置顶时间戳（NULL=未置顶；多帖置顶按 pinned_at DESC 排前，最后置顶的最前）
CREATE TABLE IF NOT EXISTS act_favorites (
  user_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_actfav_activity ON act_favorites(activity_id);
ALTER TABLE activities ADD COLUMN pinned_at INTEGER;
