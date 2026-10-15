// 板块/字段配置（§9：配置驱动，站长后期可扩展；本期内置默认配置）
import type { Env } from '../common/env';
import { getSetting } from '../common/settings';

/** 交易方式（帖子级多选，仅供参考，具体交易方式由交易双方实际协商） */
export interface TradeMethod {
  id: string;
  name: string;
  desc: string;
  /** 风险警示（前端以警示色强调） */
  warn?: boolean;
}

export const TRADE_METHODS: TradeMethod[] = [
  { id: 'offline', name: '线下手拉手', desc: '双方当面交易，钱货两清' },
  { id: 'xianyu', name: '闲鱼等二手平台', desc: '注意：此类平台买方拥有无条件仅退款风险', warn: true },
  { id: 'merchant', name: '圈内卡商担保', desc: '请与交易方沟通后选择双方均认可的可信卡商；推荐栏仅作参考，不代表站点为所推荐人承担保证' },
  { id: 'site', name: '站点担保', desc: '通过站点提供的担保流程交易' },
];

/** multi 字段的分组维度：每组内单选（如 通用性: 通用|定向），组间自由组合 */
export interface MultiGroup {
  label: string;
  options: string[];
}

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'multi' | 'select' | 'textarea' | 'tags' | 'markdown';
  required: boolean;
  options?: string[];
  placeholder?: string;
  /** 展示单位（如 'GB'/'分钟'）：不进 label，由前端在展示时拼接到值后 */
  unit?: string;
  /** true 时前后台均强制纯整数（/^\d+$/），用于通话/流量/宽带/短信等规格字段 */
  int?: boolean;
  /** multi 类型：分组单选维度（每组至多选一个，组间组合；组顺序即显示顺序） */
  groups?: MultiGroup[];
  /** multi 类型：最多条数（默认 4） */
  maxItems?: number;
  /** multi 项可附带到期时间（expire: 'YYYY-MM' | 'YYYY'）；标注「短期」的条目必填 */
  expire?: boolean;
  /** text 类型：最大长度（默认 200） */
  max?: number;
  /** 条件显示：showIf.key（tags 多选字段）的选中项与 any 有交集时才显示/校验；未命中时剔除传入值 */
  showIf?: { key: string; any: string[] };
}

export interface BoardDef {
  id: 'found' | 'lost' | 'rent_out' | 'rent_want' | 'fleet' | 'market';
  name: string;
  desc: string;
  fields: FieldDef[];
}

export const CARRIERS = [
  { id: 'cmcc', name: '中国移动' },
  { id: 'unicom', name: '中国联通' },
  { id: 'telecom', name: '中国电信' },
  { id: 'cbn', name: '中国广电' },
];

export const TTL_OPTIONS = [7, 15, 30, 60, 90];

export const CONTACT_POLICIES = [
  { id: 'public', name: '公开联系方式', desc: '任何人可见' },
  { id: 'users', name: '登录可见', desc: '仅登录用户可见' },
  { id: 'relay_online', name: '站内在线沟通', desc: '通过站内消息联系' },
  { id: 'relay_owner', name: '站长中转', desc: '通过站长转交意向' },
];

