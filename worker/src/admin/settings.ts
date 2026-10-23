import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { audit } from '../common/audit';
import { normalizeSchedule } from '../common/notices';
import { NOTIFY_KINDS } from '../common/notifications';

/** 允许修改的设置项白名单（新增设置时同步扩展，前端 SETTING_DESC 补说明） */
const ALLOWED_KEYS = new Set([
  'module_cardhub_enabled',
  'turnstile_enforced',
  'owner_email',
  'mail_daily_cap',
  'site_name',
  'cardhub_trade_merchants',
  'cardhub_trade_site_guarantee',
  'ticket_apply_guarantor',
  'email_domain_whitelist',
  'about_timeline',
  'about_thanks',
  'about_links',
  'site_notice_enabled',
  'site_notice_title',
  'site_notice_content',
  'site_notice_schedule',
  'promos',
  'promo_reswitch_enabled',
  'promo_placeholders',
  'notification_retention_days',
  'mail_post_review_enabled',
  'mail_conversation_enabled',
  'mail_relay_request_enabled',
  'mail_post_expiring_enabled',
  'notify_ext_enabled',
  'notify_ext_kinds',
  'notify_throttle_minutes',
]);

/** 白名单内尚未写入 DB 的新键的默认值（仅「空串即合法默认」的文本键；布尔/数值键的默认语义请走迁移 seed，避免误显开关状态） */
const DEFAULT_VALUES: Record<string, unknown> = {
  ticket_apply_guarantor: '',
  email_domain_whitelist: [], // 空数组 = 使用系统内置常见邮箱域名列表（前端编辑器显示为空）
  about_timeline: [], // 空数组 = 使用系统内置默认时间轴节点（前端编辑器显示为空）
  about_thanks: [], // 空数组 = 鸣谢名单为空，关于页整个区块隐藏
  about_links: [], // 空数组 = 友情链接为空，关于页整个区块隐藏
  site_notice_title: '站点公告',
  site_notice_content: '',
  site_notice_schedule: {}, // 公告弹出日期门槛（空对象 = 不限日期，走每日首访现有逻辑）
  promo_placeholders: [], // 公告/推广正文 {{key}} 占位符取值：[{key,value}]（键名唯一小写 a-z0-9_）
  notification_retention_days: 30,
  promos: [], // 推广列表：[{id,enabled,title,content,version,mode,scope{carriers,provinces,modules}}]（空=无推广；modules 命中=仅进入对应模块时弹）
};

// GET /api/admin/settings：读取所有设置；DEFAULT_VALUES 中的新键尚无行时补默认值，保证站长可在 UI 首次配置
export async function handleGetSettings(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare('SELECT key, value_json, updated_at FROM settings ORDER BY key').all();
  const seen = new Set(rows.results.map((r) => r.key));
  const filled = [
    ...rows.results,
    ...Object.keys(DEFAULT_VALUES)
      .filter((k) => !seen.has(k))
      .sort()
      .map((k) => ({ key: k, value_json: JSON.stringify(DEFAULT_VALUES[k]), updated_at: null })),
  ];
  return ok({ items: filled });
}

/** 公告/推广类键：管理员（admin）亦可修改——2026-10-20 站长决策：全站公告与推广的日常运营
 *  对管理员开放（含辅助键：弹出日期门槛 site_notice_schedule、占位符值 promo_placeholders），
 *  站长保留全部键的修改权；其余键（安全/准入/卡商推荐/关于页等）仍仅 owner */
const ADMIN_EDITABLE_KEYS = new Set([
  'site_notice_enabled',
  'site_notice_title',
  'site_notice_content',
  'site_notice_schedule',
  'promos',
  'promo_reswitch_enabled',
  'promo_placeholders',
]);

