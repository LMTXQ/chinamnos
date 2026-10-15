-- 0024: 活动集锦 → 情报酒馆（双模式改造）
--   mode: official=官方活动推广（沿用原活动语义） / guide=个人攻略发布（MD 正文 + 多链接）
--   links: 附加跳转链接 JSON 数组 [{label,url}]（两模式共用；NULL = 仅主 url，兼容存量）
--   content_md: guide 的 Markdown 正文（≤10000 字符，应用层校验；official 一期不启用）
--   anon: 匿名展示标记（0=实名展示提交者昵称；1=公众侧不下发 uid/昵称，管理员无限制）
ALTER TABLE activities ADD COLUMN mode TEXT NOT NULL DEFAULT 'official';
ALTER TABLE activities ADD COLUMN links TEXT;
ALTER TABLE activities ADD COLUMN content_md TEXT;
ALTER TABLE activities ADD COLUMN anon INTEGER NOT NULL DEFAULT 0;

-- 攻略支持「全运营商通用」（carrier 空串），列表查询改为 carrier IN (?, '')：
-- 现有 idx_act_public(status, carrier, province) 足以覆盖本省/全国/通用三种匹配，无需新索引