export const BOARDS: BoardDef[] = [
  {
    id: 'found',
    name: '卡源出让',
    desc: '我有卡要出手（出让）',
    fields: [
      { key: 'package_name', label: '套餐名称', type: 'text', required: true, placeholder: '如：移动29元100G' },
      { key: 'deal_price', label: '预期交易金额（元）', type: 'number', required: true, int: true, unit: '元', placeholder: '如：300（您期望的卖卡价格）' },
      { key: 'monthly_fee', label: '月租', type: 'multi', required: true, int: true, unit: '元/月',
        groups: [
          { label: '期限', options: ['短期', '长期'] },
        ], maxItems: 2, expire: true, placeholder: '如：29；分段资费加多条标注期限，短期需填到期时间（如 短期29/至2029-10）' },
      { key: 'call', label: '通话', type: 'multi', required: true, int: true, unit: '分钟',
        groups: [
          { label: '范围', options: ['国内', '国际'] },
        ], maxItems: 3, placeholder: '如：100（无则填 0）' },
      { key: 'data', label: '流量', type: 'multi', required: true, int: true, unit: 'GB',
        groups: [
          { label: '通用性', options: ['通用', '定向'] },
          { label: '范围', options: ['全国', '省内'] },
          { label: '期限', options: ['长期', '短期'] },
        ], maxItems: 4, placeholder: '如：100（无则填 0）' },
      { key: 'broadband', label: '宽带', type: 'multi', required: true, int: true, unit: 'M',
        groups: [
          { label: '范围', options: ['跨省', '本省'] },
        ], maxItems: 3, placeholder: '如：300（无则填 0）' },
      { key: 'sms', label: '短信', type: 'number', required: true, int: true, unit: '条', placeholder: '如：100（无则填 0）' },
      { key: 'transfer', label: '过户方式', type: 'select', required: true, options: ['线上过户', '线下过户'] },
      { key: 'phone_num', label: '号码', type: 'text', required: true, max: 20,
        placeholder: '完整号码（仅站点保存，公众不可见）' },
      { key: 'phone_masked', label: '号码公开显示', type: 'text', required: true, max: 24,
        placeholder: '不想暴露的位用 * 代替，如 138****8000' },
      { key: 'phone_traits', label: '号码特征', type: 'tags', required: false,
        options: ['靓号', '含4', '无4', '连号', '对子号'] },
    ],
  },
  {
    id: 'lost',
    name: '卡源求购',
    desc: '我想办/想买某个套餐（求购）',
    fields: [
      { key: 'package_name', label: '想找的套餐名称', type: 'text', required: true, placeholder: '如：移动8元保号' },
      { key: 'monthly_fee', label: '期望月租', type: 'multi', required: true, int: true, unit: '元/月',
        groups: [
          { label: '期限', options: ['短期', '长期'] },
        ], maxItems: 2, expire: true, placeholder: '如：29；分段资费加多条标注期限，短期需填到期时间（如 短期29/至2029-10）' },
      // multi：多条规格（每条 = 数值 + 分组单选组合），如 流量 通用·全国 30GB / 定向·省内 200GB
      { key: 'call', label: '通话', type: 'multi', required: true, int: true, unit: '分钟',
        groups: [
          { label: '范围', options: ['国内', '国际'] },
        ], maxItems: 3, placeholder: '如：100（无则填 0）' },
      { key: 'data', label: '流量', type: 'multi', required: true, int: true, unit: 'GB',
        groups: [
          { label: '通用性', options: ['通用', '定向'] },
          { label: '范围', options: ['全国', '省内'] },
          { label: '期限', options: ['长期', '短期'] },
        ], maxItems: 4, placeholder: '如：100（无则填 0）' },
      { key: 'broadband', label: '宽带', type: 'multi', required: true, int: true, unit: 'M',
        groups: [
          { label: '范围', options: ['跨省', '本省'] },
        ], maxItems: 3, placeholder: '如：300（无则填 0）' },
      { key: 'sms', label: '短信', type: 'number', required: true, int: true, unit: '条', placeholder: '如：100（无则填 0）' },
      { key: 'budget', label: '预算（元/月）', type: 'number', required: false, placeholder: '如：20' },
      { key: 'quantity', label: '需要数量', type: 'number', required: false, placeholder: '如：1' },
      { key: 'transfer', label: '期望过户方式', type: 'select', required: true, options: ['线上过户', '线下过户'] },
      { key: 'phone_traits', label: '号码特征', type: 'tags', required: false,
        options: ['靓号', '含4', '无4', '连号', '对子号'] },
    ],
  },
  {
    id: 'rent_out',
    name: '卡源出租',
    desc: '我有卡可以出租',
    fields: [
      { key: 'package_name', label: '套餐名称', type: 'text', required: true },
      { key: 'monthly_fee', label: '月租（元）', type: 'number', required: true },
      { key: 'min_months', label: '最短租期（月）', type: 'number', required: false },
    ],
  },
  {
    id: 'rent_want',
    name: '卡源求租',
    desc: '我想租一张卡',
    fields: [
      { key: 'package_name', label: '想租的套餐要求', type: 'text', required: true },
      { key: 'monthly_fee', label: '期望月租（元）', type: 'number', required: true },
      { key: 'min_months', label: '期望租期（月）', type: 'number', required: false },
    ],
  },
  {
    // 车队：用户发资费信息「开车」招人上车。业务模型：卡是上车人自己的（携转/老改用已有卡，
    //   新开自行开卡，加包/删包在自己号上操作），司机不提供卡——故无号码字段（号码机制仅归出让）。
    //   月租/流量/通话/宽带仅套餐类类型（新开/携转/老改）显示；加包/删包以「套餐/包名称 + 上车车费」描述。
    //   车队风险声明必填：发布者如实声明掉包史/扣款项/稳定性等，让上车人事先知情。
    id: 'fleet',
    name: '车队',
    desc: '资费开车信息（上车人自备卡，车头组织上车）',
    fields: [
      { key: 'fleet_type', label: '开车类型', type: 'tags', required: true,
        options: ['新开', '携转', '老改', '删包', '加包'] },
      { key: 'package_name', label: '套餐 / 包名称', type: 'text', required: true, max: 60,
        placeholder: '整车填套餐名（如 29元100G车），加包/删包填包名（如 10元100G包）' },
      { key: 'car_fee', label: '上车车费（元）', type: 'number', required: true, int: true, unit: '元',
        placeholder: '如：50（每位上车者支付给车头的费用）' },
      { key: 'monthly_fee', label: '月租', type: 'multi', required: true, int: true, unit: '元/月',
        groups: [
          { label: '期限', options: ['短期', '长期'] },
        ], maxItems: 2, expire: true,
        showIf: { key: 'fleet_type', any: ['新开', '携转', '老改'] },
        placeholder: '如：29；分段资费加多条标注期限，短期需填到期时间（如 短期29/至2029-10）' },
      { key: 'data', label: '流量', type: 'multi', required: false, int: true, unit: 'GB',
        groups: [
          { label: '通用性', options: ['通用', '定向'] },
          { label: '范围', options: ['全国', '省内'] },
          { label: '期限', options: ['长期', '短期'] },
        ], maxItems: 4,
        showIf: { key: 'fleet_type', any: ['新开', '携转', '老改'] },
        placeholder: '如：100（无则填 0）' },
      { key: 'call', label: '通话', type: 'multi', required: false, int: true, unit: '分钟',
        groups: [
          { label: '范围', options: ['国内', '国际'] },
        ], maxItems: 3,
        showIf: { key: 'fleet_type', any: ['新开', '携转', '老改'] },
        placeholder: '如：100（无则填 0）' },
      { key: 'broadband', label: '宽带', type: 'multi', required: false, int: true, unit: 'M',
        groups: [
          { label: '范围', options: ['跨省', '本省'] },
        ], maxItems: 3,
        showIf: { key: 'fleet_type', any: ['新开', '携转', '老改'] },
        placeholder: '如：300（无则填 0）' },
      { key: 'fleet_risk', label: '车队风险声明', type: 'textarea', required: true, max: 200,
        placeholder: '如实声明本车风险：掉包史、扣款项、稳定性、赔付方式等；无已知风险也请写明「暂无已知风险，以运营商实际执行为准」' },
      { key: 'fleet_req', label: '上车前提', type: 'text', required: false, max: 120,
        placeholder: '如：需现场过户 / 需预存 100 元 / 仅限本地身份证' },
    ],
  },
  {
    // 市集：权益回收市集收录（车队之后）。内容为图文弹窗：Markdown 图文介绍（图床外链 +
    //   跳转链接，md.js 渲染）+ 回收权益范围（单一=自填品类 / 综合）。
    //   无号码/价格/有效期/运营商/省份维度（长期目录型内容，全国性）；列表查询不带省市过滤。
    id: 'market',
    name: '市集',
    desc: '权益回收市集收录（优惠券/会员等，图文弹窗展示）',
    fields: [
      { key: 'market_scope', label: '回收权益范围', type: 'select', required: true, options: ['单一', '综合'] },
      { key: 'market_kind', label: '回收品类', type: 'text', required: true, max: 30,
        showIf: { key: 'market_scope', any: ['单一'] },
        placeholder: '单一权益时填写是哪一种，如：视频会员 / 游戏道具 / 优惠券' },
      { key: 'market_body', label: '市集介绍', type: 'markdown', required: true, max: 8000,
        placeholder: '支持 Markdown：**加粗**、[链接](https://…)、图片直链、- 列表、# 标题；介绍你的市集：回收哪类权益、回收方式与跳转入口' },
    ],
  },
];

