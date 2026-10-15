import type { Env } from './env';
import { ok } from './envelope';
import { getFlags } from './settings';

// GET /api/meta：模块开关探测（common 层，无鉴权，边缘缓存 5 分钟，§4.1）
// 探测"某模块是否关闭"不能依赖该模块自己的接口（防自举死锁），故放在 common 层
export async function handleMeta(env: Env): Promise<Response> {
  const flags = await getFlags(env);
  return ok(
    { modules: { cardhub: flags.cardhub } },
    { 'Cache-Control': 'public, max-age=300' },
  );
}

// GET /api/about/timeline：关于页「项目历程」时间轴节点（anon，边缘缓存 60s——站长配置后最多延迟 60s 生效）
//   settings 键 about_timeline = [{ t, title, desc }]；内置默认节点已通过 0028 migration seed 进 settings，
//   站长清空配置时返回空数组（前端隐藏时间轴区块）
export async function handleAboutTimeline(_request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT value_json FROM settings WHERE key = ?1',
  ).bind('about_timeline').first<{ value_json: string }>();
  let timeline: Array<{ t: string; title: string; desc: string }> = [];
  if (row) {
    try {
      const v = JSON.parse(row.value_json);
      if (Array.isArray(v)) {
        timeline = v
          .map((n: Record<string, unknown>) => ({
            t: String(n.t ?? '').slice(0, 24),
            title: String(n.title ?? '').slice(0, 24),
            desc: String(n.desc ?? '').slice(0, 120),
          }))
          .filter((n) => n.title);
      }
    } catch { /* 配置异常按未配置处理 */ }
  }
  return ok({ timeline }, { 'Cache-Control': 'public, max-age=60' });
}

// GET /api/about/thanks：关于页「鸣谢名单」（anon，边缘缓存 60s——站长配置后最多延迟 60s 生效）
//   settings 键 about_thanks = [{ cat, name, f1, f2, f3, f4 }]，cat ∈ donor(打赏)/feedback(反馈建议)/ref(参考项目)
//   附加槽位语义由类别决定：打赏=留言/金额/时间；反馈=摘要/时间；参考项目=介绍/参考说明/链接
//   返回按类别分组；类别非法或 name 为空的条目丢弃；三组均可为空（前端空组隐藏）
export async function handleAboutThanks(_request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT value_json FROM settings WHERE key = ?1',
  ).bind('about_thanks').first<{ value_json: string }>();
  const groups: Record<string, Array<Record<string, string>>> = {
    donor: [], feedback: [], ref: [],
  };
  if (row) {
    try {
      const v = JSON.parse(row.value_json);
      if (Array.isArray(v)) {
        for (const n of v) {
          const o = n as Record<string, unknown>;
          const cat = String(o.cat ?? '');
          if (!(cat in groups)) continue;
          const name = String(o.name ?? '').trim().slice(0, 40);
          if (!name) continue;
          groups[cat].push({
            name,
            f1: String(o.f1 ?? '').slice(0, 120),
            f2: String(o.f2 ?? '').slice(0, 60),
            f3: String(o.f3 ?? '').slice(0, 60),
            f4: String(o.f4 ?? '').slice(0, 200),
          });
        }
      }
    } catch { /* 配置异常按未配置处理 */ }
  }
  return ok({ groups }, { 'Cache-Control': 'public, max-age=60' });
}

// GET /api/about/links：关于页「友情链接」（anon，边缘缓存 60s——站长配置后最多延迟 60s 生效）
//   settings 键 about_links = [{ name, descr, url }]；name/url 为空的条目丢弃；空数组 = 整块隐藏
export async function handleAboutLinks(_request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT value_json FROM settings WHERE key = ?1',
  ).bind('about_links').first<{ value_json: string }>();
  const links: Array<Record<string, string>> = [];
  if (row) {
    try {
      const v = JSON.parse(row.value_json);
      if (Array.isArray(v)) {
        for (const n of v) {
          const o = n as Record<string, unknown>;
          const name = String(o.name ?? '').trim().slice(0, 40);
          const url = String(o.url ?? '').trim().slice(0, 300);
          if (!name || !/^https:\/\//.test(url)) continue;
          links.push({ name, descr: String(o.descr ?? '').slice(0, 100), url });
        }
      }
    } catch { /* 配置异常按未配置处理 */ }
  }
  return ok({ links }, { 'Cache-Control': 'public, max-age=60' });
}
