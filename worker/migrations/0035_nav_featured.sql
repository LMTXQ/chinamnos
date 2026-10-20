-- nav_links 增加 featured 标志：站长在管理后台将条目标记为「特殊站点」，
-- 觅珍集库（/tools）页面顶部独立高亮区展示；随导航链接导出链路（快照/烘焙）一并下发。
ALTER TABLE nav_links ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
