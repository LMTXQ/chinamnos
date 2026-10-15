-- 0014: 工单来源与关联编号
-- source：发起工单时所在的功能系统（tariff 资费监测 | cardhub 号卡中心 | ticket 工单中心 |
--         config 配置工具 | admin 管理后台 | other 其他）；自由 TEXT，前端白名单展示
-- ref_no：选填关联编号（如帖子 post_no），便于审核时定位上下文
ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'ticket';
ALTER TABLE tickets ADD COLUMN ref_no INTEGER;