// PUT /api/admin/settings/:key：更新设置
// 权限分级：读取门槛 admin（owner 天然通过）；非 ADMIN_EDITABLE_KEYS 的键仍要求 owner
export async function handleUpdateSetting(request: Request, env: Env, key: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;
  if (g.viewer.role !== 'owner' && !ADMIN_EDITABLE_KEYS.has(key)) {
    return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);
  }

  if (!ALLOWED_KEYS.has(key)) return fail(ERR.VALIDATION_ERROR, 'INVALID_KEY', 400);

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  // value 必须是合法 JSON
  let valueJson: string;
  try {
    let value: unknown = body.value;
    // 域名白名单键：规范化为数组（兼容前端传逗号分隔字符串），小写去重去空
    if (key === 'email_domain_whitelist') {
      const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/) : [];
      value = [...new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    }
    // 项目历程时间轴键：规范化为 [{t,title,desc}]（兼容前端传行文本「时间 | 阶段 | 描述」）
    else if (key === 'about_timeline') {
      let raw: unknown[] = [];
      if (Array.isArray(value)) raw = value as unknown[];
      else if (typeof value === 'string') raw = value.split('\n');
      value = raw
        .map((item) => {
          let t = '', title = '', desc = '';
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            t = String(o.t ?? '');
            title = String(o.title ?? '');
            desc = String(o.desc ?? '');
          } else if (typeof item === 'string') {
            const parts = item.split('|').map((x) => x.trim());
            t = parts[0] ?? '';
            title = parts[1] ?? '';
            desc = parts[2] ?? '';
          }
          return { t: t.slice(0, 24), title: title.slice(0, 24), desc: desc.slice(0, 120) };
        })
        .filter((n) => n.title);
    }
    // 鸣谢名单键：规范化为 [{cat,name,f1,f2,f3,f4}]（行文本「类别 | 名称 | 附加字段…」，附加槽位按类别由前端解释语义；
    // 打赏：留言/金额/时间；反馈：摘要/时间；参考项目：介绍/参考说明/链接。非法类别/空名丢弃）
    else if (key === 'about_thanks') {
      const CAT_MAP: Record<string, string> = { '任意打赏': 'donor', '反馈建议': 'feedback', '参考项目': 'ref' };
      let raw: unknown[] = [];
      if (Array.isArray(value)) raw = value as unknown[];
      else if (typeof value === 'string') raw = value.split('\n');
      value = raw
        .map((item) => {
          let cat = '', name = '', f1 = '', f2 = '', f3 = '', f4 = '';
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            cat = String(o.cat ?? '');
            name = String(o.name ?? '');
            f1 = String(o.f1 ?? '');
            f2 = String(o.f2 ?? '');
            f3 = String(o.f3 ?? '');
            f4 = String(o.f4 ?? '');
          } else if (typeof item === 'string') {
            const parts = item.split('|').map((x) => x.trim());
            cat = parts[0] ?? '';
            name = parts[1] ?? '';
            f1 = parts[2] ?? '';
            f2 = parts[3] ?? '';
            f3 = parts[4] ?? '';
            f4 = parts[5] ?? '';
          }
          return {
            cat: CAT_MAP[cat.trim()] || cat.trim(),
            name: name.trim().slice(0, 40),
            f1: f1.trim().slice(0, 120),
            f2: f2.trim().slice(0, 60),
            f3: f3.trim().slice(0, 60),
            f4: f4.trim().slice(0, 200),
          };
        })
        .filter((n) => n.cat === 'donor' || n.cat === 'feedback' || n.cat === 'ref')
        .filter((n) => n.name);
    }
    // 友情链接键：规范化为 [{name, descr, url}]（上限 20 条；url 必须 https:// 开头，非法条目丢弃）
    else if (key === 'about_links') {
      let raw: unknown[] = [];
      if (Array.isArray(value)) raw = value as unknown[];
      else if (typeof value === 'string') value = undefined; // 纯文本格式不支持，防误存
      if (value !== undefined) {
        value = (raw as unknown[])
          .slice(0, 20)
          .map((item) => {
            let name = '', descr = '', url = '';
            if (item && typeof item === 'object') {
              const o = item as Record<string, unknown>;
              name = String(o.name ?? '');
              descr = String(o.descr ?? '');
              url = String(o.url ?? '');
            } else if (typeof item === 'string') {
              const parts = item.split('|').map((x) => x.trim());
              name = parts[0] ?? '';
              descr = parts[1] ?? '';
              url = parts[2] ?? '';
            }
            return { name: name.trim().slice(0, 40), descr: descr.trim().slice(0, 100), url: url.trim().slice(0, 300) };
          })
          .filter((n) => n.name && /^https:\/\//.test(n.url));
      }
    }
    // 推广列表键：规范化为 [{id,enabled,title,content,version,mode,scope{carriers,provinces,modules}}]
    // （上限 50 条；id 缺失丢弃；title/content 裁剪；mode 仅 closable|must；scope 数组元素小写字符串）
    else if (key === 'promos') {
      let raw: unknown[] = [];
      if (Array.isArray(value)) raw = value as unknown[];
      const now = Date.now();
      value = raw
        .slice(0, 50)
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const o = item as Record<string, unknown>;
          const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 32) : '';
          const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
          const content = typeof o.content === 'string' ? o.content.slice(0, 8000) : '';
          if (!id || !title || !content) return null;
          const scopeRaw = (o.scope && typeof o.scope === 'object' ? o.scope : {}) as Record<string, unknown>;
          const normList = (v: unknown): string[] =>
            Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))] : [];
          return {
            id,
            enabled: o.enabled !== false,
            title,
            content,
            version: typeof o.version === 'number' && o.version > 0 ? o.version : now,
            mode: o.mode === 'must' ? 'must' : 'closable',
            scope: { carriers: normList(scopeRaw.carriers), provinces: normList(scopeRaw.provinces), modules: normList(scopeRaw.modules) },
            // 弹出日期门槛（可缺省 = 不限日期；三类任一命中当天即弹，OR）
            schedule: normalizeSchedule(o.schedule) ?? undefined,
          };
        })
        .filter(Boolean);
    }
    // 推荐卡商键：规范化为 字符串 | {name, uid?, intro?} 数组（条数不限，仅站长/管理员可改；
    // name 必填 ≤40 字且**全列表不可重复**——名称是发帖担保人选择的关联键与统计 key；
    // intro ≤60 字）。兼容前端传行文本「卡商名 | uid | 介绍」或对象数组；无 uid/intro 的条目回落纯字符串。
    // 带 uid 的条目校验用户存在且 status='active'，无效整次拒绝保存（防手误 uid 产生前端死链——
    // schema 出口虽有失效降级兜底，保存时拦住可让站长当场知道哪条绑错了）
    else if (key === 'cardhub_trade_merchants') {
      let raw: unknown[] = [];
      if (Array.isArray(value)) raw = value as unknown[];
      else if (typeof value === 'string') raw = value.split('\n');
      const norm = raw
        .map((item) => {
          let name = '', uid = '', intro = '';
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            name = String(o.name ?? '');
            uid = String(o.uid ?? '');
            intro = String(o.intro ?? '');
          } else if (typeof item === 'string') {
            const parts = item.split('|').map((x) => x.trim());
            name = parts[0] ?? '';
            uid = parts[1] ?? '';
            intro = parts[2] ?? '';
          }
          name = name.trim().slice(0, 40);
          uid = uid.trim();
          intro = intro.trim().slice(0, 60);
          if (!name) return null;
          return uid || intro ? { name, uid, intro } : name;
        })
        .filter((x): x is string | { name: string; uid: string; intro: string } => !!x);
      const seenNames = new Set<string>();
      for (const x of norm) {
        const n = typeof x === 'string' ? x : x.name;
        if (seenNames.has(n)) {
          return fail(ERR.VALIDATION_ERROR, `卡商名称重复：「${n}」。名称是担保人选择的关联标识，同列表内不可重复`, 400, { field: key });
        }
        seenNames.add(n);
      }
      const uids = [...new Set(norm.map((x) => (typeof x === 'object' ? x.uid : '')).filter(Boolean))];
      if (uids.length) {
        const ph = uids.map(() => '?').join(',');
        const { results } = await env.DB.prepare(
          `SELECT id FROM users WHERE id IN (${ph}) AND status = 'active'`,
        ).bind(...uids).all<{ id: string }>();
        const found = new Set((results || []).map((r) => r.id));
        const missing = uids.filter((u) => !found.has(u));
        if (missing.length) {
          return fail(ERR.VALIDATION_ERROR, `以下 UID 对应的站内用户不存在或已封禁/注销，无法绑定：${missing.join('、')}`, 400, {
            field: key,
          });
        }
      }
      value = norm;
    }
    // 公告弹出日期门槛键：复用 normalizeSchedule（yearly MM-DD / monthly 1-31|last / weekly 1-7；
    // 三类任一命中当天即弹 OR，全空/非法 = 存空对象 = 不限日期走现有逻辑）
    else if (key === 'site_notice_schedule') {
      const sched = normalizeSchedule(value);
      value = sched ?? {};
    }
    // 占位符取值键：规范化为 [{key, value}]（键名小写 a-z0-9_ 1~20 位且不可重复，值 ≤200 字符纯文本；
    // 数量不限——键名即唯一标识，重复直接拒绝保存）。值渲染时走 mdToSafeHtml 转义管线，无注入面
    else if (key === 'promo_placeholders') {
      let raw: unknown[] = [];
      if (Array.isArray(value)) raw = value as unknown[];
      else if (typeof value === 'string') raw = value.split('\n');
      const norm: { key: string; value: string }[] = [];
      const seen = new Set<string>();
      for (const item of raw) {
        let k = '', v = '';
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          k = String(o.key ?? '');
          v = String(o.value ?? '');
        } else if (typeof item === 'string') {
          const parts = item.split('|');
          k = parts[0] ?? '';
          v = parts.slice(1).join('|'); // 值本身可能含竖线：首个竖线后全部作为值
        }
        k = k.trim().toLowerCase();
        v = v.trim().slice(0, 200);
        if (!k) continue;
        if (!/^[a-z0-9_]{1,20}$/.test(k)) {
          return fail(ERR.VALIDATION_ERROR, `占位符键名「${k}」不合法：仅限小写字母/数字/下划线（1~20 位）`, 400, { field: key });
        }
        if (seen.has(k)) {
          return fail(ERR.VALIDATION_ERROR, `占位符键名重复：「${k}」`, 400, { field: key });
        }
        seen.add(k);
        norm.push({ key: k, value: v });
      }
      value = norm;
    }
    if (key === 'site_notice_content') {
      value = String(value ?? '').slice(0, 8000);
    }
    // 通知保留天数：整数 1~365
    else if (key === 'notification_retention_days') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 365) return fail(ERR.VALIDATION_ERROR, 'INVALID_VALUE', 400, { field: key });
      value = n;
    }
    // 公告标题：单行短文本
    else if (key === 'site_notice_title') {
      value = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || '站点公告';
    }
    // 公告/警告开关：强校验布尔（防止存入字符串等脏值）
    else if (key === 'site_notice_enabled' || key === 'cardhub_trade_site_guarantee' || key === 'promo_reswitch_enabled') {
      if (typeof value !== 'boolean') return fail(ERR.VALIDATION_ERROR, 'INVALID_VALUE', 400, { field: key });
    }
    // 邮件通知分场景开关：强校验布尔
    else if (key === 'mail_post_review_enabled' || key === 'mail_conversation_enabled' || key === 'mail_relay_request_enabled' || key === 'mail_post_expiring_enabled') {
      if (typeof value !== 'boolean') return fail(ERR.VALIDATION_ERROR, 'INVALID_VALUE', 400, { field: key });
    }
    // 站外通知推送（方案 B）：总开关布尔；事件白名单限定已知 kind 数组
    // 同类过滤窗口（notify_throttle_minutes）：整数 0~1440 分钟，0 = 关闭过滤；
    // 铃铛与外推共用闸门——同用户同事件对象窗口内只写一条铃铛且只外推一次
    else if (key === 'notify_ext_enabled') {
      if (typeof value !== 'boolean') return fail(ERR.VALIDATION_ERROR, 'INVALID_VALUE', 400, { field: key });
    } else if (key === 'notify_ext_kinds') {
      if (!Array.isArray(value)) return fail(ERR.VALIDATION_ERROR, 'INVALID_VALUE', 400, { field: key });
      const known = new Set<string>(NOTIFY_KINDS);
      value = [...new Set(value.map((x) => String(x)))].filter((k) => known.has(k));
    } else if (key === 'notify_throttle_minutes') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 1440) return fail(ERR.VALIDATION_ERROR, 'INVALID_VALUE', 400, { field: key });
      value = n;
    }
    valueJson = JSON.stringify(value);
  } catch {
    return fail(ERR.VALIDATION_ERROR, 'INVALID_VALUE', 400);
  }

  await env.DB.prepare(
    `INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET value_json = ?2, updated_by = ?3, updated_at = ?4`,
  ).bind(key, valueJson, g.viewer.id, Date.now()).run();

  await audit(env, request, g.viewer, {
    action: 'update_setting',
    targetType: 'setting',
    targetId: key,
    detail: { value: body.value },
  });

  return ok({ key, value: body.value });
}