// 板块字段校验（post-create / post-update 共用，§9 配置驱动）：
//   multi 字段（多条规格，如通话/流量/宽带）：[{v,t}]——v 纯整数、t ⊆ schema.groups、同组互斥、条数 ≤ maxItems
//   tags 字段：string[]，每项 ∈ options、去重
//   单值字段：required 必填；int 必须纯整数；select 限选项；max 限长
// 返回首个不通过的字段 key（写 400 的 data.field 用），全部通过返回 null；tags 缺省会地补 []
export function validateBoardFields(boardId: string, extra: Record<string, unknown>): string | null {
  const boardDef = BOARDS.find((b) => b.id === boardId);
  if (!boardDef) return 'board';
  for (const fd of boardDef.fields) {
    // 号码隐私专项字段：phone_num 由号码拦截段校验（含剥离/必填/格式），phone_masked 由其自动打码，
    // 必须先于本循环执行——否则 required 校验会在自动生成前拒绝（曾致不预填 masked 的提交报 phone_masked）
    if (fd.key === 'phone_num' || fd.key === 'phone_masked') continue;
    // 条件显示字段：showIf.key（tags 多选数组或 select 单值字符串）选中项与 any 无交集时，
    // 剔除传入值（防绕过前端直发的脏数据）并跳过校验
    if (fd.showIf) {
      const rawSel = extra[fd.showIf.key];
      const sel = Array.isArray(rawSel)
        ? rawSel.map(String)
        : (rawSel != null && String(rawSel).trim() !== '' ? [String(rawSel)] : []);
      if (!fd.showIf.any.some((x) => sel.includes(x))) { delete extra[fd.key]; continue; }
    }
    if (fd.type === 'multi') {
      let rawV = extra[fd.key];
      // 旧数据兼容：历史单值（数字/字符串）自动升维为无标签单条（配合 D1 迁移做防御）
      if (rawV != null && !Array.isArray(rawV) && String(rawV).trim() !== '') rawV = [{ v: rawV, t: [] }];
      const arr = rawV;
      if (arr == null || (Array.isArray(arr) && !arr.length)) {
        if (fd.required) return fd.key;
        continue;
      }
      if (!Array.isArray(arr)) return fd.key;
      if (arr.length > (fd.maxItems ?? 4)) return fd.key;
      for (const it of arr) {
        if (!it || typeof it !== 'object') return fd.key;
        const o = it as Record<string, unknown>;
        const v = String(o.v ?? '').trim();
        if (!/^\d+$/.test(v)) return fd.key;
        // 到期时间：声明 expire 的字段，条目可带 'YYYY-MM'/'YYYY'；标注「短期」的条目必须填写
        if (fd.expire) {
          const exp = o.expire == null ? '' : String(o.expire).trim();
          if (exp) {
            if (!/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(exp)) return fd.key;
            o.expire = exp; // 原地归一化
          } else if (Array.isArray(o.t) && o.t.includes('短期')) {
            return fd.key; // 短期不写到期时间=无法判断多短，直接拒绝
          } else if ('expire' in o) {
            delete o.expire;
          }
        }
        if (o.t !== undefined) {
          if (!Array.isArray(o.t)) return fd.key;
          // 分组单选校验：每个标签必须属于某组选项；同组至多一个；不可重复
          const groups = fd.groups ?? [];
          const seenGroups = new Set<string>();
          const seenTags = new Set<string>();
          for (const x of o.t) {
            const xs = String(x);
            const g = groups.find((gr) => gr.options.includes(xs));
            if (!g) return fd.key;
            if (seenTags.has(xs) || seenGroups.has(g.label)) return fd.key;
            seenTags.add(xs);
            seenGroups.add(g.label);
          }
        }
      }
      continue;
    }
    if (fd.type === 'tags') {
      const arr = extra[fd.key];
      if (arr == null) { extra[fd.key] = []; continue; }
      if (!Array.isArray(arr)) return fd.key;
      const opts = fd.options ?? [];
      const seen = new Set<string>();
      for (const x of arr) {
        const xs = String(x);
        if (!opts.includes(xs)) return fd.key;
        seen.add(xs);
      }
      extra[fd.key] = [...seen];
      continue;
    }
    const s = extra[fd.key] == null ? '' : String(extra[fd.key]).trim();
    if (fd.required && !s) return fd.key;
    if (s && fd.int && !/^\d+$/.test(s)) return fd.key;
    if (s && fd.max && s.length > fd.max) return fd.key;
    if (s && fd.type === 'select' && !(fd.options ?? []).includes(s)) return fd.key;
  }
  return null;
}

