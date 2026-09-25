/* ═══════════════════════════════════════════════════════════════
   Config 配置生成工具（ES Module 重构版）
   ───────────────────────────────────────────────────────────────
   业务逻辑与数据访问路径与原版 100% 一致：
     buildConfig / validateConfig / applyConfig / carrierStates
     数据浏览：{domain}/data/{carrier}/stats.json
              {domain}/data/{carrier}/snapshot.json
              {domain}/data/{carrier}/changelogs.json
   UI 层全部重构：玻璃拟态 + OKLCH 设计系统（shell/theme.css）、
   Tabs 侧边导航（页面内部小板块基建）、事件委托（无内联 onclick）、
   CSS tooltip、switch 开关、toast 反馈、num-ticker 数字滚动。
   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { Shell, esc, theme } from "../../shell/shell.js";
import { icon, mountIcons, Tabs, initFX } from "../../shell/ui.js";

const $ = (id) => document.getElementById(id);

/* ─────────────── 运营商预置（与原版一致） ─────────────── */
const CARRIER_PRESETS = {
  cmcc: {
    label: '移动 CMCC',
    apiBaseUrl: 'https://h.app.coc.10086.cn/website/',
    apiAppUrl: 'https://h.app.coc.10086.cn/cmcc-app/',
    apiPageUrl: 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html',
    aesKey: '1234123412ABCDEF',
    aesIv: 'ABCDEF1234123412',
    enabled: true,
    categoryIntervalMs: 8000,
    delayMin: 60,
    delayMax: 120,
  },
  cucc: {
    label: '联通 CUCC',
    apiBaseUrl: 'https://m.client.10010.com/servicequerybusiness',
    apiAppUrl: 'https://img.client.10010.com/zifeizhuanquwt/',
    apiPageUrl: 'https://img.client.10010.com/zifeizhuanquwt/index.html#/',
    aesKey: '6b8b4567327b23c6643c527d5b8c8a17', aesIv: '',
    enabled: false,
    categoryIntervalMs: 3000,
    delayMin: 30,
    delayMax: 60,
  },
  ctcc: {
    label: '电信 CTCC',
    apiBaseUrl: 'https://www.189.cn/bss/tariffZone/',
    apiAppUrl: 'https://www.189.cn/tariffZone/',
    apiPageUrl: 'https://www.189.cn/tariffZone/',
    aesKey: '', aesIv: '',
    directApiUrl: 'https://www.189.cn/wapportalweb/wapportalweb/tariffSection.do',
    directAesKey: 'telecom_wap_2018',
    directMode: 'prefer_direct',
    enabled: false,
    categoryIntervalMs: 8000,
    pageIntervalMs: 2000,
    retryTimes: 5,
    retryBaseMs: 3000,
    retryMaxMs: 60000,
    delayMin: 30,
    delayMax: 90,
  },
  cbn: {
    label: '广电 CBN',
    apiBaseUrl: 'https://m.10099.com.cn/contact-web/api',
    apiAppUrl: 'https://m.10099.com.cn/expensesNotice/',
    apiPageUrl: 'https://m.10099.com.cn/expensesNotice/#/home',
    aesKey: '', aesIv: '',
    enabled: false,
    categoryIntervalMs: 3000,
    delayMin: 30,
    delayMax: 60,
  },
};

const CARRIER_KEYS = ['cmcc', 'cucc', 'ctcc', 'cbn'];
const CARRIER_LABELS = { cmcc: '移动 CMCC', cucc: '联通 CUCC', ctcc: '电信 CTCC', cbn: '广电 CBN' };

const AES_TIPS = {
  cmcc: {
    key: '移动 CMCC：AES-CBC 加密密钥，默认 1234123412ABCDEF（16字节）',
    iv: '移动 CMCC：AES-CBC 偏移量，默认 ABCDEF1234123412（16字节）',
  },
  cucc: {
    key: '联通 CUCC：AES-ECB 加密密钥，默认 6b8b4567327b23c6643c527d5b8c8a17（32字节）。如联通更换密钥可在此修改',
    iv: '联通 CUCC：AES-ECB 模式不需要 IV，留空即可',
  },
  ctcc: {
    key: '电信 CTCC：直连模式使用 AES-ECB 加密（默认 telecom_wap_2018），Playwright 模式不需要，留空即可',
    iv: '电信 CTCC：AES-ECB 模式不需要 IV，留空即可',
  },
  cbn: {
    key: '广电 CBN：默认不需要（采用 MD5 签名，不使用 AES 加密），留空即可',
    iv: '广电 CBN：默认不需要（采用 MD5 签名，不使用 AES 加密），留空即可',
  },
};

function updateAesTips(carrierKey) {
  const tips = AES_TIPS[carrierKey] || AES_TIPS.cmcc;
  const keyTip = document.getElementById('aesKeyTip');
  const ivTip = document.getElementById('aesIvTip');
  if (keyTip) keyTip.dataset.tip = tips.key;
  if (ivTip) ivTip.dataset.tip = tips.iv;
}

