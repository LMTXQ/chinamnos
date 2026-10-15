-- 0008: 用户头衔（仅管理员/站长在管理后台设置；默认「平平无奇的路人」由前端兜底显示）
ALTER TABLE users ADD COLUMN title TEXT;
