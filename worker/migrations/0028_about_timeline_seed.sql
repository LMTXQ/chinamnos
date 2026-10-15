-- 0028: 项目历程时间轴内置节点 seed（写入 settings，站长在管理中心可直接编辑增删）
-- 仅在键不存在时写入（ON CONFLICT DO NOTHING），不覆盖站长已配置内容
INSERT INTO settings (key, value_json, updated_by, updated_at)
VALUES (
  'about_timeline',
  '[{"t":"","title":"项目起点","desc":"为提升资费查询效率，开发自动化采集脚本，实现运营商官网公开资费的程序化整理"},{"t":"","title":"资费监控 v2","desc":"重构为快照与单条变更追踪体系，实现全网及分省资费的定时采集与可视化监控"},{"t":"","title":"平台化演进","desc":"全栈迁移至 Cloudflare 无服务器架构（Workers / D1 / R2 / Pages），实现低成本稳定运行"},{"t":"","title":"号卡中心上线","desc":"建成用户号卡信息发布体系，确立先审后发机制，完善联系方式分级与站内沟通保障"},{"t":"","title":"社区生态构建","desc":"工具宝库、情报酒馆、工单系统、毛遂自荐等功能相继投入运营"},{"t":"","title":"持续优化","desc":"服务端筛选分页、交互加载反馈、邮箱域名白名单、审核预览与审计日志等机制持续完善"}]',
  'seed',
  1791900000000
) ON CONFLICT(key) DO NOTHING;
