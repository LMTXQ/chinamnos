/* ═══════════════════════════════════════════════════════════════
   公共配置快照读取（data/public-config.json）
   ───────────────────────────────────────────────────────────────
   ▸ 采集端每轮部署前，从 Worker 公开只读接口搬运「人人一样、不怕逆向」的配置
     （meta 模块开关 / notices 公告警告 / email_policy 域名白名单 / cardhub schema /
     ticket_apply_guarantor 自荐申请模板 / about 时间轴与鸣谢 / nav_links 宝库导航），
     与 stats 等数据一起部署到 Pages
   ▸ 各消费点优先读本快照（Pages 静态文件，配置类请求零 Worker 消耗）；
     返回 null（文件缺失/采集失败）时由调用方回落原 Worker 接口
   ▸ 权威源仍是管理端 settings（D1）：配置变更经「下一轮采集」反映到快照
   ═══════════════════════════════════════════════════════════════ */
"use strict";

let _p = null;
export function getPubConfig() {
  if (!_p) {
    _p = fetch("./data/public-config.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _p;
}
