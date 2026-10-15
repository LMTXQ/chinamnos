-- 0016: 工具箱 / 导航链接系统（通用集合设计）
-- nav_links 以 collection 区分集合：toolbox（工具箱）是第一个集合，
-- 将来「各省运营商活动汇总页」等只需新增集合值 + 前端复用渲染，零新增表。
-- 权限：所有游客可浏览 open 链接；登录用户可提交（pending 配额 ≤5 + 限流）；
--       仅站长审核与管理（管理中心工具箱 Tab 仅站长可见）。
CREATE TABLE IF NOT EXISTS nav_links (
  id           TEXT PRIMARY KEY,               -- 随机 base62（不可枚举）
  collection   TEXT NOT NULL,                  -- 集合键：toolbox | 将来 carrier_activities 等（后端白名单）
  group_name   TEXT NOT NULL DEFAULT '',       -- 页内分组（如「官方渠道」「实用查询」）
  title        TEXT NOT NULL,                  -- 名称 ≤30 字
  url          TEXT NOT NULL,                  -- https(s):// 绝对链接 或 / 开头站内路径（写入白名单校验）
  icon_url     TEXT,                           -- 图标 URL（可空；前端 favicon 三级回退）
  descr        TEXT,                           -- 一句话简介 ≤80 字
  sort         INTEGER NOT NULL DEFAULT 100,   -- 组内排序（小在前，管理中心可调）
  status       TEXT NOT NULL DEFAULT 'pending',-- pending → open | rejected；open 可 retired（下架可复上）
  submitted_by TEXT REFERENCES users(id),      -- 提交者（站长手工添加直接 open）
  reject_reason TEXT,
  reviewer_id  TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  reviewed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nav_public ON nav_links(collection, status, group_name, sort);
CREATE INDEX IF NOT EXISTS idx_nav_status ON nav_links(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nav_submitter ON nav_links(submitted_by, status);