const DEFAULT_CATEGORY_MAPS = {
  cmcc: {
    attr: {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
    t1: {'1': '个人资费', '2': '政企资费'},
    t2: {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
  },
  cucc: {
    attr: {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
    t1: {'1': '个人资费', '2': '政企资费'},
    t2: {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
  },
  ctcc: {
    attr: {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
    t1: {'1': '个人资费', '2': '政企资费'},
    t2: {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
  },
  cbn: {
    attr: {'1': '全网资费', '2': '本省资费', '3': '家庭资费'},
    t1: {'1': '个人资费', '2': '政企资费'},
    t2: {'1': '套餐', '2': '加装包', '3': '营销活动', '4': '其他'},
  },
};

function getDefaultCarrierState(carrierKey) {
  const p = CARRIER_PRESETS[carrierKey];
  return {
    enabled: p.enabled,
    provinces: [],
    categoryMode: 'dynamic',
    defaultProvince: 'hun',
    apiBaseUrl: p.apiBaseUrl,
    apiAppUrl: p.apiAppUrl,
    apiPageUrl: p.apiPageUrl,
    aesKey: p.aesKey,
    aesIv: p.aesIv,
    directMode: p.directMode || '',
    directApiUrl: p.directApiUrl || '',
    directAesKey: p.directAesKey || '',
    paginationMode: 'auto',
    maxPages: 5,
    pageSize: 10000,
    categoryIntervalMs: p.categoryIntervalMs,
    pageIntervalMs: 300,
    retryTimes: 3,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    retryJitter: 0.3,
    delayMin: p.delayMin,
    delayMax: p.delayMax,
    jitterRatio: 0.2,
    provinceWorkersCarrier: 0,
    volThreshold: 0.3,
    volThresholdHard: 0.7,
    degradeAutoRecoverThreshold: 0,
    notifyProvs: [],
    categoryMaps: JSON.parse(JSON.stringify(DEFAULT_CATEGORY_MAPS[carrierKey] || {attr:{},t1:{},t2:{}})),
  };
}

/* ─────────────── 模块状态（每次进入页面时重置） ─────────────── */
let carrierStates = {};
let cfgCurrentCarrier = 'cmcc';
let currentTopTab = 'global';

const CARRIER_CRAWL_FIELDS = [
  ['paginationMode', 'pagMode'],
  ['maxPages', 'maxPages', 'int'],
  ['pageSize', 'pageSize', 'int'],
  ['categoryIntervalMs', 'categoryIntervalMs', 'int'],
  ['pageIntervalMs', 'pageIntervalMs', 'int'],
  ['retryTimes', 'retryTimes', 'int'],
  ['retryBaseMs', 'retryBaseMs', 'int'],
  ['retryMaxMs', 'retryMaxMs', 'int'],
  ['retryJitter', 'retryJitter', 'float'],
  ['delayMin', 'delayMin', 'int'],
  ['delayMax', 'delayMax', 'int'],
  ['jitterRatio', 'jitterRatio', 'float'],
  ['provinceWorkersCarrier', 'carrierProvinceWorkers', 'int'],
];

/* ─────────────── 省份表（与原版一致） ─────────────── */
const PROVINCES_BASE = [
  {name:'北京市',code:'bj'},{name:'广东省',code:'gd'},{name:'江苏省',code:'js'},
  {name:'上海市',code:'sh'},{name:'天津市',code:'tj'},{name:'重庆市',code:'cq'},
  {name:'辽宁省',code:'ln'},{name:'湖北省',code:'hub'},{name:'四川省',code:'sc'},
  {name:'陕西省',code:'snx'},{name:'河北省',code:'he'},{name:'山西省',code:'sx'},
  {name:'河南省',code:'hn'},{name:'吉林省',code:'jl'},{name:'黑龙江省',code:'hlj'},
  {name:'内蒙古',code:'nmg'},{name:'浙江省',code:'zj'},{name:'安徽省',code:'ah'},
  {name:'山东省',code:'sd'},{name:'福建省',code:'fj'},{name:'江西省',code:'jx'},
  {name:'湖南省',code:'hun'},{name:'广西',code:'gx'},{name:'贵州省',code:'gz'},
  {name:'云南省',code:'yn'},{name:'海南省',code:'han'},{name:'西藏',code:'xz'},
  {name:'甘肃省',code:'gs'},{name:'青海省',code:'qh'},{name:'宁夏',code:'nx'},
  {name:'新疆',code:'xj'},
];
const CFG_CARRIER_EXTRA_PROVS = {
  cbn: [{name:'全网',code:'quanguo'},{name:'深圳',code:'sz'}],
};
function getProvincesForCarrier(carrier) {
  const extra = CFG_CARRIER_EXTRA_PROVS[carrier] || [];
  return [...PROVINCES_BASE, ...extra];
}
function validProvCodesForCarrier(carrier) {
  return new Set(getProvincesForCarrier(carrier).map(p => p.code));
}
function filterProvsForCarrier(carrier, codes) {
  const valid = validProvCodesForCarrier(carrier);
  return codes.filter(c => valid.has(c));
}
function filterDefaultProvForCarrier(carrier, code) {
  const valid = validProvCodesForCarrier(carrier);
  return valid.has(code) ? code : 'hun';
}
const PROVINCES = getProvincesForCarrier('cbn');

const PROVINCE_CODE_MAP = {};
PROVINCES.forEach(p => { PROVINCE_CODE_MAP[p.name] = p.code; });

let storageType = 'cloudflare';
let catMode = 'dynamic';
let pagMode = 'auto';
let selectedProvs = new Set();
let notifyProvs = new Set();
let DoDataTab = 'stats';
let DoDataCache = { stats: null, snapshot: null, changelogs: null, provinceList: null };

let navTabs = null;
let suppressNav = false;
let toastTimer = null;

/* ─────────────── 轻量 Toast ─────────────── */
function showToast(msg, isErr) {
  const el = $('cfgToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}

/* ─────────────── 分类映射表 ─────────────── */
function renderCatMaps(maps) {
  const data = maps || {attr:{}, t1:{}, t2:{}};
  ['attr','t1','t2'].forEach(sub => {
    const box = document.getElementById('catMaps' + sub.charAt(0).toUpperCase() + sub.slice(1) + 'Box');
    if (!box) return;
    box.innerHTML = '';
    const subData = data[sub] || {};
    Object.keys(subData).forEach(code => {
      addCatMapRow(sub, code, subData[code]);
    });
  });
}

function addCatMapRow(sub, code, label) {
  const boxId = 'catMaps' + sub.charAt(0).toUpperCase() + sub.slice(1) + 'Box';
  const box = document.getElementById(boxId);
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'catmap-row';
  row.innerHTML =
    '<input type="text" class="catmap-code" placeholder="代码" value="' + (code != null ? code : '') + '">' +
    '<input type="text" class="catmap-label" placeholder="显示名称（留空=不映射）" value="' + (label != null ? label : '') + '">' +
    '<button type="button" class="catmap-del" title="删除此行">×</button>';
  box.appendChild(row);
}

function readCatMapsFromUI() {
  const result = {attr:{}, t1:{}, t2:{}};
  ['attr','t1','t2'].forEach(sub => {
    const boxId = 'catMaps' + sub.charAt(0).toUpperCase() + sub.slice(1) + 'Box';
    const box = document.getElementById(boxId);
    if (!box) return;
    const rows = box.querySelectorAll('.catmap-row');
    rows.forEach(row => {
      const code = (row.querySelector('.catmap-code').value || '').trim();
      const label = (row.querySelector('.catmap-label').value || '').trim();
      if (code) {
        result[sub][code] = label;
      }
    });
  });
  return result;
}

/* ─────────────── 运营商状态存取（与原版一致） ─────────────── */
function saveCurrentCarrierState() {
  const carrier = cfgCurrentCarrier;
  const s = carrierStates[carrier];
  s.enabled = document.getElementById('carrierEnabled').checked;
  s.provinces = filterProvsForCarrier(carrier, [...selectedProvs]).sort();
  s.categoryMode = catMode;
  s.defaultProvince = filterDefaultProvForCarrier(carrier, document.getElementById('defaultProvince').value);
  s.apiBaseUrl = document.getElementById('apiBaseUrl').value;
  s.apiAppUrl = document.getElementById('apiAppUrl').value;
  s.apiPageUrl = document.getElementById('apiPageUrl').value;
  s.aesKey = document.getElementById('aesKey').value;
  s.aesIv = document.getElementById('aesIv').value;
  if (cfgCurrentCarrier === 'ctcc') {
    s.directMode = document.getElementById('ctccDirectMode').value;
    s.directApiUrl = document.getElementById('ctccDirectApiUrl').value;
    s.directAesKey = document.getElementById('ctccDirectAesKey').value;
  }

  CARRIER_CRAWL_FIELDS.forEach(([stateKey, elId, type]) => {
    if (stateKey === 'paginationMode') {
      s[stateKey] = pagMode;
    } else if (type === 'int') {
      s[stateKey] = parseInt(document.getElementById(elId).value) || 0;
    } else if (type === 'float') {
      s[stateKey] = parseFloat(document.getElementById(elId).value) || 0;
    }
  });

  s.volThreshold = parseFloat(document.getElementById('volThreshold').value) || 0.3;
  s.volThresholdHard = parseFloat(document.getElementById('volThresholdHard').value) || 0.7;
  s.degradeAutoRecoverThreshold = parseInt(document.getElementById('degradeAutoRecoverThreshold').value) || 0;
  s.notifyProvs = filterProvsForCarrier(carrier, [...notifyProvs]).sort();
  s.categoryMaps = readCatMapsFromUI();
}

function loadCarrierState(carrier) {
  const s = carrierStates[carrier];
  document.getElementById('carrierEnabled').checked = s.enabled;

  renderProvGrids(carrier);

  selectedProvs = new Set(filterProvsForCarrier(carrier, [...s.provinces]));
  document.querySelectorAll('#provGrid .prov-chip input').forEach(cb => {
    cb.checked = selectedProvs.has(cb.value);
    cb.parentElement.classList.toggle('selected', cb.checked);
  });

  switchCatMode(s.categoryMode);
  const dpSel = document.getElementById('defaultProvince');
  dpSel.value = filterDefaultProvForCarrier(carrier, s.defaultProvince);
  document.getElementById('apiBaseUrl').value = s.apiBaseUrl;
  document.getElementById('apiAppUrl').value = s.apiAppUrl;
  document.getElementById('apiPageUrl').value = s.apiPageUrl;
  document.getElementById('aesKey').value = s.aesKey;
  document.getElementById('aesIv').value = s.aesIv;
  updateAesTips(carrier);

  const ctccDirectSection = document.getElementById('ctccDirectSection');
  if (ctccDirectSection) {
    ctccDirectSection.style.display = carrier === 'ctcc' ? '' : 'none';
  }
  if (carrier === 'ctcc') {
    document.getElementById('ctccDirectMode').value = s.directMode || 'prefer_direct';
    document.getElementById('ctccDirectApiUrl').value = s.directApiUrl || '';
    document.getElementById('ctccDirectAesKey').value = s.directAesKey || '';
  }

  switchPagMode(s.paginationMode);
  CARRIER_CRAWL_FIELDS.forEach(([stateKey, elId, type]) => {
    if (stateKey === 'paginationMode') return;
    document.getElementById(elId).value = s[stateKey];
  });

  document.getElementById('volThreshold').value = s.volThreshold;
  document.getElementById('volThresholdHard').value = s.volThresholdHard;
  document.getElementById('degradeAutoRecoverThreshold').value = s.degradeAutoRecoverThreshold;

  notifyProvs = new Set(filterProvsForCarrier(carrier, [...s.notifyProvs]));
  document.querySelectorAll('#notifyProvGrid .prov-chip input').forEach(cb => {
    cb.checked = notifyProvs.has(cb.value);
    cb.parentElement.classList.toggle('selected', cb.checked);
  });

  renderCatMaps(s.categoryMaps);

  updateCarrierEnabledUI();
}

function updateCarrierEnabledUI() {
  const enabled = document.getElementById('carrierEnabled').checked;
  const grayCards = ['carrierConfigCard', 'carrierCrawlCard', 'carrierVolCard', 'carrierNotifyCard', 'carrierCatMapsCard'];
  grayCards.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('cfg-disabled', !enabled);
  });
}

/* ─────────────── 上下文切换（原 switchTopTab） ─────────────── */
function switchContext(tab) {
  if (currentTopTab !== 'global') {
    saveCurrentCarrierState();
  }
  if (tab !== 'global') {
    cfgCurrentCarrier = tab;
  }
  currentTopTab = tab;

  showView(tab === 'global' ? 'global' : 'carrier');

  if (tab !== 'global') {
    const label = CARRIER_PRESETS[tab].label;
    document.getElementById('carrierSectionLabel').innerHTML = '当前配置：<strong>' + esc(label) + '</strong>';
    loadCarrierState(tab);
  }

  DoDataCache = { stats: null, snapshot: null, changelogs: null, provinceList: null };
  const contentEl = document.getElementById('DoDataContent');
  if (contentEl) contentEl.innerHTML = '<div class="Dodata-empty">切换后点击「获取数据」重新加载</div>';
  const metaEl = document.getElementById('DoDataMeta');
  if (metaEl) metaEl.textContent = '';
  const provSel = document.getElementById('DoDataProvince');
  if (provSel) { provSel.innerHTML = '<option value="__all__">全部省份</option>'; }
  const carrierSel = document.getElementById('DoDataCarrier');
  if (carrierSel && tab !== 'global') { carrierSel.value = tab; }
  const dotEl = document.getElementById('dotDoData');
  if (dotEl) dotEl.className = 'status-dot';
  const statusEl = document.getElementById('DoDataStatusText');
  if (statusEl) { statusEl.textContent = '未加载'; statusEl.style.color = ''; }

  onFieldChange();
}

/* ─────────────── 侧边导航 / 视图切换 ─────────────── */
function viewIdOf(navId) {
  if (navId && navId.indexOf('c-') === 0) return 'carrier';
  return navId;
}

function showView(vid) {
  document.querySelectorAll('#configRoot .view').forEach(v => {
    v.classList.toggle('active', v.id === 'view-' + vid);
  });
}

function onNavChange(id) {
  showView(viewIdOf(id));
  if (suppressNav) return;
  if (id === 'global') switchContext('global');
  else if (id && id.indexOf('c-') === 0) switchContext(id.slice(2));
}

/* ─────────────── 省份网格 ─────────────── */
function renderProvGrids(carrier) {
  const provs = getProvincesForCarrier(carrier);

  const grid = document.getElementById('provGrid');
  grid.innerHTML = '';
  provs.forEach(p => {
    const chip = document.createElement('label');
    chip.className = 'prov-chip';
    chip.innerHTML = '<input type="checkbox" value="' + p.code + '">' + p.name;
    grid.appendChild(chip);
  });

  const ngrid = document.getElementById('notifyProvGrid');
  ngrid.innerHTML = '';
  provs.forEach(p => {
    const chip = document.createElement('label');
    chip.className = 'prov-chip';
    chip.innerHTML = '<input type="checkbox" value="' + p.code + '">' + p.name;
    ngrid.appendChild(chip);
  });

  const sel = document.getElementById('defaultProvince');
  const prevVal = sel.value;
  sel.innerHTML = '';
  provs.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.code; opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (provs.some(p => p.code === prevVal)) sel.value = prevVal;

  const hintEl = document.getElementById('provSelectHint');
  if (hintEl) {
    const count = provs.length;
    hintEl.textContent = '不选=全部' + count + '省';
  }
}

function init() {
  loadCarrierState('cmcc');
  updatePagModeNote(pagMode);
  onFieldChange();
}

function toggleProv(code, checked) {
  if (checked) selectedProvs.add(code); else selectedProvs.delete(code);
  document.querySelectorAll('#provGrid .prov-chip').forEach(chip => {
    const cb = chip.querySelector('input');
    chip.classList.toggle('selected', cb.checked);
  });
  onFieldChange();
}

function selectAllProvs() {
  getProvincesForCarrier(cfgCurrentCarrier).forEach(p => selectedProvs.add(p.code));
  document.querySelectorAll('#provGrid .prov-chip input').forEach(cb => {
    cb.checked = true;
    cb.parentElement.classList.add('selected');
  });
  onFieldChange();
}

function clearAllProvs() {
  selectedProvs.clear();
  document.querySelectorAll('#provGrid .prov-chip input').forEach(cb => {
    cb.checked = false;
    cb.parentElement.classList.remove('selected');
  });
  onFieldChange();
}

function toggleNotifyProv(code, checked) {
  if (checked) notifyProvs.add(code); else notifyProvs.delete(code);
  document.querySelectorAll('#notifyProvGrid .prov-chip').forEach(chip => {
    const cb = chip.querySelector('input');
    chip.classList.toggle('selected', cb.checked);
  });
  onFieldChange();
}

function selectAllNotifyProvs() {
  getProvincesForCarrier(cfgCurrentCarrier).forEach(p => notifyProvs.add(p.code));
  document.querySelectorAll('#notifyProvGrid .prov-chip input').forEach(cb => {
    cb.checked = true;
    cb.parentElement.classList.add('selected');
  });
  onFieldChange();
}

function clearAllNotifyProvs() {
  notifyProvs.clear();
  document.querySelectorAll('#notifyProvGrid .prov-chip input').forEach(cb => {
    cb.checked = false;
    cb.parentElement.classList.remove('selected');
  });
  onFieldChange();
}

/* ─────────────── 分段切换 ─────────────── */
function switchStorage(type) {
  storageType = type;
  document.querySelectorAll('#storageTabs .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === type);
  });
  document.querySelectorAll('.storage-panels .sub-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + type).classList.add('active');

  const typeLabels = { cloudflare: 'Cloudflare', github: 'GitHub' };
  const typeLabel = document.getElementById('dataBrowseTypeLabel');
  if (typeLabel) typeLabel.textContent = '[' + (typeLabels[type] || type) + ']';

  onFieldChange();
}

function switchCatMode(mode) {
  catMode = mode;
  document.querySelectorAll('#catModeTabs .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === mode);
  });
  onFieldChange();
}

function switchPagMode(mode) {
  pagMode = mode;
  document.querySelectorAll('#pagModeTabs .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === mode);
  });
  updatePagModeNote(mode);
  onFieldChange();
}

function updatePagModeNote(mode) {
  const el = document.getElementById('pagModeNoteText');
  const notes = {
    auto: '<strong>auto 智能翻页：</strong>先请求第1页，若返回条数 &lt; 每页条数则判定无更多数据直接结束；若返回条数 = 每页条数则可能还有数据，自动继续翻页。兼顾速度与完整性，<strong>推荐大多数场景使用</strong>。下方「最大翻页数」和「每页条数」均生效。',
    bulk: '<strong>bulk 仅取1页：</strong>只发1次请求取第1页数据，不翻页。速度最快，但若某分类实际数据量超过每页条数则会<strong>遗漏后续数据</strong>。下方「最大翻页数」不生效（始终1页），「每页条数」生效。',
    page: '<strong>page 逐页翻拉：</strong>从第1页开始逐页请求，直到返回为空或达到最大翻页数。确保不遗漏，但即使第1页数据已全部返回也会多请求1次空页。下方「最大翻页数」和「每页条数」均生效。',
  };
  el.innerHTML = notes[mode] || '';
  const maxPagesInput = document.getElementById('maxPages');
  const maxPagesGroup = maxPagesInput.closest('.fg');
  if (mode === 'bulk') {
    maxPagesInput.disabled = true;
    maxPagesGroup.classList.add('cfg-disabled');
  } else {
    maxPagesInput.disabled = false;
    maxPagesGroup.classList.remove('cfg-disabled');
  }
}

function toggleVisibility(id) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}

function toggleCarrierEnabled() {
  updateCarrierEnabledUI();
  onFieldChange();
}

/* ─────────────── 生成 / 校验（与原版一致） ─────────────── */
function buildConfig() {
  if (currentTopTab !== 'global') saveCurrentCarrierState();

  const fixedCategories = {
    cmcc: [
      {tariffAttr:'1',type1:'1',type2:'1'},{tariffAttr:'1',type1:'1',type2:'2'},
      {tariffAttr:'1',type1:'1',type2:'3'},{tariffAttr:'1',type1:'2',type2:'1'},
      {tariffAttr:'1',type1:'2',type2:'2'},{tariffAttr:'1',type1:'2',type2:'3'},
      {tariffAttr:'2',type1:'1',type2:'1'},{tariffAttr:'2',type1:'1',type2:'2'},
      {tariffAttr:'2',type1:'1',type2:'3'},{tariffAttr:'2',type1:'2',type2:'1'},
      {tariffAttr:'2',type1:'2',type2:'2'},{tariffAttr:'2',type1:'2',type2:'3'},
    ],
    cucc: [
      {tariffAttr:'1',type1:'1',type2:'1',_cucc_first:'1',_cucc_second:'1001'},
      {tariffAttr:'1',type1:'1',type2:'1',_cucc_first:'1',_cucc_second:'1002'},
      {tariffAttr:'1',type1:'1',type2:'2',_cucc_first:'2',_cucc_second:'2001'},
      {tariffAttr:'1',type1:'1',type2:'2',_cucc_first:'2',_cucc_second:'2002'},
      {tariffAttr:'1',type1:'1',type2:'3',_cucc_first:'3',_cucc_second:'3001'},
      {tariffAttr:'1',type1:'1',type2:'3',_cucc_first:'3',_cucc_second:'3002'},
    ],
    ctcc: [
      {tariffAttr:'1',type1:'1',type2:'1',_ctcc_lable1Id:'1'},
      {tariffAttr:'1',type1:'1',type2:'2',_ctcc_lable1Id:'2'},
      {tariffAttr:'1',type1:'1',type2:'3',_ctcc_lable1Id:'3'},
    ],
    cbn: [
      {tariffAttr:'1',type1:'1',type2:'1',_cbn_type1:'GZ',_cbn_type2:'',_cbn_type3:''},
      {tariffAttr:'1',type1:'2',type2:'1',_cbn_type1:'ZQ',_cbn_type2:'',_cbn_type3:''},
    ],
  };

  const carriers = {};
  CARRIER_KEYS.forEach(k => {
    const s = carrierStates[k];
    const carrier = {
      enabled: s.enabled,
      default_province: filterDefaultProvForCarrier(k, s.defaultProvince),
      provinces: filterProvsForCarrier(k, [...s.provinces]).sort(),
      category_mode: s.categoryMode,
      api: {
        base_url: s.apiBaseUrl,
        app_url: s.apiAppUrl,
        page_url: s.apiPageUrl,
        aes_key: s.aesKey,
        aes_iv: s.aesIv,
      },
      crawl: {
        pagination_mode: s.paginationMode,
        max_pages: s.maxPages,
        page_size: s.pageSize,
        category_interval_ms: s.categoryIntervalMs,
        page_interval_ms: s.pageIntervalMs,
        retry_times: s.retryTimes,
        retry_base_ms: s.retryBaseMs,
        retry_max_ms: s.retryMaxMs,
        retry_jitter: s.retryJitter,
        delay_min: s.delayMin,
        delay_max: s.delayMax,
        jitter_ratio: s.jitterRatio,
        ...(s.provinceWorkersCarrier > 0 ? { province_workers: s.provinceWorkersCarrier } : {}),
      },
      volatility: {
        threshold: s.volThreshold,
        threshold_sudden: s.volThresholdHard,
        degrade_auto_recover_threshold: s.degradeAutoRecoverThreshold,
      },
      notification: {
        provinces: filterProvsForCarrier(k, [...s.notifyProvs]).sort(),
      },
      category_maps: s.categoryMaps || {attr:{}, t1:{}, t2:{}},
    };
    if (k === 'ctcc') {
      carrier.api.direct_api_url = s.directApiUrl;
      carrier.api.direct_aes_key = s.directAesKey;
      carrier.crawl.direct_mode = s.directMode;
    }
    if (s.categoryMode === 'fixed') {
      carrier.fixed_categories = fixedCategories[k] || fixedCategories.cmcc;
    }
    carriers[k] = carrier;
  });

  const config = {
    storage: {
      type: storageType,
    },
    crawl: {
      pagination_mode: 'auto',
      max_pages: 5,
      page_size: 10000,
      category_interval_ms: 2000,
      page_interval_ms: 300,
      retry_times: 3,
      retry_base_ms: 1000,
      retry_max_ms: 30000,
      retry_jitter: 0.3,
      delay_min: 60,
      delay_max: 120,
      jitter_ratio: 0.2,
      ua_pool: (function() {
        const t = document.getElementById('globalUaPool').value.trim();
        return t ? t.split('\n').map(l => l.trim()).filter(Boolean) : [];
      })(),
    },
    volatility: {
      threshold: 0.3,
      threshold_sudden: 0.7,
    },
    schedule: {
      cron: document.getElementById('cronExpr').value,
      interval_hours: parseInt(document.getElementById('intervalHours').value) || 24,
      concurrent_carriers: document.getElementById('concurrentCarriers').checked,
      max_workers: parseInt(document.getElementById('maxWorkers').value) || 4,
      province_workers: parseInt(document.getElementById('provinceWorkers').value) || 1,
    },
    data_processing: {
      filter_test: {
        enabled: document.getElementById('filterTestEnabled').checked,
        patterns: document.getElementById('filterTestPatterns').value.split(',').map(s => s.trim()).filter(Boolean),
        exclude_patterns: document.getElementById('filterTestExcludePatterns').value.split(',').map(s => s.trim()).filter(Boolean),
      },
      html_strip_before_diff: document.getElementById('htmlStripBeforeDiff').checked,
      verify_fake_removed: {
        enabled: document.getElementById('verifyFakeRemovedEnabled').checked,
        date_field: document.getElementById('verifyFakeRemovedField').value,
        logic: document.getElementById('verifyFakeRemovedLogic').value,
        stale_online_days: parseInt(document.getElementById('verifyStaleOnlineDays').value) || 2,
      },
      structure_upgrade_detect: document.getElementById('structureUpgradeDetect').checked,
    },
    changelog: {
      retention_days: parseInt(document.getElementById('retentionDays').value) || 30,
    },
    notification: {
      types: {
        change: document.getElementById('notifyChange').checked,
        error: document.getElementById('notifyError').checked,
        degrade: document.getElementById('notifyDegrade').checked,
        all_fail: document.getElementById('notifyAllFail').checked,
        no_change: document.getElementById('notifyNoChange').checked,
      },
    },
    carriers: carriers,
    schema_version: document.getElementById('schemaVersion').value,
  };

  if (storageType === 'cloudflare') {
    config.storage.cloudflare = {
      account_id: document.getElementById('cfAccountId').value,
      project_name: document.getElementById('cfProjectName').value,
      api_token: document.getElementById('cfApiToken').value,
      domain: document.getElementById('cfDomain').value.trim(),
      path: document.getElementById('cfPath').value || 'data',
      include_frontend: document.getElementById('cfIncludeFrontend').checked,
      frontend_dir: document.getElementById('cfFrontendDir').value || './pages-dist',
    };
  } else if (storageType === 'github') {
    config.storage.github = {
      token: document.getElementById('ghToken').value,
      repo: document.getElementById('ghRepo').value,
      branch: document.getElementById('ghBranch').value || 'main',
      domain: document.getElementById('ghDomain').value.trim(),
      path: document.getElementById('ghPath').value || 'data',
      include_frontend: document.getElementById('ghIncludeFrontend').checked,
      frontend_dir: document.getElementById('ghFrontendDir').value || './pages-dist',
    };
  }
  config.storage.cache = {
    ttl_minutes: (() => { const t = parseInt(document.getElementById('cacheTtlMinutes').value); return isNaN(t) ? 30 : Math.max(0, t); })(),
  };
  config.storage.local_cache = {
    enabled: document.getElementById('localCacheEnabled').checked,
    path: document.getElementById('localCachePath').value.trim(),
  };
  config.storage.manifest_cache = {
    enabled: document.getElementById('manifestCacheEnabled').checked,
  };

  const dc = document.getElementById('defaultCarrier').value;
  if (dc) config.default_carrier = dc;

  return config;
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  const carriers = config.carriers || {};
  const enabledCarriers = Object.entries(carriers).filter(([_, c]) => c.enabled !== false);
  if (enabledCarriers.length === 0) {
    errors.push('至少需要启用一个运营商 (carriers.*.enabled)');
  }

  for (const [key, c] of enabledCarriers) {
    const api = c.api || {};
    const label = CARRIER_PRESETS[key] ? CARRIER_PRESETS[key].label : key;
    if (!api.base_url) errors.push(label + ' api.base_url 不能为空');
    if (!api.app_url) errors.push(label + ' api.app_url 不能为空');
    if (api.aes_key && api.aes_key.length !== 16 && api.aes_key.length !== 32) errors.push(label + ' api.aes_key 需为16或32字节，或留空');
    if (api.aes_iv && api.aes_iv.length !== 16) errors.push(label + ' api.aes_iv 需为16字节，或留空');
    if (c.category_mode !== 'dynamic' && c.category_mode !== 'fixed') {
      errors.push(label + ' category_mode 需为 dynamic 或 fixed');
    }
    if (c.category_mode === 'fixed' && (!Array.isArray(c.fixed_categories) || c.fixed_categories.length === 0)) {
      errors.push(label + ' category_mode=fixed 时 fixed_categories 不能为空');
    }

    const cr = c.crawl || {};
    if (cr.pagination_mode && !['auto','bulk','page'].includes(cr.pagination_mode))
      errors.push(label + ' crawl.pagination_mode 需为 auto/bulk/page');
    if (cr.max_pages < 1 || cr.max_pages > 20) errors.push(label + ' crawl.max_pages 需在1-20之间');
    if (cr.page_size < 100 || cr.page_size > 50000) errors.push(label + ' crawl.page_size 需在100-50000之间');
    if (cr.retry_times < 1 || cr.retry_times > 10) errors.push(label + ' crawl.retry_times 需在1-10之间');
    if (cr.retry_base_ms < 100) errors.push(label + ' crawl.retry_base_ms 最小100');
    if (cr.retry_max_ms < 1000) errors.push(label + ' crawl.retry_max_ms 最小1000');
    if (cr.retry_base_ms >= cr.retry_max_ms) errors.push(label + ' retry_base_ms 必须小于 retry_max_ms');
    if (cr.delay_min < 5 || cr.delay_min > 600) errors.push(label + ' crawl.delay_min 需在5-600之间');
    if (cr.delay_max < 5 || cr.delay_max > 600) errors.push(label + ' crawl.delay_max 需在5-600之间');
    if (cr.delay_min >= cr.delay_max) errors.push(label + ' delay_min 必须小于 delay_max');
    if (cr.retry_jitter < 0 || cr.retry_jitter > 1) errors.push(label + ' crawl.retry_jitter 需在0-1之间');
    if (cr.jitter_ratio < 0 || cr.jitter_ratio > 1) errors.push(label + ' crawl.jitter_ratio 需在0-1之间');

    const vol = c.volatility || {};
    if (vol.threshold < 0 || vol.threshold > 1) errors.push(label + ' volatility.threshold 需在0-1之间');
    if (vol.threshold_sudden < 0 || vol.threshold_sudden > 1) errors.push(label + ' volatility.threshold_sudden 需在0-1之间');
    if (vol.threshold >= vol.threshold_sudden) errors.push(label + ' volatility.threshold 必须小于 threshold_sudden');
    const dart = vol.degrade_auto_recover_threshold;
    if (dart != null && (!Number.isInteger(dart) || dart < 0 || dart > 20)) errors.push(label + ' volatility.degrade_auto_recover_threshold 需为0-20之间的整数');

    const notify = c.notification || {};
    if (notify.provinces && !Array.isArray(notify.provinces)) errors.push(label + ' notification.provinces 需为数组');
  }

  const st = config.storage || {};
  if (st.type !== 'cloudflare' && st.type !== 'github') {
    errors.push('storage.type 需为 cloudflare 或 github');
  }
  if (st.type === 'cloudflare') {
    const cf = st.cloudflare || {};
    if (!cf.account_id) errors.push('cloudflare account_id 不能为空');
    if (!cf.project_name) errors.push('cloudflare project_name 不能为空');
    if (!cf.api_token) errors.push('cloudflare api_token 不能为空');
    if (!cf.domain) warnings.push('cloudflare domain 未设置，将无法读取旧数据做变更对比');
  } else if (st.type === 'github') {
    const gh = st.github || {};
    if (!gh.token) errors.push('github token 不能为空');
    if (!gh.repo) errors.push('github repo 不能为空');
  }

  const sched = config.schedule || {};
  if (!sched.cron) warnings.push('schedule.cron 未设置');
  if (sched.interval_hours < 1) errors.push('schedule.interval_hours 需≥1');
  if (sched.max_workers != null && (sched.max_workers < 1 || sched.max_workers > 16)) errors.push('schedule.max_workers 需在 1-16 之间');
  if (sched.province_workers != null && (sched.province_workers < 1 || sched.province_workers > 16)) errors.push('schedule.province_workers 需在 1-16 之间');

  return { errors, warnings };
}

function applyConfig(config) {
  const st = config.storage || {};
  switchStorage(st.type || 'cloudflare');

  if (st.type === 'cloudflare') {
    const cf = st.cloudflare || {};
    document.getElementById('cfAccountId').value = cf.account_id || '';
    document.getElementById('cfProjectName').value = cf.project_name || '';
    document.getElementById('cfApiToken').value = cf.api_token || '';
    document.getElementById('cfDomain').value = cf.domain || '';
    document.getElementById('cfPath').value = cf.path || 'data';
    document.getElementById('cfFrontendDir').value = cf.frontend_dir || './pages-dist';
    document.getElementById('cfIncludeFrontend').checked = cf.include_frontend !== false;
  } else if (st.type === 'github') {
    const gh = st.github || {};
    document.getElementById('ghToken').value = gh.token || '';
    document.getElementById('ghRepo').value = gh.repo || '';
    document.getElementById('ghBranch').value = gh.branch || 'main';
    document.getElementById('ghDomain').value = gh.domain || '';
    document.getElementById('ghPath').value = gh.path || 'data';
    document.getElementById('ghFrontendDir').value = gh.frontend_dir || './pages-dist';
    document.getElementById('ghIncludeFrontend').checked = gh.include_frontend !== false;
  }

  const cache = st.cache || {};
  document.getElementById('cacheTtlMinutes').value = cache.ttl_minutes != null ? cache.ttl_minutes : 30;

  const lc = st.local_cache || {};
  document.getElementById('localCacheEnabled').checked = !!lc.enabled;
  document.getElementById('localCachePath').value = lc.path || '';

  const mc = st.manifest_cache || {};
  document.getElementById('manifestCacheEnabled').checked = mc.enabled !== false;

  document.getElementById('defaultCarrier').value = config.default_carrier || 'cmcc';

  const sched = config.schedule || {};
  document.getElementById('cronExpr').value = sched.cron || '0 8 * * *';
  document.getElementById('intervalHours').value = sched.interval_hours || 24;
  document.getElementById('concurrentCarriers').checked = !!sched.concurrent_carriers;
  document.getElementById('maxWorkers').value = sched.max_workers || 4;
  document.getElementById('provinceWorkers').value = sched.province_workers || 1;

  const dp = config.data_processing || {};
  const ft = dp.filter_test || {};
  document.getElementById('filterTestEnabled').checked = ft.enabled !== false;
  document.getElementById('filterTestPatterns').value = Array.isArray(ft.patterns) ? ft.patterns.join(', ') : '';
  document.getElementById('filterTestExcludePatterns').value = Array.isArray(ft.exclude_patterns) ? ft.exclude_patterns.join(', ') : '';
  document.getElementById('htmlStripBeforeDiff').checked = dp.html_strip_before_diff !== false;
  const vfr = dp.verify_fake_removed || {};
  document.getElementById('verifyFakeRemovedEnabled').checked = vfr.enabled !== false;
  document.getElementById('verifyFakeRemovedField').value = vfr.date_field || '下线日期';
  document.getElementById('verifyFakeRemovedLogic').value = vfr.logic || 'future_only';
  document.getElementById('verifyStaleOnlineDays').value = vfr.stale_online_days || 2;
  document.getElementById('structureUpgradeDetect').checked = dp.structure_upgrade_detect !== false;

  const gc = config.crawl || {};
  document.getElementById('globalUaPool').value = Array.isArray(gc.ua_pool) ? gc.ua_pool.join('\n') : '';

  const cl = config.changelog || {};
  document.getElementById('retentionDays').value = cl.retention_days || 30;

  const notify = config.notification || {};
  const types = notify.types || {};
  document.getElementById('notifyChange').checked = types.change !== false;
  document.getElementById('notifyError').checked = types.error !== false;
  document.getElementById('notifyDegrade').checked = types.degrade !== false;
  document.getElementById('notifyAllFail').checked = types.all_fail !== false;
  document.getElementById('notifyNoChange').checked = types.no_change !== false;

  document.getElementById('schemaVersion').value = config.schema_version || '4';

  const carriers = config.carriers || {};
  CARRIER_KEYS.forEach(k => {
    const c = carriers[k] || {};
    const p = CARRIER_PRESETS[k];
    const api = c.api || {};
    const crawl = c.crawl || {};
    const vol = c.volatility || {};
    const cnotify = c.notification || {};

    carrierStates[k] = {
      enabled: c.enabled !== undefined ? c.enabled : p.enabled,
      provinces: filterProvsForCarrier(k, Array.isArray(c.provinces) ? c.provinces : []),
      categoryMode: c.category_mode || 'dynamic',
      defaultProvince: filterDefaultProvForCarrier(k, c.default_province || 'hun'),
      apiBaseUrl: api.base_url || p.apiBaseUrl,
      apiAppUrl: api.app_url || p.apiAppUrl,
      apiPageUrl: api.page_url || p.apiPageUrl,
      aesKey: api.aes_key || p.aesKey,
      aesIv: api.aes_iv || p.aesIv,
      directMode: crawl.direct_mode || p.directMode || '',
      directApiUrl: api.direct_api_url || p.directApiUrl || '',
      directAesKey: api.direct_aes_key || p.directAesKey || '',
      paginationMode: crawl.pagination_mode || 'auto',
      maxPages: crawl.max_pages || 5,
      pageSize: crawl.page_size || 10000,
      categoryIntervalMs: crawl.category_interval_ms || p.categoryIntervalMs,
      pageIntervalMs: crawl.page_interval_ms || 300,
      retryTimes: crawl.retry_times || 3,
      retryBaseMs: crawl.retry_base_ms || 1000,
      retryMaxMs: crawl.retry_max_ms || 30000,
      retryJitter: crawl.retry_jitter != null ? crawl.retry_jitter : 0.3,
      delayMin: crawl.delay_min || p.delayMin,
      delayMax: crawl.delay_max || p.delayMax,
      jitterRatio: crawl.jitter_ratio != null ? crawl.jitter_ratio : 0.2,
      provinceWorkersCarrier: crawl.province_workers != null ? crawl.province_workers : 0,
      volThreshold: vol.threshold != null ? vol.threshold : 0.3,
      volThresholdHard: vol.threshold_sudden != null ? vol.threshold_sudden : 0.7,
      degradeAutoRecoverThreshold: vol.degrade_auto_recover_threshold != null ? vol.degrade_auto_recover_threshold : 0,
      notifyProvs: filterProvsForCarrier(k, Array.isArray(cnotify.provinces) ? cnotify.provinces : []),
      categoryMaps: (c.category_maps && typeof c.category_maps === 'object') ? {
        attr: (c.category_maps.attr && typeof c.category_maps.attr === 'object') ? c.category_maps.attr : {},
        t1: (c.category_maps.t1 && typeof c.category_maps.t1 === 'object') ? c.category_maps.t1 : {},
        t2: (c.category_maps.t2 && typeof c.category_maps.t2 === 'object') ? c.category_maps.t2 : {},
      } : JSON.parse(JSON.stringify(DEFAULT_CATEGORY_MAPS[k] || {attr:{},t1:{},t2:{}})),
    };
  });

  currentTopTab = 'global';
  cfgCurrentCarrier = 'cmcc';
  suppressNav = true;
  navTabs.activate('global');
  suppressNav = false;
  showView('global');

  onFieldChange();
}

function importConfig() {
  const text = document.getElementById('importJson').value.trim();
  if (!text) return;
  try {
    const config = JSON.parse(text);
    applyConfig(config);
    showToast('导入成功');
  } catch (e) {
    showToast('JSON 解析失败：' + e.message, true);
  }
}

async function importFromClipboard() {
  let text = '';
  try {
    text = (await navigator.clipboard.readText() || '').trim();
  } catch (e) {
    showToast('无法读取剪贴板（需 HTTPS 或 localhost 环境）', true);
    return;
  }
  if (!text) {
    showToast('剪贴板为空', true);
    return;
  }
  try {
    const config = JSON.parse(text);
    applyConfig(config);
    document.getElementById('importJson').value = text;
    showToast('已从剪贴板导入');
  } catch (e) {
    showToast('剪贴板内容不是有效 JSON：' + e.message, true);
  }
}

function resetToDefault() {
  CARRIER_KEYS.forEach(k => {
    carrierStates[k] = getDefaultCarrierState(k);
  });
  switchStorage('cloudflare');
  document.getElementById('cfAccountId').value = '';
  document.getElementById('cfProjectName').value = '';
  document.getElementById('cfApiToken').value = '';
  document.getElementById('cfDomain').value = '';
  document.getElementById('cfPath').value = 'data';
  document.getElementById('cfFrontendDir').value = './pages-dist';
  document.getElementById('cfIncludeFrontend').checked = true;
  document.getElementById('cronExpr').value = '0 8 * * *';
  document.getElementById('intervalHours').value = 24;
  document.getElementById('concurrentCarriers').checked = false;
  document.getElementById('maxWorkers').value = 4;
  document.getElementById('provinceWorkers').value = 1;
  document.getElementById('filterTestEnabled').checked = true;
  document.getElementById('filterTestPatterns').value = '测试, 作废, 废弃, 验证数据, 调试, 请勿, 请忽略, 勿参考, 不代表真实, test, demo, 样例, 示例, 内部专用, 压测, 联调';
  document.getElementById('filterTestExcludePatterns').value = '';
  document.getElementById('htmlStripBeforeDiff').checked = true;
  document.getElementById('verifyFakeRemovedEnabled').checked = true;
  document.getElementById('verifyFakeRemovedField').value = '下线日期';
  document.getElementById('verifyFakeRemovedLogic').value = 'future_only';
  document.getElementById('verifyStaleOnlineDays').value = 2;
  document.getElementById('structureUpgradeDetect').checked = true;
  document.getElementById('ctccDirectMode').value = 'prefer_direct';
  document.getElementById('ctccDirectApiUrl').value = 'https://www.189.cn/wapportalweb/wapportalweb/tariffSection.do';
  document.getElementById('ctccDirectAesKey').value = 'telecom_wap_2018';
  document.getElementById('retentionDays').value = 30;
  document.getElementById('notifyChange').checked = true;
  document.getElementById('notifyError').checked = true;
  document.getElementById('notifyDegrade').checked = true;
  document.getElementById('notifyAllFail').checked = true;
  document.getElementById('notifyNoChange').checked = true;
  document.getElementById('schemaVersion').value = '4';
  document.getElementById('cacheTtlMinutes').value = 30;
  document.getElementById('defaultCarrier').value = 'cmcc';

  currentTopTab = 'global';
  cfgCurrentCarrier = 'cmcc';
  suppressNav = true;
  navTabs.activate('global');
  suppressNav = false;
  showView('global');

  loadCarrierState('cmcc');
  onFieldChange();
  showToast('已恢复默认值');
}

function generateAndShow() {
  const config = buildConfig();
  const json = JSON.stringify(config, null, 2);
  document.getElementById('outputJson').value = json;

  const { errors, warnings } = validateConfig(config);
  const resultEl = document.getElementById('validationResult');

  updateStatusDots(errors, warnings);

  let html = '';
  if (errors.length === 0 && warnings.length === 0) {
    html = '<div class="v-ok">✓ 配置校验通过，无错误无警告</div>';
  } else {
    if (errors.length > 0) {
      html += '<div class="v-title" style="color:var(--red)">✗ 错误 (' + errors.length + '):</div>';
      html += errors.map(e => '<div class="v-err">• ' + esc(e) + '</div>').join('');
    }
    if (warnings.length > 0) {
      html += '<div class="v-title" style="color:var(--amber)">⚠ 警告 (' + warnings.length + '):</div>';
      html += warnings.map(w => '<div class="v-warn">• ' + esc(w) + '</div>').join('');
    }
  }
  resultEl.innerHTML = html;
}

function legacyCopyOutput() {
  const ta = document.getElementById('outputJson');
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
}

function generateAndCopy() {
  generateAndShow();
  const text = document.getElementById('outputJson').value;
  const done = () => showToast('已复制到剪贴板');
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => { legacyCopyOutput(); done(); });
  } else {
    legacyCopyOutput();
    done();
  }
}

function formatJson() {
  const textarea = document.getElementById('outputJson');
  try {
    const obj = JSON.parse(textarea.value);
    textarea.value = JSON.stringify(obj, null, 2);
  } catch (e) {
    showToast('当前内容不是有效 JSON，无法格式化', true);
  }
}

function updateStatusDots(errors, warnings) {
  const dotSyntax = document.getElementById('dotSyntax');
  const dotFields = document.getElementById('dotFields');
  const dotValues = document.getElementById('dotValues');
  const dotSecurity = document.getElementById('dotSecurity');

  dotSyntax.className = 'status-dot dot-ok';
  dotFields.className = 'status-dot ' + (errors.some(e => e.includes('不能为空')) ? 'dot-err' : 'dot-ok');
  dotValues.className = 'status-dot ' + (errors.some(e => !e.includes('不能为空')) ? 'dot-err' : warnings.length > 0 ? 'dot-warn' : 'dot-ok');
  dotSecurity.className = 'status-dot ' + (warnings.some(w => w.includes('domain')) ? 'dot-warn' : 'dot-ok');
}

function onFieldChange() {
  const concurrent = document.getElementById('concurrentCarriers');
  const maxWorkers = document.getElementById('maxWorkers');
  if (concurrent && maxWorkers) {
    maxWorkers.disabled = !concurrent.checked;
    maxWorkers.style.opacity = concurrent.checked ? '1' : '0.5';
  }
  const volSoft = document.getElementById('volThreshold');
  const volHard = document.getElementById('volThresholdHard');
  const errEl = document.getElementById('err_volatility');
  if (volSoft && volHard && errEl) {
    const soft = parseFloat(volSoft.value) || 0;
    const hard = parseFloat(volHard.value) || 0;
    if (hard <= soft) {
      errEl.textContent = '硬拒绝阈值必须大于软预警阈值';
      volHard.classList.add('error');
    } else {
      errEl.textContent = '';
      volHard.classList.remove('error');
    }
  }
}

/* ─────────────── 数据浏览（数据路径与原版一致） ─────────────── */
function switchDoDataTab(tab) {
  DoDataTab = tab;
  document.querySelectorAll('.Dodata-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

function onProvinceChange() {
}

function onCarrierChange() {
  DoDataCache = { stats: null, snapshot: null, changelogs: null, provinceList: null };
  const provSel = document.getElementById('DoDataProvince');
  if (provSel) { provSel.innerHTML = '<option value="__all__">全部省份</option>'; }
  fetchData();
}

async function fetchData() {
  const dotEl = document.getElementById('dotDoData');
  const statusEl = document.getElementById('DoDataStatusText');
  const contentEl = document.getElementById('DoDataContent');
  const metaEl = document.getElementById('DoDataMeta');

  dotEl.className = 'status-dot dot-warn';
  statusEl.textContent = '加载中…';
  statusEl.style.color = 'var(--amber)';
  contentEl.innerHTML = '<div class="Dodata-loading">正在获取数据…</div>';

  let domain = '';
  const st = storageType;
  if (st === 'cloudflare') {
    domain = document.getElementById('cfDomain').value.trim();
  } else {
    domain = document.getElementById('ghDomain').value.trim();
  }
  if (!domain) {
    dotEl.className = 'status-dot dot-err';
    statusEl.textContent = '域名未设置';
    statusEl.style.color = 'var(--red)';
    contentEl.innerHTML = '<div class="Dodata-error">请先填写自定义域名</div>';
    return;
  }
  if (!domain.startsWith('http')) domain = 'https://' + domain;
  const basePath = domain.replace(/\/+$/, '');

  const carrier = document.getElementById('DoDataCarrier').value;
  const carrierPath = basePath + '/data/' + carrier + '/';

  try {
    if (DoDataTab === 'stats') {
      const url = carrierPath + 'stats.json';
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      DoDataCache.stats = data;
      renderStats(data, contentEl, metaEl);
      dotEl.className = 'status-dot dot-ok';
      statusEl.textContent = '已加载';
      statusEl.style.color = 'var(--green)';
    } else if (DoDataTab === 'snapshot') {
      const url = carrierPath + 'snapshot.json';
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      DoDataCache.snapshot = data;
      renderSnapshot(data, contentEl, metaEl);
      dotEl.className = 'status-dot dot-ok';
      statusEl.textContent = '已加载';
      statusEl.style.color = 'var(--green)';
    } else if (DoDataTab === 'changelogs') {
      const url = carrierPath + 'changelogs.json';
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      DoDataCache.changelogs = data;
      renderChangelogs(data, contentEl, metaEl);
      dotEl.className = 'status-dot dot-ok';
      statusEl.textContent = '已加载';
      statusEl.style.color = 'var(--green)';
    }
  } catch (e) {
    dotEl.className = 'status-dot dot-err';
    statusEl.textContent = '加载失败';
    statusEl.style.color = 'var(--red)';
    contentEl.innerHTML = '<div class="Dodata-error">获取失败：' + esc(e.message) + '<br><span class="Dodata-err-sub">可能原因：站点未部署、域名不正确、或数据文件不存在</span></div>';
  }
}

function renderStats(data, contentEl, metaEl) {
  const carriers = data.carriers || {};
  const carrierKey = document.getElementById('DoDataCarrier').value;
  const carrierLabel = CARRIER_LABELS[carrierKey] || carrierKey;
  const cd = carriers[carrierKey] || data;
  const total = cd.total_tariffs || 0;
  const provinces = cd.provinces || {};
  const provCount = Object.keys(provinces).length;
  const lastTime = data.last_crawl_time || '';

  if (metaEl) metaEl.textContent = '运营商: ' + carrierLabel + ' | 省份: ' + provCount + ' | 套餐: ' + total;

  let html = '<div class="Dodata-stats-grid">';
  html += '<div class="Dd-stat tilt accent"><div class="val"><num-ticker value="' + total + '">0</num-ticker></div><div class="label">总套餐数</div></div>';
  html += '<div class="Dd-stat tilt success"><div class="val"><num-ticker value="' + provCount + '">0</num-ticker></div><div class="label">省份数</div></div>';
  html += '<div class="Dd-stat tilt"><div class="val time">' + esc(lastTime.substring(0, 19).replace('T', ' ')) + '</div><div class="label">最后采集</div></div>';
  html += '</div>';

  if (provCount > 0) {
    html += '<div class="table-wrap"><table class="table"><thead><tr><th>省份</th><th>套餐数</th><th>最后更新</th></tr></thead><tbody>';
    const provSel = document.getElementById('DoDataProvince').value;
    Object.entries(provinces).forEach(([code, info]) => {
      if (provSel !== '__all__' && code !== provSel) return;
      const name = PROVINCES.find(p => p.code === code)?.name || code;
      html += '<tr><td>' + esc(name) + '</td><td>' + (info.count || 0) + '</td><td>' + esc((info.last_update || '').substring(0, 19).replace('T', ' ')) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  contentEl.innerHTML = html;

  const provSelEl = document.getElementById('DoDataProvince');
  if (provSelEl && provSelEl.options.length <= 1) {
    Object.keys(provinces).sort().forEach(code => {
      const name = PROVINCES.find(p => p.code === code)?.name || code;
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = name;
      provSelEl.appendChild(opt);
    });
  }
}

function renderSnapshot(data, contentEl, metaEl) {
  const carrierKey = document.getElementById('DoDataCarrier').value;
  const carrierLabel = CARRIER_LABELS[carrierKey] || carrierKey;
  const provinces = data.provinces || {};
  const provCount = Object.keys(provinces).length;
  let totalTariffs = 0;
  Object.values(provinces).forEach(p => { totalTariffs += (p.tariffs || []).length; });

  if (metaEl) metaEl.textContent = '运营商: ' + carrierLabel + ' | 省份: ' + provCount + ' | 套餐: ' + totalTariffs + ' | 时间: ' + (data.timestamp || '').substring(0, 19).replace('T', ' ');

  const provSel = document.getElementById('DoDataProvince').value;
  let html = '';
  Object.entries(provinces).forEach(([code, info]) => {
    if (provSel !== '__all__' && code !== provSel) return;
    const name = PROVINCES.find(p => p.code === code)?.name || code;
    const tariffs = info.tariffs || [];
    html += '<div class="Dd-prov"><div class="Dd-prov-name">' + esc(name) + ' <span class="Dd-prov-count">(' + tariffs.length + '条)</span></div><div class="Dd-prov-time">更新: ' + esc((info.timestamp || '').substring(0, 19).replace('T', ' ')) + '</div></div>';
  });

  if (!html) html = '<div class="Dodata-empty">无数据</div>';
  html += '<div class="Dodata-raw-toggle">展开原始数据</div>';
  html += '<div class="Dodata-raw">' + esc(JSON.stringify(data, null, 2)) + '</div>';

  contentEl.innerHTML = html;
}

function renderChangelogs(data, contentEl, metaEl) {
  const carrierKey = document.getElementById('DoDataCarrier').value;
  const carrierLabel = CARRIER_LABELS[carrierKey] || carrierKey;
  const logs = Array.isArray(data) ? data : (data.changelogs || []);
  if (metaEl) metaEl.textContent = '运营商: ' + carrierLabel + ' | 变更记录: ' + logs.length + ' 条';

  const provSel = document.getElementById('DoDataProvince').value;
  let html = '';
  logs.forEach(log => {
    const prov = log.province || '';
    if (provSel !== '__all__' && prov !== provSel) return;
    const time = (log.timestamp || '').substring(0, 19).replace('T', ' ');
    const changes = log.changes || [];
    html += '<div class="Dodata-changelog-item">';
    html += '<div class="cl-header"><span class="cl-time">' + esc(time) + '</span><span class="cl-prov">' + esc(PROVINCES.find(p => p.code === prov)?.name || prov) + '</span></div>';
    changes.forEach(ch => {
      const type = ch.type || 'changed';
      const typeLabel = { added: '新增', removed: '下架', changed: '变更' }[type] || type;
      html += '<div class="cl-row"><span class="cl-type ' + type + '">' + typeLabel + '</span> <span class="cl-name">' + esc(ch.name || '') + '</span></div>';
    });
    html += '</div>';
  });

  if (!html) html = '<div class="Dodata-empty">无变更记录</div>';

  contentEl.innerHTML = html;
}

/* ─────────────── 事件委托 ─────────────── */
function onRootClick(e) {
  const t = e.target;
  const root = document.getElementById('configRoot');
  if (!root) return;

  const actEl = t.closest("[data-act]");
  if (actEl && root.contains(actEl)) {
    const act = actEl.dataset.act;
    if (act === "goBack") { Shell.navigate("/"); return; }
    if (act === "toggleTheme") { initCfgTheme(true); return; }
    if (act === "switch-storage") { switchStorage(actEl.dataset.val); return; }
    if (act === "switch-catmode") { switchCatMode(actEl.dataset.val); return; }
    if (act === "switch-pagmode") { switchPagMode(actEl.dataset.val); return; }
    if (act === "prov-all") { selectAllProvs(); return; }
    if (act === "prov-none") { clearAllProvs(); return; }
    if (act === "notify-all") { selectAllNotifyProvs(); return; }
    if (act === "notify-none") { clearAllNotifyProvs(); return; }
    if (act === "toggle-visibility") { toggleVisibility(actEl.dataset.target); return; }
    if (act === "add-catmap") { addCatMapRow(actEl.dataset.sub); return; }
    if (act === "import-config") { importConfig(); return; }
    if (act === "import-clipboard") { importFromClipboard(); return; }
    if (act === "reset-default") { resetToDefault(); return; }
    if (act === "generate") { generateAndShow(); return; }
    if (act === "generate-copy") { generateAndCopy(); return; }
    if (act === "format-json") { formatJson(); return; }
    if (act === "fetch-dodata") { fetchData(); return; }
    if (act === "dodata-tab") { switchDoDataTab(actEl.dataset.tab); return; }
  }

  const del = t.closest(".catmap-del");
  if (del) {
    const row = del.closest(".catmap-row");
    if (row) row.remove();
    return;
  }

  const rawTg = t.closest(".Dodata-raw-toggle");
  if (rawTg) {
    const raw = rawTg.nextElementSibling;
    if (raw) {
      raw.classList.toggle("show");
      rawTg.textContent = raw.classList.contains("show") ? "收起原始数据" : "展开原始数据";
    }
    return;
  }

  if (t.closest("#cfgHamburger")) { openCfgSidebar(); return; }
  if (t.closest("#cfgSidebarClose") || t.closest("#cfgSidebarOverlay")) { closeCfgSidebar(); return; }
}

function onRootChange(e) {
  const t = e.target;
  if (t.matches("#provGrid input[type=checkbox]")) { toggleProv(t.value, t.checked); return; }
  if (t.matches("#notifyProvGrid input[type=checkbox]")) { toggleNotifyProv(t.value, t.checked); return; }
  if (t.id === "carrierEnabled") { toggleCarrierEnabled(); return; }
  if (t.id === "DoDataCarrier") { onCarrierChange(); return; }
  if (t.id === "DoDataProvince") { onProvinceChange(); return; }
  onFieldChange();
}

function onRootInput() {
  onFieldChange();
}

/* ─────────────── 主题 / 侧栏 ─────────────── */
function initCfgTheme(toggle) {
  const btn = document.getElementById("cfgThemeBtn");
  if (!btn) return;
  if (toggle) theme.toggle();
  const dark = theme.get() === "dark";
  btn.innerHTML = icon(dark ? "sun" : "moon");
  btn.title = dark ? "切换为亮色" : "切换为暗色";
}

function openCfgSidebar() {
  const sb = document.getElementById("cfgSidebar");
  const ov = document.getElementById("cfgSidebarOverlay");
  if (sb) sb.classList.add("open");
  if (ov) ov.classList.add("show");
}

function closeCfgSidebar() {
  const sb = document.getElementById("cfgSidebar");
  const ov = document.getElementById("cfgSidebarOverlay");
  if (sb) sb.classList.remove("open");
  if (ov) ov.classList.remove("show");
}

function bindEvents() {
  const root = document.getElementById("configRoot");
  root.addEventListener("click", onRootClick);
  root.addEventListener("input", onRootInput);
  root.addEventListener("change", onRootChange);
}

/* ─────────────── 页面注册 ─────────────── */
Shell.registerPage({
  id: "config",
  route: "/config",
  onEnter: function (root) {
    if (!document.querySelector('link[data-module="config"]')) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = Shell.config.base + "modules/config/style.css";
      link.setAttribute("data-module", "config");
      document.head.appendChild(link);
    }

    /* 重置模块状态（等价于原版每次进入重新执行脚本） */
    CARRIER_KEYS.forEach(k => { carrierStates[k] = getDefaultCarrierState(k); });
    cfgCurrentCarrier = "cmcc";
    currentTopTab = "global";
    storageType = "cloudflare";
    catMode = "dynamic";
    pagMode = "auto";
    selectedProvs = new Set();
    notifyProvs = new Set();
    DoDataTab = "stats";
    DoDataCache = { stats: null, snapshot: null, changelogs: null, provinceList: null };

    root.innerHTML = `
<div id="configRoot">
<header class="cfg-topbar">
  <div class="cfg-brand">
    <button class="icon-btn cfg-hamburger" id="cfgHamburger" aria-label="菜单"><i data-icon="menu"></i></button>
    <button class="icon-btn" data-act="goBack" title="返回监控面板"><i data-icon="back"></i></button>
    <div class="cfg-brand-logo"><i data-icon="sliders"></i></div>
    <div class="cfg-brand-text">配置生成工具</div>
  </div>
  <div class="cfg-topbar-status">
    <div class="status-pill"><span class="status-dot dot-ok" id="dotSyntax"></span>语法</div>
    <div class="status-pill"><span class="status-dot dot-ok" id="dotFields"></span>字段</div>
    <div class="status-pill"><span class="status-dot dot-ok" id="dotValues"></span>取值</div>
    <div class="status-pill"><span class="status-dot dot-ok" id="dotSecurity"></span>安全</div>
  </div>
  <div class="cfg-topbar-actions">
    <button class="icon-btn" id="cfgThemeBtn" data-act="toggleTheme" title="切换主题"></button>
  </div>
</header>

<div class="cfg-layout">
  <div class="cfg-sidebar-overlay" id="cfgSidebarOverlay"></div>
  <nav class="cfg-sidebar" id="cfgSidebar">
    <div class="cfg-sidebar-head"><span>导航</span><button class="icon-btn" id="cfgSidebarClose"><i data-icon="x"></i></button></div>
    <div id="configNav">
      <button type="button" class="nav-item active" data-view="global"><div class="nav-icon"><i data-icon="sliders"></i></div><span>全局配置</span></button>
      <div class="sidebar-divider"></div>
      <button type="button" class="nav-item" data-view="c-cmcc"><div class="nav-icon">移</div><span>移动 CMCC</span></button>
      <button type="button" class="nav-item" data-view="c-cucc"><div class="nav-icon">联</div><span>联通 CUCC</span></button>
      <button type="button" class="nav-item" data-view="c-ctcc"><div class="nav-icon">电</div><span>电信 CTCC</span></button>
      <button type="button" class="nav-item" data-view="c-cbn"><div class="nav-icon">广</div><span>广电 CBN</span></button>
      <div class="sidebar-divider"></div>
      <button type="button" class="nav-item" data-view="dodata"><div class="nav-icon"><i data-icon="database"></i></div><span>数据浏览</span></button>
      <button type="button" class="nav-item" data-view="output"><div class="nav-icon"><i data-icon="code"></i></div><span>生成结果</span></button>
    </div>
  </nav>

  <main class="cfg-content">

  <!-- ═══════════ 全局配置 ═══════════ -->
  <section id="view-global" class="view active">

    <div class="panel rise" style="--i:0">
      <h2 class="panel-title"><span class="p-icon io"><i data-icon="package"></i></span>导入已有配置 <span class="panel-sub">粘贴 JSON 覆盖表单值</span></h2>
      <textarea id="importJson" rows="4" placeholder="粘贴已有 JSON 配置，点击「导入」覆盖表单值"></textarea>
      <div class="btn-row">
        <button class="btn ghost" data-act="import-config"><i data-icon="check"></i>导入配置</button>
        <button class="btn ghost" data-act="import-clipboard"><i data-icon="copy"></i>从剪贴板导入</button>
        <button class="btn ghost" data-act="reset-default"><i data-icon="refresh"></i>恢复默认值</button>
      </div>
    </div>

    <div class="panel rise" style="--i:1">
      <h2 class="panel-title"><span class="p-icon storage"><i data-icon="database"></i></span>存储配置</h2>
      <div class="fg">
        <label>存储类型</label>
        <div class="seg" id="storageTabs">
          <button type="button" class="seg-btn active" data-act="switch-storage" data-val="cloudflare">Cloudflare Pages</button>
          <button type="button" class="seg-btn" data-act="switch-storage" data-val="github">GitHub Pages</button>
        </div>
      </div>
      <div class="storage-panels">
        <div class="sub-panel active" id="panel-cloudflare">
          <div class="fg"><label>Account ID <span class="hint">(Cloudflare 账户ID，Dashboard 右侧栏可见)</span></label><input type="text" id="cfAccountId" placeholder="32位十六进制字符串"></div>
          <div class="fg"><label>Pages 项目名 <span class="hint">(不存在时脚本自动创建)</span></label><input type="text" id="cfProjectName" placeholder="如 cmcc-tariff-monitor"></div>
          <div class="fg"><label>API Token <span class="hint">(需 Cloudflare Pages 编辑权限)</span></label>
            <div class="pw-wrap"><input type="password" id="cfApiToken"><button type="button" class="icon-btn pw-eye" data-act="toggle-visibility" data-target="cfApiToken" title="显示/隐藏"><i data-icon="eye"></i></button></div>
          </div>
          <div class="fg"><label>自定义域名 <span class="hint">(必填，如 https://tariff.example.com；用于读取已部署旧数据做变更对比)</span></label><input type="text" id="cfDomain" placeholder="https://tariff.example.com"></div>
          <div class="f-row">
            <div class="fg"><label>数据路径 <span class="hint">(站点内目录)</span></label><input type="text" id="cfPath" value="data"></div>
            <div class="fg"><label>前端目录 <span class="hint">(本地 pages-dist 路径)</span></label><input type="text" id="cfFrontendDir" value="./pages-dist"></div>
          </div>
          <label class="ck-row"><input type="checkbox" class="switch" id="cfIncludeFrontend" checked><span>联合部署前端 <span class="hint">(每次采集时把前端文件一并部署到 Pages，全量替换)</span></span></label>
        </div>
        <div class="sub-panel" id="panel-github">
          <div class="fg"><label>GitHub Token <span class="hint">(需 repo 权限)</span></label>
            <div class="pw-wrap"><input type="password" id="ghToken"><button type="button" class="icon-btn pw-eye" data-act="toggle-visibility" data-target="ghToken" title="显示/隐藏"><i data-icon="eye"></i></button></div>
          </div>
          <div class="f-row">
            <div class="fg"><label>仓库 <span class="hint">(owner/repo)</span></label><input type="text" id="ghRepo" placeholder="user/data-repo"></div>
            <div class="fg"><label>分支</label><input type="text" id="ghBranch" value="main"></div>
          </div>
          <div class="fg"><label>GitHub Pages 域名 <span class="hint">(自定义域名，留空则用 https://owner.github.io/repo 读取旧数据)</span></label><input type="text" id="ghDomain" placeholder="https://user.github.io/repo"></div>
          <div class="f-row">
            <div class="fg"><label>数据路径 <span class="hint">(仓库内目录)</span></label><input type="text" id="ghPath" value="data"></div>
            <div class="fg"><label>前端目录 <span class="hint">(本地 pages-dist 路径)</span></label><input type="text" id="ghFrontendDir" value="./pages-dist"></div>
          </div>
          <label class="ck-row"><input type="checkbox" class="switch" id="ghIncludeFrontend" checked><span>联合部署前端 <span class="hint">(每次采集时把前端文件一并提交到仓库，增量不删除)</span></span></label>
        </div>
      </div>
    </div>

    <div class="panel rise" style="--i:2">
      <h2 class="panel-title"><span class="p-icon sched"><i data-icon="clock"></i></span>调度配置 <span class="panel-sub">(仅用于计算 next_crawl_time，实际调度由青龙 cron 控制)</span></h2>
      <div class="f-row">
        <div class="fg"><label>Cron 表达式 <span class="hint">(展示用)</span></label><input type="text" id="cronExpr" value="0 8 * * *"></div>
        <div class="fg"><label>采集间隔(小时) <span class="hint">(≥1)</span></label><input type="number" id="intervalHours" value="24" min="1"></div>
      </div>
      <div class="cfg-hr"></div>
      <div class="f-row">
        <div class="fg">
          <label>运营商并发采集<span class="help" data-tip="开启后，启用的运营商将同时并行采集（各运营商使用独立的存储实例和请求会话，互不干扰）。关闭时各运营商依次串行采集。并发可显著缩短总耗时，但会同时占用更多网络和CPU资源。">?</span></label>
          <label class="ck-row"><input type="checkbox" class="switch" id="concurrentCarriers"><span>开启运营商并发采集</span></label>
        </div>
        <div class="fg"><label>最大并发线程数 <span class="hint">(1-16, 通常=启用的运营商数量)</span><span class="help" data-tip="并发采集时的最大线程数。建议设为启用的运营商数量（如启用4家则设4）。过大不会进一步提速，反而增加资源占用。">?</span></label><input type="number" id="maxWorkers" value="4" min="1" max="16"></div>
        <div class="fg"><label>省份并发度 <span class="hint">(1=串行, 建议3-5, 全局默认)</span><span class="help" data-tip="全局默认的省份并发线程数，所有未单独覆盖的运营商使用此值。1=串行；3-5=并发。可在各运营商页签的「省份并发度覆盖」里按风控松紧单独设置（如移动4、联通2）。电信Playwright回退省份始终串行。">?</span></label><input type="number" id="provinceWorkers" value="1" min="1" max="16"></div>
      </div>
    </div>

    <div class="panel rise" style="--i:3">
      <h2 class="panel-title"><span class="p-icon ua"><i data-icon="user"></i></span>UA 指纹池 <span class="panel-sub">(全局，所有运营商 HTTP 请求共用)</span></h2>
      <div class="fg">
        <label>自定义 UA 列表<span class="help" data-tip="每行一个 User-Agent 字符串。为空则使用内置 60 个指纹池（覆盖 Samsung/Huawei/Xiaomi/OPPO/vivo/Pixel/OnePlus/Honor/Realme/iPhone）。轮换策略：全局递增取模，线程安全。适用于移动/联通/广电/电信直连的 HTTP 请求；电信 Playwright 路径由浏览器自身管理 UA，不受此影响。">?</span></label>
        <textarea id="globalUaPool" rows="6" placeholder="留空 = 使用内置 60 个 UA 指纹池&#10;示例：&#10;Mozilla/5.0 (Linux; Android 13; ...) ...&#10;Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 ...) ..."></textarea>
      </div>
    </div>

    <div class="panel rise" style="--i:4">
      <h2 class="panel-title"><span class="p-icon bell"><i data-icon="bell"></i></span>通知类型开关 <span class="panel-sub">(全局，所有运营商共用)</span></h2>
      <label><span class="panel-sub">控制各类通知的发送开关。关闭后该类通知不再推送，但采集和对比逻辑不受影响。致命错误通知不受此控制，始终发送。</span></label>
      <div class="ck-grid">
        <label class="ck-row"><input type="checkbox" class="switch" id="notifyChange" checked><span>变更通知</span></label>
        <label class="ck-row"><input type="checkbox" class="switch" id="notifyError" checked><span>异常提醒</span></label>
        <label class="ck-row"><input type="checkbox" class="switch" id="notifyDegrade" checked><span>降级提醒</span></label>
        <label class="ck-row"><input type="checkbox" class="switch" id="notifyAllFail" checked><span>全部失败</span></label>
        <label class="ck-row"><input type="checkbox" class="switch" id="notifyNoChange" checked><span>无变化</span></label>
      </div>
    </div>

    <div class="panel rise" style="--i:5">
      <h2 class="panel-title"><span class="p-icon filter"><i data-icon="filter"></i></span>数据处理</h2>
      <label class="ck-row"><input type="checkbox" class="switch" id="filterTestEnabled" checked><span>启用测试数据过滤<span class="hint">过滤官方混入的测试/作废/验证数据，避免其被当作真实变更写入 changelog 并推送通知</span></span></label>
      <div class="f-row" style="margin-top:10px">
        <div class="fg"><label>过滤关键词<span class="help" data-tip="标题包含任一关键词的条目将被过滤。多个词用英文逗号分隔。默认值经过实测验证，误伤率极低。">?</span></label><input type="text" id="filterTestPatterns" value="测试, 作废, 废弃, 验证数据, 调试, 请勿, 请忽略, 勿参考, 不代表真实, test, demo, 样例, 示例, 内部专用, 压测, 联调"></div>
        <div class="fg"><label>过滤排除词<span class="help" data-tip="标题包含排除词的条目不会被过滤（即使同时包含过滤词）。多个词用英文逗号分隔。默认为空。示例：试用, 体验">?</span></label><input type="text" id="filterTestExcludePatterns" value="" placeholder="试用, 体验"></div>
      </div>
      <div class="cfg-hr"></div>
      <label class="ck-row"><input type="checkbox" class="switch" id="htmlStripBeforeDiff" checked><span>Diff 前剥离 HTML 标签<span class="hint">对比新旧数据时先剥离 &lt;br/&gt;、&lt;p&gt;、&amp;nbsp; 等标签和实体，避免格式差异产生假修改告警</span></span></label>
      <div class="cfg-hr"></div>
      <label class="ck-row"><input type="checkbox" class="switch" id="verifyFakeRemovedEnabled" checked><span>假下架核验（下线日期防护）<span class="hint">逐条检查被判下架的业务「下线日期」字段：日期在未来 → 判定为假下架并剔除，不写入 changelog</span></span></label>
      <div class="f-row" style="margin-top:10px">
        <div class="fg"><label>核验字段<span class="help" data-tip="用哪个字段判定是否仍在售。默认「下线日期」，也可选「有效期限」。">?</span></label>
          <select id="verifyFakeRemovedField"><option value="下线日期">下线日期</option><option value="有效期限">有效期限</option></select>
        </div>
        <div class="fg"><label>核验逻辑<span class="help" data-tip="仅未来日期：只拦「日期在未来」的假下架（最保守，推荐）；含今天：拦「日期≥今天」的；关闭核验：不核验，全部按真下架报（不信任官方日期时选此项）。">?</span></label>
          <select id="verifyFakeRemovedLogic"><option value="future_only">仅未来日期（保守）</option><option value="future_and_today">含今天（中等）</option><option value="disabled">关闭核验（不信任日期）</option></select>
        </div>
        <div class="fg"><label>补录兜底天数<span class="help" data-tip="无基线时刻时，上线日期早于今日 N 天以上判定为漏采补录并剔除。默认 2 天。">?</span></label><input type="number" id="verifyStaleOnlineDays" value="2" min="1" max="30"></div>
      </div>
      <div class="cfg-hr"></div>
      <label class="ck-row"><input type="checkbox" class="switch" id="structureUpgradeDetect" checked><span>字段结构升级检测<span class="hint">当新旧快照的字段键集合不一致时（如 FIELD_KEYS 新增字段），抑制全量 modified 误报，保留真实的 added/removed</span></span></label>
    </div>

    <div class="panel rise" style="--i:6">
      <h2 class="panel-title"><span class="p-icon other"><i data-icon="box"></i></span>其他配置</h2>
      <div class="f-row">
        <div class="fg"><label>变更日志保留天数<span class="help" data-tip="变更日志(changelog)的保留天数。超过此天数的日志条目将在每次采集时自动清理。值越大历史记录越全，但存储占用也越大。">?</span></label><input type="number" id="retentionDays" value="30" min="1" max="365"></div>
        <div class="fg"><label>Schema 版本</label><input type="text" id="schemaVersion" value="4"></div>
      </div>
      <div class="cfg-hr"></div>
      <div class="fg"><label>浏览器缓存时长（分钟） <span class="hint">(0=不缓存，默认30分钟；写入 stats.json 的 cache.ttl_minutes，前端读取后生效)</span></label><input type="number" id="cacheTtlMinutes" value="30" min="0"></div>
      <div class="cfg-hr"></div>
      <label class="ck-row"><input type="checkbox" class="switch" id="localCacheEnabled"><span>启用采集端本地缓存 <span class="hint">(开启后 read_json 优先读取本地文件，未命中再请求网络；write_json 时同步写入本地，减少网络请求)</span></span></label>
      <div class="fg" style="margin-top:10px"><label>本地缓存目录 <span class="hint">(留空则使用脚本所在目录下的 local_cache 子目录)</span></label><input type="text" id="localCachePath" value="" placeholder="./local_cache"></div>
      <label class="ck-row"><input type="checkbox" class="switch" id="manifestCacheEnabled" checked><span>启用部署 manifest 缓存 <span class="hint">(开启后 --deploy-frontend / --rebuild-stats 模式优先从本地 manifest 缓存读取文件哈希，跳过未变更文件的网络下载；默认开启)</span></span></label>
      <div class="cfg-hr"></div>
      <div class="fg"><label>默认运营商 <span class="hint">(写入 stats.json 的 default_carrier；前端无本地缓存时优先显示该运营商)</span></label>
        <select id="defaultCarrier">
          <option value="cmcc">中国移动</option>
          <option value="cucc">中国联通</option>
          <option value="ctcc">中国电信</option>
          <option value="cbn">中国广电</option>
        </select>
      </div>
    </div>

  </section>

  <!-- ═══════════ 运营商配置（共用 DOM，切换时更新内容） ═══════════ -->
  <section id="view-carrier" class="view">

    <p class="carrier-section-label" id="carrierSectionLabel">当前配置：<strong>移动 CMCC</strong></p>

    <div class="panel rise">
      <h2 class="panel-title"><span class="p-icon api"><i data-icon="link"></i></span>启用与 API</h2>
      <label class="ck-row"><input type="checkbox" class="switch" id="carrierEnabled" checked><span>启用该运营商 <span class="hint">(取消后该运营商不参与采集)</span></span></label>
      <div class="f-row" style="margin-top:10px">
        <div class="fg"><label>基础URL</label><input type="text" id="apiBaseUrl" value=""></div>
        <div class="fg"><label>应用URL</label><input type="text" id="apiAppUrl" value=""></div>
      </div>
      <div class="fg"><label>页面URL</label><input type="text" id="apiPageUrl" value=""></div>
      <div class="f-row">
        <div class="fg"><label>AES Key <span class="hint">(16/32字节)</span><span class="help" id="aesKeyTip" data-tip="">?</span></label><input type="text" id="aesKey" value=""></div>
        <div class="fg"><label>AES IV <span class="hint">(16字节)</span><span class="help" id="aesIvTip" data-tip="">?</span></label><input type="text" id="aesIv" value=""></div>
      </div>
      <p class="aes-note">⚠️ AES Key/IV 为运营商官网前端公开的通信参数，非密钥，用于请求体加解密</p>
    </div>

    <div class="panel rise" id="ctccDirectSection" style="display:none">
      <h2 class="panel-title"><span class="p-icon direct"><i data-icon="zap"></i></span>电信直连配置</h2>
      <div class="fg"><label>采集模式<span class="help" data-tip="优先直连：先尝试 AES-ECB 直连 tariffSection.do，失败则回退 Playwright 浏览器。仅直连：只用直连，失败不回退。仅 Playwright：只用浏览器，不尝试直连。">?</span></label>
        <select id="ctccDirectMode">
          <option value="prefer_direct">优先直连（失败回退 Playwright）</option>
          <option value="direct_only">仅直连（不回退）</option>
          <option value="playwright_only">仅 Playwright（不直连）</option>
        </select>
      </div>
      <div class="f-row">
        <div class="fg"><label>直连 API 端点 <span class="hint">(tariffSection.do 地址)</span></label><input type="text" id="ctccDirectApiUrl" value="https://www.189.cn/wapportalweb/wapportalweb/tariffSection.do"></div>
        <div class="fg"><label>直连 AES 密钥 <span class="hint">(AES-ECB key)</span></label><input type="text" id="ctccDirectAesKey" value="telecom_wap_2018"></div>
      </div>
    </div>

    <div class="panel rise" id="carrierConfigCard">
      <h2 class="panel-title"><span class="p-icon crawl"><i data-icon="map"></i></span>采集策略</h2>
      <div class="fg">
        <label>目标省份 <span class="hint">(<span id="provSelectHint">不选=全部31省</span>)</span>
          <button type="button" class="link-btn" data-act="prov-all">全选</button>
          <button type="button" class="link-btn" data-act="prov-none">清空</button>
        </label>
        <div class="prov-grid" id="provGrid"></div>
      </div>
      <div class="cfg-hr"></div>
      <div class="fg">
        <label>分类获取模式<span class="help" data-tip="动态：调用API获取分类列表，覆盖更全但有额外请求。固定：使用预设的6大类（个人3+政企3），省去分类列表请求，速度更快。">?</span></label>
        <div class="seg" id="catModeTabs">
          <button type="button" class="seg-btn active" data-act="switch-catmode" data-val="dynamic">动态 (getType2List)</button>
          <button type="button" class="seg-btn" data-act="switch-catmode" data-val="fixed">固定 (6大类, 仅个人+政企)</button>
        </div>
      </div>
      <div class="cfg-hr"></div>
      <div class="fg"><label>默认省份</label>
        <select id="defaultProvince"></select>
      </div>
    </div>

    <div class="panel rise" id="carrierCrawlCard">
      <h2 class="panel-title"><span class="p-icon repeat"><i data-icon="repeat"></i></span>请求控制</h2>
      <div class="fg">
        <label>分页策略<span class="help" data-tip="auto：先尝试bulk(1页)，若结果数≥page_size则自动切换逐页翻拉。bulk：仅取1页，适合数据量小的分类。page：始终逐页翻拉，适合已知数据量大的场景。">?</span></label>
        <div class="seg" id="pagModeTabs">
          <button type="button" class="seg-btn active" data-act="switch-pagmode" data-val="auto">auto (智能翻页)</button>
          <button type="button" class="seg-btn" data-act="switch-pagmode" data-val="bulk">bulk (仅1页)</button>
          <button type="button" class="seg-btn" data-act="switch-pagmode" data-val="page">page (逐页翻拉)</button>
        </div>
        <div class="strategy-note"><span class="note-icon">!</span><span class="note-text" id="pagModeNoteText"></span></div>
      </div>
      <div class="f-row">
        <div class="fg"><label>最大翻页数 <span class="hint">(1-20)</span><span class="help" data-tip="逐页翻拉模式下的最大翻页次数。防止某些分类数据异常膨胀导致无限翻页。达到此上限后停止翻页，使用已获取的数据。">?</span></label><input type="number" id="maxPages" value="5" min="1" max="20"></div>
        <div class="fg"><label>每页条数 <span class="hint">(100-50000)</span><span class="help" data-tip="单次API请求返回的套餐条数。值越大请求越少但单次响应越慢，值越小请求越多但更稳定。10000是移动API的常见上限。">?</span></label><input type="number" id="pageSize" value="10000" min="100" max="50000"></div>
      </div>
      <div class="cfg-hr"></div>
      <div class="f-row">
        <div class="fg"><label>分类间间隔(ms) <span class="hint">(100-30000)</span><span class="help" data-tip="同一省份内，两个分类请求之间的等待时间。适当增大可降低被限流/封禁的风险，但会增加总采集耗时。">?</span></label><input type="number" id="categoryIntervalMs" value="8000" min="100" max="30000"></div>
        <div class="fg"><label>翻页间间隔(ms) <span class="hint">(50-10000)</span><span class="help" data-tip="同一分类内，两次翻页请求之间的等待时间。通常可设较小值，因为同分类翻页请求密度比跨分类低。">?</span></label><input type="number" id="pageIntervalMs" value="300" min="50" max="10000"></div>
      </div>
      <div class="f-row">
        <div class="fg"><label>请求重试次数 <span class="hint">(1-10)</span><span class="help" data-tip="请求失败后的最大重试次数。例如设为3，则最多尝试3次（不含首次请求）。次数越多成功率越高，但耗时越长。">?</span></label><input type="number" id="retryTimes" value="3" min="1" max="10"></div>
        <div class="fg"><label>重试基础等待(ms) <span class="hint">(100-60000)</span><span class="help" data-tip="指数退避的基数。第N次重试等待 = 基础等待 × 2^N。例如1000ms：第1次等1s，第2次等2s，第3次等4s… 值越大重试间隔越长，给服务端更多恢复时间。">?</span></label><input type="number" id="retryBaseMs" value="1000" min="100" max="60000"></div>
      </div>
      <div class="f-row">
        <div class="fg"><label>重试最大等待(ms)<span class="help" data-tip="单次重试等待的上限。指数退避算出的等待时间不会超过此值。防止基础等待×2^N增长过大。例如设30000ms，即使算出应等64s也只等30s。">?</span></label><input type="number" id="retryMaxMs" value="30000" min="1000" max="120000"></div>
        <div class="fg"><label>重试抖动比例 <span class="hint">(0-1)</span><span class="help" data-tip="在指数退避等待时间上叠加随机偏移，防止多个实例同时重试造成「惊群」。0=无抖动，0.3=±30%随机偏移。例如等待2s、抖动0.3，实际等1.4s~2.6s。">?</span></label><input type="number" id="retryJitter" value="0.3" min="0" max="1" step="0.1"></div>
      </div>
      <div class="cfg-hr"></div>
      <div class="f-row">
        <div class="fg"><label>省间最小延迟(秒)<span class="help" data-tip="两个省份采集之间的最小等待时间。实际延迟 = 随机(min~max) × (1±抖动)。适当增大可降低被服务端限流的风险。">?</span></label><input type="number" id="delayMin" value="60" min="5" max="600"></div>
        <div class="fg"><label>省间最大延迟(秒)<span class="help" data-tip="两个省份采集之间的最大等待时间。与最小延迟配合，产生随机延迟，避免多实例同时请求同一服务端。">?</span></label><input type="number" id="delayMax" value="120" min="5" max="600"></div>
      </div>
      <div class="fg"><label>省间抖动比例 <span class="hint">(0-1, 延迟随机偏移)</span><span class="help" data-tip="在省间延迟上叠加随机偏移，与重试抖动类似。0=无偏移，0.2=±20%偏移。多实例并行采集时防止同时请求。">?</span></label><input type="number" id="jitterRatio" value="0.2" min="0" max="1" step="0.1"></div>
      <div class="cfg-hr"></div>
      <div class="fg"><label>省份并发度覆盖 <span class="hint">(0=跟随全局)</span><span class="help" data-tip="仅对当前运营商生效的省份并发线程数。0=跟随全局「省份并发度」设置；大于0则覆盖全局值。各运营商风控松紧不同：风控松的（如移动）可设 4-5，风控紧的设 1-2 或保持 0 用全局保守值。电信 Playwright 回退省份始终串行，不受此影响。">?</span></label><input type="number" id="carrierProvinceWorkers" value="0" min="0" max="16"></div>
    </div>

    <div class="panel rise" id="carrierVolCard">
      <h2 class="panel-title"><span class="p-icon vol"><i data-icon="activity"></i></span>波动率配置</h2>
      <div class="f-row">
        <div class="fg"><label>软预警阈值 <span class="hint">(0-1, 超过则告警但仍对比)</span><span class="help" data-tip="新旧数据数量差异比例的软阈值。|新量-旧量|/旧量 超过此值时发出波动预警，但仍执行对比和覆盖。用于提醒关注，不阻断流程。">?</span></label><input type="number" id="volThreshold" value="0.3" min="0" max="1" step="0.05"></div>
        <div class="fg"><label>硬拒绝阈值 <span class="hint">(0-1, 超过则跳过对比)</span><span class="help" data-tip="新旧数据数量差异比例的硬阈值。超过此值时直接跳过对比和覆盖，保留历史快照不变。防止数据大幅异常时污染基线。必须大于软预警阈值。">?</span></label><input type="number" id="volThresholdHard" value="0.7" min="0" max="1" step="0.05"></div>
      </div>
      <div class="fg"><label>降级自动恢复阈值 <span class="hint">(连续N轮骤变后自动覆盖, 0=禁用)</span><span class="help" data-tip="当某省份连续N轮被骤变检测拦截(hard_reject)后，认定源站数据已永久变化，自动接受新数据重建基线。0表示禁用自动恢复（当前行为），需人工确认后覆盖。建议值3-5。">?</span></label><input type="number" id="degradeAutoRecoverThreshold" value="0" min="0" max="20"></div>
      <div class="field-error" id="err_volatility"></div>
    </div>

    <div class="panel rise" id="carrierNotifyCard">
      <h2 class="panel-title"><span class="p-icon bell"><i data-icon="bell"></i></span>变更通知省份</h2>
      <div class="fg">
        <label>关注省份 <span class="hint">(不选=关注全部省份)</span><span class="help" data-tip="仅对选中省份的变更发送通知。不选则全部省份的变更都通知。不影响采集和对比，仅过滤通知推送，减少不关注省份的通知打扰。">?</span>
          <button type="button" class="link-btn" data-act="notify-all">全选</button>
          <button type="button" class="link-btn" data-act="notify-none">清空</button>
        </label>
        <div class="prov-grid" id="notifyProvGrid"></div>
      </div>
    </div>

    <div class="panel rise" id="carrierCatMapsCard">
      <h2 class="panel-title"><span class="p-icon maps"><i data-icon="tagIcon"></i></span>分类映射表 <span class="panel-sub">(代码→显示名称，留空则显示原始代码)</span></h2>
      <p class="panel-sub" style="margin-bottom:12px">每个运营商独立维护。代码为空的行会被忽略，名称留空表示该代码无映射（前端回退显示代码本身）。</p>
      <div id="catMapsAttrBox"></div>
      <button class="btn ghost sm" type="button" data-act="add-catmap" data-sub="attr"><i data-icon="plus"></i>添加资费范围(attr)</button>
      <div class="cfg-hr"></div>
      <div id="catMapsT1Box"></div>
      <button class="btn ghost sm" type="button" data-act="add-catmap" data-sub="t1"><i data-icon="plus"></i>添加归属(t1)</button>
      <div class="cfg-hr"></div>
      <div id="catMapsT2Box"></div>
      <button class="btn ghost sm" type="button" data-act="add-catmap" data-sub="t2"><i data-icon="plus"></i>添加资费类型(t2)</button>
    </div>

  </section>

  <!-- ═══════════ 数据浏览 ═══════════ -->
  <section id="view-dodata" class="view">
    <div class="panel rise">
      <h2 class="panel-title"><span class="p-icon storage"><i data-icon="database"></i></span>数据浏览 <span class="panel-sub" id="dataBrowseTypeLabel" style="font-weight:600;color:var(--acc)">[Cloudflare]</span> <span class="status-dot" id="dotDoData"></span><span id="DoDataStatusText" class="panel-sub"></span></h2>
      <p class="panel-sub" style="margin-bottom:14px">同源静态读取已部署站点的 ../data/{运营商}/ 目录（站点未部署时无法浏览，仅用于部署后验证）</p>
      <div class="seg Dodata-tabs">
        <button type="button" class="seg-btn Dodata-tab active" data-act="dodata-tab" data-tab="stats">统计概览</button>
        <button type="button" class="seg-btn Dodata-tab" data-act="dodata-tab" data-tab="snapshot">最新快照</button>
        <button type="button" class="seg-btn Dodata-tab" data-act="dodata-tab" data-tab="changelogs">变更日志</button>
      </div>
      <div class="Dodata-toolbar">
        <button class="btn primary magnetic" id="btnFetchDoData" data-act="fetch-dodata"><i data-icon="refresh"></i>获取数据</button>
        <select id="DoDataCarrier">
          <option value="cmcc">移动 CMCC</option>
          <option value="cucc">联通 CUCC</option>
          <option value="ctcc">电信 CTCC</option>
          <option value="cbn">广电 CBN</option>
        </select>
        <select id="DoDataProvince">
          <option value="__all__">全部省份</option>
        </select>
        <span id="DoDataMeta" class="Dodata-meta"></span>
      </div>
      <div class="Dodata-content" id="DoDataContent">
        <div class="Dodata-empty">点击「获取数据」浏览已部署站点的数据</div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 生成结果 ═══════════ -->
  <section id="view-output" class="view">
    <div class="panel rise">
      <h2 class="panel-title"><span class="p-icon code"><i data-icon="code"></i></span>生成结果 <span class="panel-sub">复制 JSON 并设置为 TARIFF_CONFIG 环境变量</span></h2>
      <div class="cfg-output">
        <textarea id="outputJson" rows="20" readonly placeholder="点击「生成配置」查看结果"></textarea>
      </div>
      <div class="btn-row">
        <button class="btn primary magnetic" data-act="generate"><i data-icon="zap"></i>生成配置</button>
        <button class="btn success magnetic" data-act="generate-copy"><i data-icon="copy"></i>生成并复制</button>
        <button class="btn ghost" data-act="format-json"><i data-icon="check"></i>格式化</button>
      </div>
      <div class="validation-result" id="validationResult"></div>
    </div>
  </section>

  </main>
</div>

<div class="cfg-toast" id="cfgToast"></div>
</div>`;

    mountIcons(document.getElementById("configRoot"));
    initFX(document.getElementById("configRoot"));
    navTabs = new Tabs(document.getElementById("configNav"), onNavChange);
    navTabs.activate("global");
    bindEvents();
    initCfgTheme();
    init();
  },
  onExit: function (root) {
    root.innerHTML = "";
    navTabs = null;
    suppressNav = false;
    clearTimeout(toastTimer);
  },
});