// GET /api/cardhub/schema：返回板块/字段/渠道/有效期档位/交易方式配置
// tradeMerchants 为站长在设置中配置的推荐卡商列表（仅展示，站点不为其担保）
// admins 为「管理员审核」模式下可指定的审核人列表（仅 id/昵称，不含邮箱）
export async function getSchema(env: Env) {
  const merchantsRaw = await getSetting<unknown>(env, 'cardhub_trade_merchants', []);
  const tradeMerchants = Array.isArray(merchantsRaw)
    ? merchantsRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 10)
    : [];
  // 「站点担保」显示开关：关闭时新发布表单不提供该选项（存量帖子 trade_methods 不受影响）
  const siteGuaranteeOn = await getSetting<boolean>(env, 'cardhub_trade_site_guarantee', true);
  const tradeMethods = siteGuaranteeOn ? TRADE_METHODS : TRADE_METHODS.filter((m) => m.id !== 'site');
  const adminRows = await env.DB.prepare(
    `SELECT id, nickname FROM users WHERE role IN ('admin', 'owner') AND status = 'active' ORDER BY nickname ASC`,
  ).all<{ id: string; nickname: string | null }>();
  return {
    boards: BOARDS,
    carriers: CARRIERS,
    ttlOptions: TTL_OPTIONS,
    contactPolicies: CONTACT_POLICIES,
    tradeMethods,
    tradeMerchants,
    admins: (adminRows.results || []).map((r) => ({ id: r.id, nickname: r.nickname || '管理员' })),
  };
}
