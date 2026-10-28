# -*- coding: utf-8 -*-
"""notify_dispatch.py — 青龙批量通知分发（站外通知推送方案 C-1 + 采集播报方案批次三）

业务一（batch_*.json，Worker 写好的现成信封）：
扫描 NOTIFY_DATA_DIR 目录下的 batch_*.json payload 文件（文件即队列）：
  flock 非阻塞锁 → 按通知 ID 去重 → 按渠道适配器逐行分发 →
  消化完成删除 payload 文件；失败行行内重试后进 failed_ids.json；
  脚本以非零码退出 → 触发青龙自带失败通知提醒站长。

业务二（coll_digest_*.json，采集端写的"货单"，方案批次三）：
  发现货单 → 调 Worker 内部端点现拉订户名单 → 按每人关注省份从货单抽取
  → 组装消息（本轮明细 + 今日累计）→ 复用 dispatch_row 发送 → 消化删除货单。
  拉名单失败：货单全部保留，下轮补扫；无订阅者：货单直接归档。
  防重发：nid = collector_digest:{uid}:{round_at}:{channel_type}，同货单重扫去重跳过。

当前已注册适配器（新渠道上线时在 ADAPTERS 注册一个函数即可，与 Worker 渠道注册表同构）：
  dingtalk  cred: {webhook, secret?}   secret = SEC 开头加签密钥（可选）
  wecom     cred: {webhook}
  email     cred: {email}              实际收件人优先取行内 email_target
  qmsg      cred: {key, domain?, targets?[]}  QQ 推送中转；targets=QQ 群号数组（站内手动登记，
                                        需先在 Qmsg 控制台绑定该群），空=发平台默认目标；同 Key
                                        硬限流 5 秒/次故多群串行间隔，每日 500 次
  qqbot     cred: {appid, secret, targets[]}  QQ 官方机器人群聊直连（targets=group_openid 列表，
                                        回调绑定码流程写入）；纯文本 msg_type=0，多群串行节流，
                                        token 文件缓存 .qqbot_token.json，超频码 22009 不重试
  feishu    cred: {webhook, secret?}   飞书自定义机器人；仅 text 纯文本（官方 webhook 无 markdown 类型），
                                        加签可选（timestamp+secret 整串为 HMAC 密钥对空串签名）
  bark      cred: {key, server?}       Bark iOS 推送；POST /push JSON，server=自建 bark-server（可选）
  pushplus  cred: {token}              微信公众号推送；template=markdown 官方支持，响应 code=200 仅代表
                                        受理（异步），900=超量 903=token 无效 905=未实名

payload 行结构（Worker 写入，契约固定）：
  {nid, uid, kind, title, body, channel_type, cred}
  title/body 已由 Worker 按统一消息模板组装完成，本脚本不做二次加工。
  （采集播报行由本脚本自行组装，cred/email_target 来自订户名单端点；
    额外携带 formats = {markdown/html/plain 三格式包}，适配器经 pick_body 按需取用——
    渠道只需声明自己的格式偏好（如 ("html","plain")），无需自建排版。
    渠道格式现状：企微/钉钉 markdown(GFM 表格, markdown_v2 消息类型) →
    邮件 html(内联样式表格)；digest 各格式自带标题行，板块标题用「── 名称 + 横线」标题条区分，
    零标题标签零加粗）

环境变量：
  NOTIFY_DATA_DIR     payload 与状态目录（默认：脚本同目录 data/）
  TARIFF_CONFIG       采集端完整配置 JSON（通知分发读取 notification.smtp_accounts 作为 SMTP 发信邮箱池，
                      未配置时回退旧环境变量 SMTP_ACCOUNTS）
  DIGEST_API_BASE     Worker API 基址（如 https://api.ftac.dpdns.org，采集播报拉订户名单用）
  DIGEST_PULL_TOKEN   订户名单端点访问密钥（与 Worker secret DIGEST_PULL_TOKEN 同值）

仅依赖标准库。
"""
import glob
import json
import os
import re
import sys
import time
import hmac
import random
import base64
import hashlib
import smtplib
import urllib.parse
import urllib.request
import urllib.error
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr

try:
    import fcntl
except ImportError:
    fcntl = None  # Windows 本机调试无 flock，青龙（Linux）恒可用

# payload 与状态文件均放在脚本同目录（Worker 经 OpenAPI scripts 接口写入的 batch_*.json
# 会落在青龙 scripts 目录——即本脚本所在目录，扫本目录即可形成完整闭环）
DATA_DIR = os.environ.get("NOTIFY_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))
PROCESSED_FILE = os.path.join(DATA_DIR, "processed_ids.json")
FAILED_FILE = os.path.join(DATA_DIR, "failed_ids.json")
LOCK_FILE = os.path.join(DATA_DIR, ".dispatch.lock")
PAYLOAD_GLOB = "batch_*.json"
DIGEST_GLOB = "coll_digest_*.json"   # 采集播报货单（采集端 chinamnos.py 写入）

KEEP_DAYS_MS = 30 * 86400 * 1000   # 去重记录保留 30 天
ROW_RETRIES = 2                    # 行失败后行内重试次数（共 3 次尝试）
MAX_FAILED_KEEP = 200              # 失败清单最多保留条数
DIGEST_PULL_TIMEOUT = 30           # 拉订户名单单次超时（秒）

CARRIER_NAMES = {"cmcc": "中国移动", "cucc": "中国联通", "ctcc": "中国电信", "cbn": "中国广电"}


def _env(k, d=""):
    return os.environ.get(k, d).strip()


def _post(url, payload, timeout=15):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _trunc_bytes(s, limit):
    """按 UTF-8 字节截断（中文 3 字节），回退到完整字符边界避免乱码。"""
    b = s.encode("utf-8")
    if len(b) <= limit:
        return s
    cut = b[:limit]
    for _ in range(4):
        try:
            return cut.decode("utf-8") + "\n\n…（内容过长已截断）"
        except UnicodeDecodeError:
            cut = cut[:-1]
    return cut.decode("utf-8", "ignore") + "\n\n…（内容过长已截断）"


def pick_body(row, *wants):
    """渠道按格式偏好取正文的公用入口（三格式包由 build_digest_message 统一产出）。
    按 wants 顺序取第一个存在的格式；行内无 formats（batch 现成信封行）或全部
    未命中时回退 plain = row.body。返回 (格式名, 正文)。"""
    formats = (row or {}).get("formats")
    if isinstance(formats, dict):
        for w in wants:
            v = formats.get(w)
            if v:
                return w, v
    return "plain", str((row or {}).get("body") or "")


# ───────────────────────── 钉钉（加签可选） ─────────────────────────
def _dingtalk_sign(secret, ts):
    """待签串 = f"{ts}\\n{secret}"，HMAC-SHA256 后 base64，再 url 编码（与官方文档一致）。"""
    string_to_sign = "%s\n%s" % (ts, secret)
    hmac_code = hmac.new(secret.encode("utf-8"),
                         string_to_sign.encode("utf-8"), hashlib.sha256).digest()
    return urllib.parse.quote_plus(base64.b64encode(hmac_code))


def send_dingtalk(cred, title, body, row=None):
    webhook = cred.get("webhook", "")
    if not webhook:
        return False, "缺少 webhook"
    url = webhook
    secret = cred.get("secret", "")
    if secret:
        ts = str(round(time.time() * 1000))
        url = "%s&timestamp=%s&sign=%s" % (url, ts, _dingtalk_sign(secret, ts))
    # 钉钉 markdown 支持 <table> HTML 子集（官方未收录的实践能力，GFM 管道表不渲染）；
    # digest 行正文自带标题行，batch 回退行（无 formats）保持「标题 + 正文」拼接
    fmt, text_body = pick_body(row, "markdown", "plain")
    text = _trunc_bytes(text_body if fmt != "plain" else "### %s\n%s" % (title, text_body), 3800)
    try:
        res = _post(url, {"msgtype": "markdown",
                          "markdown": {"title": title[:64], "text": text}})
        ok = res.get("errcode") == 0
        return ok, "errcode=%s %s" % (res.get("errcode"), res.get("errmsg"))
    except urllib.error.HTTPError as e:
        return False, "HTTP %s %s" % (e.code, e.read().decode("utf-8", "ignore")[:150])
    except Exception as e:
        return False, str(e)


# ───────────────────────── 企业微信机器人 ─────────────────────────
def send_wecom(cred, title, body, row=None):
    webhook = cred.get("webhook", "")
    if not webhook:
        return False, "缺少 webhook"
    fmt, text_body = pick_body(row, "markdown", "plain")
    try:
        if fmt == "markdown":
            # 企微 markdown_v2（2025-08 文档新增）：GFM 管道表格；正文已自带标题行
            text = _trunc_bytes(text_body, 3800)  # 上限 4096 字节，留余量
            res = _post(webhook, {"msgtype": "markdown_v2",
                                  "markdown_v2": {"content": text}})
            if res.get("errcode") == 0:
                return True, "errcode=0 (markdown_v2 表格)"
        # 服务端不支持 markdown_v2 或 batch 回退行：现状版式（标题 + 纯文本正文）
        _, plain_body = pick_body(row, "plain")
        text = _trunc_bytes("### %s\n%s" % (title, plain_body), 3800)  # 上限 4096 字节，留余量
        res = _post(webhook, {"msgtype": "markdown", "markdown": {"content": text}})
        ok = res.get("errcode") == 0
        return ok, "errcode=%s %s" % (res.get("errcode"), res.get("errmsg"))
    except urllib.error.HTTPError as e:
        return False, "HTTP %s %s" % (e.code, e.read().decode("utf-8", "ignore")[:150])
    except Exception as e:
        return False, str(e)


# ───────────────────────── 状态文件 ─────────────────────────
def _read_json(path, default):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_processed():
    """{nid: 过期时间戳 ms}；加载时清理已过期条目。"""
    now = int(time.time() * 1000)
    data = _read_json(PROCESSED_FILE, {})
    return {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > now}


def load_failed():
    return _read_json(FAILED_FILE, [])


def append_failed(failed, nid, channel, error):
    failed.append({"nid": nid, "channel": channel,
                   "error": str(error)[:150], "ts": int(time.time() * 1000)})
    del failed[:-MAX_FAILED_KEEP]


# ───────────────────────── 邮件（SMTP 多邮箱池） ─────────────────────────
COOLDOWN_MS = 10 * 60 * 1000  # 发信失败冷却 10 分钟，自动换箱


def _load_mailboxes():
    """发信邮箱池：首选 TARIFF_CONFIG.notification.smtp_accounts（配置页「SMTP 邮箱」页签生成），
    回退旧环境变量 SMTP_ACCOUNTS（兼容既有部署，无需立即迁移）。"""
    raw = _env("TARIFF_CONFIG")
    if raw:
        try:
            arr = (json.loads(raw).get("notification") or {}).get("smtp_accounts")
            if isinstance(arr, list):
                boxes = [a for a in arr if isinstance(a, dict) and a.get("host") and a.get("user") and a.get("pass")]
                if boxes:
                    return boxes
        except Exception:
            pass
    raw = _env("SMTP_ACCOUNTS")
    if not raw:
        return []
    try:
        arr = json.loads(raw)
        return [a for a in arr if isinstance(a, dict) and a.get("host") and a.get("user") and a.get("pass")]
    except Exception:
        return []


def _load_cool():
    now = int(time.time() * 1000)
    data = _read_json(os.path.join(DATA_DIR, "mailbox_cooldown.json"), {})
    return {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > now}


def _bump_count(user):
    today = time.strftime("%Y-%m-%d")
    counts = _read_json(os.path.join(DATA_DIR, "mailbox_counts.json"), {})
    rec = counts.get(user) or {}
    rec = {"date": today, "count": (int(rec.get("count", 0)) + 1) if rec.get("date") == today else 1}
    counts[user] = rec
    _write_json(os.path.join(DATA_DIR, "mailbox_counts.json"), counts)
    print("  📊 %s 当日发送：%d 封" % (user, rec["count"]))


def send_email(cred, title, body, row=None):
    """SMTP 多邮箱池：随机选箱 → 失败冷却 10 分钟换箱（最多 3 箱）→ 全败进失败清单。"""
    to_addr = (row or {}).get("email_target") or cred.get("email", "")
    if not to_addr:
        return False, "缺少收件邮箱（email_target）"
    boxes = _load_mailboxes()
    if not boxes:
        return False, "SMTP_ACCOUNTS 未配置发信邮箱"
    cool = _load_cool()
    avail = [b for b in boxes if cool.get(b["user"], 0) <= int(time.time() * 1000)]
    if not avail:
        return False, "全部发信邮箱处于冷却期"
    tried, last_err = [], ""
    for _ in range(min(3, len(avail))):
        box = random.choice(avail)
        if box["user"] in tried:
            continue
        tried.append(box["user"])
        try:
            port = int(box.get("port", 465) or 465)
            if port == 465:
                s = smtplib.SMTP_SSL(box["host"], port, timeout=30)
            else:
                s = smtplib.SMTP(box["host"], port, timeout=30)
                s.starttls()
            s.login(box["user"], box["pass"])
            sender_name = box.get("from_name") or "ChinaMNOs 讯览台"
            # 邮件格式偏好 html 优先（采集播报行 formats.html = 真表格版式）；batch 行回退纯文本
            fmt, mail_body = pick_body(row, "html", "plain")
            if fmt == "html":
                msg = MIMEText(mail_body, "html", "utf-8")
            else:
                # 邮件正文补标题行：与钉钉/企微（markdown ## 标题）行为对齐，正文自证来源与轮次
                msg = MIMEText("%s\n\n%s" % (title, mail_body), "plain", "utf-8")
            msg["Subject"] = Header(title, "utf-8")
            msg["From"] = formataddr((str(Header(sender_name, "utf-8")), box["user"]))
            msg["To"] = to_addr
            s.sendmail(box["user"], [to_addr], msg.as_string())
            s.quit()
            _bump_count(box["user"])
            print("  📧 邮件已发送：%s → %s（via %s）" % (title[:30], to_addr, box["user"]))
            return True, "已发送 via %s" % box["user"]
        except Exception as e:
            last_err = "%s: %s" % (box["user"], str(e)[:100])
            print("  ⚠ 邮箱 %s 发送失败：%s，冷却 10 分钟换箱重试" % (box["user"], last_err))
            cool = _load_cool()
            cool[box["user"]] = int(time.time() * 1000) + COOLDOWN_MS
            _write_json(os.path.join(DATA_DIR, "mailbox_cooldown.json"),
                        {k: v for k, v in cool.items() if v > int(time.time() * 1000)})
    return False, "全部尝试失败（%d 箱）：%s" % (len(tried), last_err)


# ───────────────────────── Qmsg酱（QQ 推送，第三方中转） ─────────────────────────
QMSG_DEFAULT_DOMAIN = "https://qmsg.zendee.cn"  # 新版文档出现 api.atku.cn，以实测为准；cred.domain 可覆盖
QMSG_SEND_PATH = "/v3/jsend/"
QMSG_MSG_LIMIT = 1800  # 官方文档：最长 1800 字符
QMSG_GROUP_INTERVAL = 5  # 同 Key 硬限流 5 秒/次、每日 500 次；多群串行必须间隔（秒）


def _plainify(s):
    """plain 渠道净化：验证码/即时消息正文可能含 markdown 标记（**code**、[站点](url)），
    Qmsg 不渲染 markdown，发前去除标记保证 QQ 端可读（与 Worker 侧 plainify 行为一致）。
    链接文字与网址相同（纯域名链接）时只保留网址，避免"域名: 网址"重复显示。"""
    def _link(m):
        text, url = m.group(1), m.group(2)
        bare = re.sub(r"^https?://", "", url).rstrip("/")
        if text.rstrip("/") == bare:
            return url
        return "%s: %s" % (text, url)
    s = re.sub(r"\[([^\]\s]+)\]\(([^)\s]+)\)", _link, s)
    return re.sub(r"\*\*([^*]+)\*\*", r"\1", s)


def send_qmsg(cred, title, body, row=None):
    """Qmsg酱：仅 plain 文本（Qmsg 不支持 markdown 透传）。cred.targets 非空 = 逐群推送
    （payload 加 group=群号，需已在 Qmsg 控制台绑定该群），同 Key 硬限流 5 秒/次故串行间隔；
    空 = 发平台绑定默认目标（单聊，无 group）。plain 版式（digest）与 batch 行均不带标题行，
    统一在此补标题（对齐邮件 plain 行为）；部分成功 = True 不重试（防重发已送达群）。"""
    if not cred.get("key"):
        return False, "缺少 qmsg key"
    _, text_body = pick_body(row, "plain")
    text = _trunc_bytes(_plainify("%s\n\n%s" % (title, text_body)), QMSG_MSG_LIMIT)
    targets = [g for g in (cred.get("targets") or []) if g]
    jobs = targets if targets else [None]  # None = 无 group 参数（默认目标）

    ok_n = 0
    errs = []
    for i, g in enumerate(jobs):
        if i:
            time.sleep(QMSG_GROUP_INTERVAL)
        payload = {"msg": text} if g is None else {"msg": text, "group": g}
        label = g if g else "默认目标"
        try:
            res = _post("%s%s%s" % ((cred.get("domain") or QMSG_DEFAULT_DOMAIN).rstrip("/"), QMSG_SEND_PATH, cred.get("key", "")), payload)
            if res.get("success") is True:
                ok_n += 1
            else:
                errs.append("%s: %s" % (label, str(res.get("reason") or res.get("message") or "失败")[:60]))
        except urllib.error.HTTPError as e:
            errs.append("%s: HTTP %s %s" % (label, e.code, e.read().decode("utf-8", "ignore")[:100]))
        except Exception as e:
            errs.append("%s: %s" % (label, str(e)[:80]))

    if not ok_n:
        return False, "全部发送失败：%s" % ("; ".join(errs)[:180])
    if errs:
        return True, "sent %d/%d（部分失败：%s）" % (ok_n, len(jobs), "; ".join(errs)[:120])
    return True, "sent %d/%d" % (ok_n, len(jobs))


# ───────────────────────── QQ 官方机器人（群聊，直连 OpenAPI） ─────────────────────────
QQBOT_API_BASE = "https://api.bot.qq.com"
QQBOT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
QQBOT_MSG_LIMIT = 1500      # 官方文本 content 上限约 1500 字节（UTF-8），超限截断不拆条
QQBOT_GROUP_INTERVAL = 0.15  # 多群串行节流（秒）：单群频控 20 qpm、账号 60 qpm（2026-06-22 群主动推送全量开放）
QQBOT_NORETRY_CODES = (22009,)  # 频控/配额类错误码：不重试只记录（清单可按平台变化调整）
QQBOT_TOKEN_TTL_MS = 2 * 3600 * 1000
QQBOT_TOKEN_AHEAD_MS = 5 * 60 * 1000
QQBOT_USE_MD = True  # 官方 2026-04 起群聊开放原生 markdown（受限子集：加粗/标题/链接，无表格）；
                     # 平台拒绝（无权限/不支持）时自动降级 plain 重发一次，降级事件写日志


def _qqbot_token(cred):
    """AppID+Secret 换 access_token（约 2h 有效）；本地文件缓存 .qqbot_token.json，
    提前 5 分钟刷新；失败抛异常由调用方兜底。"""
    appid = cred.get("appid", "")
    if not appid:
        raise RuntimeError("缺少 appid")
    cache_path = os.path.join(DATA_DIR, ".qqbot_token.json")
    cache = _read_json(cache_path, {})
    rec = cache.get(appid) or {}
    if rec.get("token") and rec.get("expires_at", 0) > time.time() * 1000 + QQBOT_TOKEN_AHEAD_MS:
        return rec["token"]
    req = urllib.request.Request(
        QQBOT_TOKEN_URL,
        data=json.dumps({"appId": appid, "clientSecret": cred.get("secret", "")}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.load(r)
    token = str(d.get("access_token") or "")
    if not token:
        raise RuntimeError("token 响应缺少 access_token: %s" % json.dumps(d, ensure_ascii=False)[:120])
    ttl = int(str(d.get("expires_in") or "7200") or 7200) * 1000
    cache[appid] = {"token": token, "expires_at": int(time.time() * 1000) + min(ttl, QQBOT_TOKEN_TTL_MS)}
    _write_json(cache_path, cache)
    return token


def _qqbot_post_group(token, group_openid, payload):
    """发单群消息，返回 (err_code, message)。HTTP/网络异常上抛由调用方兜底。"""
    req = urllib.request.Request(
        "%s/v2/groups/%s/messages" % (QQBOT_API_BASE, group_openid),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "QQBot " + token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        res = json.load(r)
    return int(res.get("err_code") or 0), str(res.get("message") or "")


def send_qbot(cred, title, body, row=None):
    """QQ 官方机器人群消息（直连 OpenAPI）。md 优先（QQBOT_USE_MD）：digest 取 markdown 版式
    （GFM 管道表——QQ md 无表格时会原样显示管道符，若观感差再换 qq_markdown 渲染器）；
    平台拒绝 md 时自动降级 plain 重发。多群串行 + 节流；不拆条（拆条成倍消耗各群配额），
    超长截断保头部。返回语义：部分成功 = (True, "sent m/n ...")——避免上层行级重试把已送达
    的群重发；全败且错误码全属频控/配额清单 = (True, "skipped ...") 同样不重试；
    其余全败 = (False, 错误串) 走行内重试。"""
    targets = [t for t in (cred.get("targets") or []) if t]
    if not targets:
        return False, "未绑定任何群（targets 为空）"
    try:
        token = _qqbot_token(cred)
    except Exception as e:
        return False, "token 获取失败: %s" % str(e)[:120]

    # 组装两种版式：md 优先（digest 自带标题行；batch 行补标题、保留链接语法不 plainify），plain 兜底
    fmt, text_body = pick_body(row, "markdown", "plain")
    if fmt == "markdown":
        md_content = _trunc_bytes(text_body, QQBOT_MSG_LIMIT)
    else:
        md_content = _trunc_bytes("%s\n\n%s" % (title, text_body), QQBOT_MSG_LIMIT)
    plain_content = _trunc_bytes(_plainify("%s\n\n%s" % (title, text_body)), QQBOT_MSG_LIMIT)

    ok_n = 0
    md_ok_n = 0
    errs = []  # (err_code, 描述)
    degraded = False
    for i, g in enumerate(targets):
        if i:
            time.sleep(QQBOT_GROUP_INTERVAL)
        sent = False
        if QQBOT_USE_MD:
            try:
                ec, msg = _qqbot_post_group(token, g, {"msg_type": 2, "markdown": {"content": md_content}})
                if ec == 0:
                    ok_n += 1
                    md_ok_n += 1
                    sent = True
                else:
                    errs.append((ec, "%s md: err_code=%s %s" % (g[-6:], ec, msg[:60])))
            except urllib.error.HTTPError as e:
                errs.append((None, "%s md: HTTP %s %s" % (g[-6:], e.code, e.read().decode("utf-8", "ignore")[:80])))
            except Exception as e:
                errs.append((None, "%s md: %s" % (g[-6:], str(e)[:80])))
        if not sent:
            # md 未启用或被拒：降级 plain（网络类异常同样兜底重发 plain）
            degraded = True
            try:
                ec, msg = _qqbot_post_group(token, g, {"msg_type": 0, "content": plain_content})
                if ec == 0:
                    ok_n += 1
                else:
                    errs.append((ec, "%s plain: err_code=%s %s" % (g[-6:], ec, msg[:60])))
            except urllib.error.HTTPError as e:
                errs.append((None, "%s plain: HTTP %s %s" % (g[-6:], e.code, e.read().decode("utf-8", "ignore")[:80])))
            except Exception as e:
                errs.append((None, "%s plain: %s" % (g[-6:], str(e)[:80])))

    if ok_n:
        note = "" if ok_n == len(targets) else "（部分失败 %d/%d：%s）" % (ok_n, len(targets), "; ".join(e for _, e in errs)[:150])
        mode = "md" if md_ok_n == ok_n and ok_n else "mixed" if md_ok_n else "plain(降级)"
        if degraded and md_ok_n == 0 and QQBOT_USE_MD:
            note = ("md 被平台拒绝，已降级 plain；" + note)[:200]
        return True, "sent %d/%d [%s]%s" % (ok_n, len(targets), mode, note)
    if errs and all(ec in QQBOT_NORETRY_CODES for ec, _ in errs):
        return True, "skipped：全部群命中频控/配额（%s），不重试" % ("; ".join(e for _, e in errs)[:150])
    return False, "全部 %d 群失败：%s" % (len(targets), "; ".join(e for _, e in errs)[:180])


# ───────────────────────── 飞书自定义机器人（群聊） ─────────────────────────
FEISHU_BODY_LIMIT = 18000  # 官方请求体 ≤20KB（含 JSON 包装与转义），留余量


def _feishu_sign(secret, ts):
    """官方加签规则（与钉钉相反）：以 f"{ts}\\n{secret}" 整串为 HMAC-SHA256 密钥，
    对空消息体签名，再 base64 编码。ts 为秒级时间戳（距发送须 ≤1 小时）。"""
    string_to_sign = "%s\n%s" % (ts, secret)
    hmac_code = hmac.new(string_to_sign.encode("utf-8"),
                         digestmod=hashlib.sha256).digest()
    return base64.b64encode(hmac_code).decode("utf-8")


def send_feishu(cred, title, body, row=None):
    """飞书自定义机器人：官方 webhook 仅支持 text/post/image/share_chat/interactive，
    无独立 markdown 类型（卡片 lark_md 亦无表格），故仅发 text 纯文本（digest 取 plain 版式，
    统一补标题行）。加签（可选）：payload 顶层带 timestamp（秒，字符串）与 sign。
    成功响应 code=0；频控单机器人 100 次/分钟，正常频率远低于此不做节流。"""
    webhook = cred.get("webhook", "")
    if not webhook:
        return False, "缺少 webhook"
    _, text_body = pick_body(row, "plain")
    payload = {
        "msg_type": "text",
        "content": {"text": _trunc_bytes(_plainify("%s\n\n%s" % (title, text_body)), FEISHU_BODY_LIMIT)},
    }
    secret = cred.get("secret", "")
    if secret:
        ts = int(time.time())
        payload["timestamp"] = str(ts)
        payload["sign"] = _feishu_sign(secret, ts)
    try:
        res = _post(webhook, payload)
        if int(res.get("code", -1)) == 0:
            return True, "sent"
        return False, "code=%s %s" % (res.get("code"), str(res.get("msg") or "")[:80])
    except urllib.error.HTTPError as e:
        return False, "HTTP %s %s" % (e.code, e.read().decode("utf-8", "ignore")[:100])
    except Exception as e:
        return False, str(e)[:100]


# ───────────────────────── Bark（iOS 推送 App） ─────────────────────────
BARK_DEFAULT_SERVER = "https://api.day.app"
BARK_BODY_LIMIT = 3000  # APNs 单条推送载荷约 4KB 上限（官方未文档化长度限制），留 JSON 包装余量


def send_bark(cred, title, body, row=None):
    """Bark iOS 推送：POST {server}/push JSON（device_key 必填 + title + body），title 单独传参
    （通知卡片标题行），正文取 plain 版式（Bark markdown 参数不支持表格）。server=自建 bark-server
    可覆盖官方 api.day.app。成功响应 HTTP 200 且 code=200（CommonResp），失败 HTTP 400/500。
    官方无频控（异常使用才封 IP）。"""
    key = cred.get("key", "")
    if not key:
        return False, "缺少 device key"
    _, text_body = pick_body(row, "plain")
    payload = {
        "device_key": key,
        "title": title,
        "body": _trunc_bytes(_plainify(text_body), BARK_BODY_LIMIT),
    }
    server = (cred.get("server") or BARK_DEFAULT_SERVER).rstrip("/")
    try:
        res = _post("%s/push" % server, payload)
        if int(res.get("code", 0)) == 200:
            return True, "sent"
        return False, "code=%s %s" % (res.get("code"), str(res.get("message") or "")[:80])
    except urllib.error.HTTPError as e:
        return False, "HTTP %s %s" % (e.code, e.read().decode("utf-8", "ignore")[:100])
    except Exception as e:
        return False, str(e)[:100]


# ───────────────────────── PushPlus（微信公众号推送） ─────────────────────────
PUSHPLUS_SEND_URL = "https://www.pushplus.plus/send"
PUSHPLUS_TITLE_LIMIT = 100   # 官方标题上限 100 字（实名用户）
PUSHPLUS_CONTENT_LIMIT = 18000  # 官方内容上限 2 万字（实名用户），字节级截断保守留余


def send_pushplus(cred, title, body, row=None):
    """PushPlus 微信公众号推送：template=markdown 官方支持（digest 取 markdown 版式含 GFM 表格，
    若公众号侧表格渲染异常再降 plain；batch 行回退 plain 并补标题）。接口异步——同步响应
    code=200 仅代表受理，最终结果需流水号查询（本渠道以受理为准，不追踪流水号）。
    错误码：900=超量 903=token 无效 905=未实名。免费额度（实名）：200 次/日、1 分钟 5 次、
    相同内容 1 小时 3 条——单人单 token 频率远低于此，不做节流。"""
    token = cred.get("token", "")
    if not token:
        return False, "缺少 token"
    fmt, text_body = pick_body(row, "markdown", "plain")
    content = text_body if fmt == "markdown" else _plainify("%s\n\n%s" % (title, text_body))
    payload = {
        "token": token,
        "title": title[:PUSHPLUS_TITLE_LIMIT],
        "content": _trunc_bytes(content, PUSHPLUS_CONTENT_LIMIT),
        "template": "markdown",
    }
    try:
        res = _post(PUSHPLUS_SEND_URL, payload)
        if int(res.get("code", 0)) == 200:
            return True, "accepted"
        return False, "code=%s %s" % (res.get("code"), str(res.get("msg") or "")[:80])
    except urllib.error.HTTPError as e:
        return False, "HTTP %s %s" % (e.code, e.read().decode("utf-8", "ignore")[:100])
    except Exception as e:
        return False, str(e)[:100]


# 适配器注册表（与 Worker 渠道注册表同构；新渠道上线时在此注册）
# 约定：adapter(cred, title, body, row) —— row 为完整 payload 行（邮件适配器用 email_target）
ADAPTERS = {
    "dingtalk": send_dingtalk,
    "wecom": send_wecom,
    "email": send_email,
    "qmsg": send_qmsg,
    "qqbot": send_qbot,
    "feishu": send_feishu,
    "bark": send_bark,
    "pushplus": send_pushplus,
}


# ───────────────────────── 分发主流程 ─────────────────────────
def _dispatch_workers():
    """分发并发线程数：读 TARIFF_CONFIG.notification.dispatch_workers（配置页「通知类型开关」面板可配），
    1~32 夹紧，缺省/解析失败回退 8。"""
    raw = _env("TARIFF_CONFIG")
    if raw:
        try:
            n = int(((json.loads(raw).get("notification") or {}).get("dispatch_workers")) or 8)
            return max(1, min(32, n))
        except Exception:
            pass
    return 8


def _send_with_retry(row):
    """线程内执行：适配器调用 + 行内重试。不做去重、不碰任何共享状态，返回 (状态, 错误)。"""
    channel = str(row.get("channel_type") or "")
    adapter = ADAPTERS.get(channel)
    if adapter is None:
        return "fail", "未注册的渠道类型：%s" % (channel or "(空)")
    title = str(row.get("title") or "")
    body = str(row.get("body") or "")
    cred = row.get("cred") if isinstance(row.get("cred"), dict) else {}

    err = "未执行"
    for attempt in range(ROW_RETRIES + 1):
        try:
            ok, err = adapter(cred, title, body, row)
            if ok:
                return "ok", err
        except Exception as e:
            err = str(e)
        if attempt < ROW_RETRIES:
            time.sleep(1)
    return "fail", err


def dispatch_rows(rows, processed, workers=8):
    """并发分发一批行：去重前置（主线程）→ 线程池发送 → 主线程统一记账。
    返回 [(nid, channel, status, note)]，status ∈ ok|skip|fail。
    线程只发送不记账；processed 写入全部在主线程（as_completed 回收处），无竞态。
    崩溃安全语义不变：调用方在全部结果记账并落盘 processed 之后才删货单文件。"""
    out = []
    todo = []
    for row in rows:
        nid = str(row.get("nid") or "")
        if not nid:
            out.append(("", str(row.get("channel_type") or ""), "fail", "payload 行缺少 nid"))
            continue
        if nid in processed:
            out.append((nid, str(row.get("channel_type") or ""), "skip", "已处理过（去重拦截）"))
            continue
        todo.append(row)
    if not todo:
        return out

    from concurrent.futures import ThreadPoolExecutor, as_completed
    workers = max(1, min(int(workers or 8), len(todo), 32))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_send_with_retry, row): row for row in todo}
        for fut in as_completed(futs):
            row = futs[fut]
            nid = str(row.get("nid") or "")
            channel = str(row.get("channel_type") or "")
            try:
                status, note = fut.result()
            except Exception as e:  # 兜底：_send_with_retry 内部已捕获，不应到达
                status, note = "fail", str(e)
            if status == "ok":
                processed[nid] = int(time.time() * 1000) + KEEP_DAYS_MS
            out.append((nid, channel, status, note))
    return out


# ───────────────────────── 采集播报（方案批次三：digest 分支） ─────────────────────────
# 货单结构（采集端 chinamnos.py 写入，契约固定）：
#   {"date": "20261024", "round_at": <ms>,
#    "round":  {carrier: {省代码: {"name": 省名, "added": n, "changed": n, "removed": n}}},
#    "today": {同结构，当日累计}}
# 订户结构（Worker /api/internal/digest-subscribers 返回）：
#   {"uid", "channel_type", "cred", "provinces": ..., "email_target?": 仅 email 行}
# provinces 偏好（批次四升级为按运营商分组）：
#   - null / [] / {}         → 未设置偏好 = 全收（全部运营商全部省份）
#   - ["hun","gd"]           → 旧格式：全运营商同一份省份清单
#   - {"cmcc":["hun"], ...}  → 新格式：按运营商分组；缺失的运营商键 = 不收该运营商


def fetch_digest_subscribers():
    """调 Worker 内部端点现拉订户名单；重试 3 次（面板到 CF 链路间歇抖动），
    返回 (订户列表, 站点链接)；最终失败返回 (None, "")（调用方保留货单下轮补扫）。"""
    base = _env("DIGEST_API_BASE").rstrip("/")
    token = _env("DIGEST_PULL_TOKEN")
    if not base or not token:
        print("  ⚠ DIGEST_API_BASE / DIGEST_PULL_TOKEN 未配置，无法拉取订户名单")
        return None, ""
    url = base + "/api/internal/digest-subscribers"
    last_err = ""
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                url, headers={"X-Digest-Token": token, "User-Agent": "chinamnos-dispatch/1.0"})
            with urllib.request.urlopen(req, timeout=DIGEST_PULL_TIMEOUT) as r:
                data = json.load(r)
            if data.get("code") != 0 or not isinstance(data.get("data"), dict):
                print("  ⚠ 订户名单接口响应异常: %s" % json.dumps(data, ensure_ascii=False)[:150])
                return None, ""
            payload = data["data"]
            subs = payload.get("subscribers")
            if not isinstance(subs, list):
                print("  ⚠ 订户名单结构异常（subscribers 非数组）")
                return None, ""
            site = payload.get("site") if isinstance(payload.get("site"), str) else ""
            return subs, site.rstrip("/")
        except Exception as e:
            last_err = str(e)[:150]
            print("  ⚠ 第 %d 次拉取失败: %s" % (attempt + 1, last_err))
            if attempt < 2:
                time.sleep(3)
    print("  ⚠ 拉取订户名单失败（3 次）: %s" % last_err)
    return None, ""


def _prov_set_for(pref, carrier):
    """订户省份偏好 → 指定运营商的省代码集合。None = 不限（全收该运营商）。"""
    if pref is None or pref == [] or pref == {}:
        return None
    if isinstance(pref, dict):
        return set(pref.get(carrier) or [])
    if isinstance(pref, list):
        return set(pref)
    return None


def _pick_provinces(carrier_counts, prov_set):
    """按省代码集合从某运营商的计数中抽取 → {省名: 计数}（prov_set None = 不限全收）。"""
    if prov_set is None:
        return {p.get("name") or code: p for code, p in carrier_counts.items()}
    out = {}
    for code, p in carrier_counts.items():
        if code in prov_set:
            out[p.get("name") or code] = p
    return out


def _tot(prov_map):
    """合计 (added, changed, removed)。"""
    return (sum(int(p.get("added") or 0) for p in prov_map.values()),
            sum(int(p.get("changed") or 0) for p in prov_map.values()),
            sum(int(p.get("removed") or 0) for p in prov_map.values()))


def _totals_line(a, c, r, provs):
    """汇总行：修改/下架为 0 时省略对应段。"""
    parts = ["新增 %d 条" % a]
    if c:
        parts.append("修改 %d 条" % c)
    if r:
        parts.append("下架 %d 条" % r)
    return "共 %d 省：%s" % (provs, " / ".join(parts))


def _digest_sections(sub, digest, site):
    """结构层：按订户省份偏好从货单抽取 → 格式无关的段落树（渲染层三格式共用）。
    与本订户无关（本轮/今日均无变化且无公告）返回 None。
    结构：{"title", "round": [运营商段], "today": [...], "announce": [公告段], "site"}
      运营商段 = {"key", "name", "rows": [(省名, added, changed, removed)],
                  "totals": (a, c, r), "n": 省数}
      公告段   = {"key", "name", "items": [{"title", "date", "link"}]}"""
    pref = sub.get("provinces")

    def stat_section(part_dict):
        out = []
        for key in ("cmcc", "cucc", "ctcc", "cbn"):
            picks = _pick_provinces(part_dict.get(key) or {}, _prov_set_for(pref, key))
            if not picks:
                continue
            rows = [(name, int(p.get("added") or 0), int(p.get("changed") or 0), int(p.get("removed") or 0))
                    for name, p in picks.items()]
            out.append({"key": key, "name": CARRIER_NAMES.get(key, key), "rows": rows,
                        "totals": _tot(picks), "n": len(picks)})
        return out

    sec = {
        "title": "",
        "round": stat_section(digest.get("round") if isinstance(digest.get("round"), dict) else {}),
        "today": stat_section(digest.get("today") if isinstance(digest.get("today"), dict) else {}),
        "announce": [],
        "site": site,
    }

    # 公告段（订户公告开关开 + 货单含 announce 段才进结构；按订户 运营商×省份 过滤）
    if sub.get("announce") is True:
        ann_list = digest.get("announce") if isinstance(digest.get("announce"), list) else []
        groups, order = {}, []
        for it in ann_list:
            if not isinstance(it, dict):
                continue
            carrier = str(it.get("carrier") or "")
            prov_code = str(it.get("province") or "")
            prov_set = _prov_set_for(pref, carrier)
            if prov_set is not None:
                if not prov_set:
                    continue  # 该运营商未订阅
                if prov_code and prov_code not in prov_set:
                    continue  # 省份不在订阅范围
            if carrier not in groups:
                groups[carrier] = []
                order.append(carrier)
            groups[carrier].append(it)
        for carrier in order:
            items = []
            for it in groups[carrier]:
                t = str(it.get("title") or "").strip() or "(无标题公告)"
                iid = str(it.get("id") or "")
                link = ("%s/#ann_%s_%s" % (site, carrier, iid)) if (site and iid) else ""
                items.append({"title": t, "date": str(it.get("date") or ""), "link": link})
            sec["announce"].append({"key": carrier, "name": CARRIER_NAMES.get(carrier, carrier), "items": items})

    # 方案A：今日累计不作为独立触发源——仅「本轮有变化 或 公告新增」才推送。
    if not sec["round"] and not sec["announce"]:
        return None
    return sec


def _render_plain(sec):
    """纯文本行式版式（══ 段 ══ 风格）：钉钉/企微 markdown 消息体与纯文本渠道共用。"""
    def stat_lines(secs):
        lines = []
        ta = tc = tr = 0
        provs = 0
        for s in secs:
            lines.append("══ %s ══" % s["name"])
            for name, a, c, r in s["rows"]:
                seg = []
                if a:
                    seg.append("新增 %d 条" % a)
                if r:
                    seg.append("下架 %d 条" % r)
                if c:
                    seg.append("修改 %d 条" % c)
                if seg:
                    lines.append("  %s：%s" % (name, " / ".join(seg)))
            a, c, r = s["totals"]
            ta += a
            tc += c
            tr += r
            provs += s["n"]
        if provs:
            lines.append("")
            lines.append(_totals_line(ta, tc, tr, provs))
        return lines

    lines = []
    if sec["round"]:
        lines.append("═══ 本轮采集 ═══")
        lines.extend(stat_lines(sec["round"]))
        lines.append("")
        lines.append("═══ 今日累计 ═══")
        lines.extend(stat_lines(sec["today"]) if sec["today"] else ["  你关注的范围今日暂无变化"])
    if sec["announce"]:
        if lines:
            lines.append("")
        lines.append("═══ 公告新增 ═══")
        for s in sec["announce"]:
            lines.append("══ %s ══" % s["name"])
            for it in s["items"]:
                if it["link"]:
                    lines.append("  · %s\n    %s" % (it["title"], it["link"]))
                else:
                    lines.append("  · %s" % it["title"])
    lines.append("")
    lines.append("（你关注省份的变更摘要已送达 · 若希望关闭打扰，请前往站点「通知设置」调整关注范围或关闭）")
    if sec["site"]:
        lines.append("站点：%s" % sec["site"])
    return "\n".join(lines)


def _render_markdown(sec):
    """企微 markdown_v2 版式：GFM 管道表格保留，但零标题标签（#）、零加粗（**）——
    板块标题用「── 名称 + 横线」标题条与全角缩进区分，规避大字号；
    正文自带标题行（适配器不再拼 ### 前缀）。"""

    def md_cell(v):
        return str(v).replace("|", "\\|").replace("\n", " ")

    def bar(label):
        return "── %s ────" % label  # 全角 16 格封顶，手机消息面板一行放得下

    def stat_md(secs):
        out = []
        ta = tc = tr = 0
        provs = 0
        for s in secs:
            out.append("　" + s["name"])
            out.append("")
            out.append("| 省份 | 新增 | 修改 | 下架 |")
            out.append("| --- | ---: | ---: | ---: |")
            for name, a, c, r in s["rows"]:
                out.append("| %s | %d | %d | %d |" % (md_cell(name), a, c, r))
            a, c, r = s["totals"]
            ta += a
            tc += c
            tr += r
            provs += s["n"]
            out.append("| 合计（%d 省） | %d | %d | %d |" % (s["n"], a, c, r))
            out.append("")
        if provs:
            out.append("　" + _totals_line(ta, tc, tr, provs))
            out.append("")
        return out

    lines = [sec["title"], ""]
    if sec["round"]:
        lines.append(bar("本轮采集"))
        lines.append("")  # 标题条与后续内容必须空行隔开，markdown 会把相邻行并成一段
        lines.extend(stat_md(sec["round"]))
        lines.append(bar("今日累计"))
        lines.append("")
        lines.extend(stat_md(sec["today"]) if sec["today"] else ["　（你关注的范围今日暂无变化）", ""])
    if sec["announce"]:
        lines.append(bar("公告新增"))
        lines.append("")
        for s in sec["announce"]:
            lines.append("　" + s["name"])
            lines.append("")
            lines.append("| 公告标题 | 日期 |")
            lines.append("| --- | --- |")
            for it in s["items"]:
                t = ("[%s](%s)" % (md_cell(it["title"]), it["link"])) if it["link"] else md_cell(it["title"])
                lines.append("| %s | %s |" % (t, md_cell(it["date"])))
            lines.append("")
    lines.append("")
    lines.append("─" * 16)
    lines.append("")
    lines.append("你关注省份的变更摘要已送达 · 若希望关闭打扰，请前往站点「通知设置」调整关注范围或关闭")
    lines.append("")
    if sec["site"]:
        lines.append("站点：%s" % sec["site"])
    return "\n".join(lines)


def _render_html(sec):
    """内联样式 HTML 表格版（邮箱客户端对 <style> 支持不一，全部内联最稳）：邮件渠道用。"""
    _td = 'border:1px solid #d0d3da;padding:5px 8px;font-size:13px'
    _th = 'border:1px solid #d0d3da;padding:5px 8px;font-size:12px;background:#f2f3f5;text-align:left'
    _tbl = 'border-collapse:collapse;width:100%;margin:4px 0 12px'
    _h = 'margin:14px 0 4px;font-size:13.5px;font-weight:700'
    _total = 'margin:4px 0 14px;font-size:12.5px;color:#444'
    _trailer = 'margin:14px 0 2px;font-size:12px;color:#777'
    _site = 'margin:0;font-size:12px'

    def stat_html(secs):
        html = []
        ta = tc = tr = 0
        provs = 0
        for s in secs:
            rows = []
            for name, a, c, r in s["rows"]:
                rows.append('<tr><td style="%s">%s</td>'
                            '<td style="%s;text-align:center">%d</td>'
                            '<td style="%s;text-align:center">%d</td>'
                            '<td style="%s;text-align:center">%d</td></tr>'
                            % (_td, name, _td, a, _td, c, _td, r))
            a, c, r = s["totals"]
            ta += a
            tc += c
            tr += r
            provs += s["n"]
            rows.append('<tr><td style="%s;font-weight:700">合计（%d 省）</td>'
                        '<td style="%s;text-align:center;font-weight:700">%d</td>'
                        '<td style="%s;text-align:center;font-weight:700">%d</td>'
                        '<td style="%s;text-align:center;font-weight:700">%d</td></tr>'
                        % (_td, s["n"], _td, a, _td, c, _td, r))
            html.append('<p style="%s">%s</p>' % (_h, s["name"]))
            html.append('<table style="%s"><tr><th style="%s">省份</th>'
                        '<th style="%s">新增</th><th style="%s">修改</th><th style="%s">下架</th></tr>%s</table>'
                        % (_tbl, _th, _th, _th, _th, "".join(rows)))
        if provs:
            html.append('<p style="%s">%s</p>' % (_total, _totals_line(ta, tc, tr, provs)))
        return html

    html = ['<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#222;line-height:1.6">']
    html.append('<h3 style="margin:0 0 10px;font-size:16px">%s</h3>' % sec["title"])
    if sec["round"]:
        html.append('<p style="%s">本轮采集</p>' % _h)
        html.extend(stat_html(sec["round"]))
        html.append('<p style="%s">今日累计</p>' % _h)
        html.extend(stat_html(sec["today"]) if sec["today"] else ['<p style="margin:0 0 12px">（你关注的范围今日暂无变化）</p>'])
    if sec["announce"]:
        html.append('<p style="%s">公告新增</p>' % _h)
        for s in sec["announce"]:
            rows = []
            for it in s["items"]:
                et = it["title"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                if it["link"]:
                    rows.append('<tr><td style="%s"><a href="%s" style="color:#1a56db;text-decoration:none">%s</a></td>'
                                '<td style="%s;text-align:center">%s</td></tr>' % (_td, it["link"], et, _td, it["date"]))
                else:
                    rows.append('<tr><td style="%s">%s</td><td style="%s;text-align:center">%s</td></tr>' % (_td, et, _td, it["date"]))
            html.append('<p style="%s">%s</p>' % (_h, s["name"]))
            html.append('<table style="%s"><tr><th style="%s">公告标题（点击查看）</th>'
                        '<th style="%s">日期</th></tr>%s</table>' % (_tbl, _td, _td, "".join(rows)))
    html.append('<p style="%s">（你关注省份的变更摘要已送达 · 若希望关闭打扰，请前往站点「通知设置」调整关注范围或关闭）</p>' % _trailer)
    if sec["site"]:
        html.append('<p style="%s">站点：<a href="%s">%s</a></p>' % (_site, sec["site"], sec["site"]))
    html.append('</div>')
    return "".join(html)


def build_digest_message(sub, digest, site=""):
    """按订户省份偏好从货单抽取并组装消息；与本订户无关（本轮+今日均无变化且无公告）返回 None。

    返回 (title, formats)：formats = {"markdown" GFM 表格（企微 markdown_v2）,
    "html" 内联样式表格（邮件）, "plain" 纯文本行式（兜底）}，
    各格式由同一份结构（_digest_sections）渲染，统计口径天然一致，且均自带标题行、
    零标题标签零加粗（板块标题用「── 名称 + 横线」标题条 + 全角缩进区分）；
    渠道适配器经 pick_body 按自身声明取用。"""
    round_at = int(digest.get("round_at") or 0)
    stamp = time.strftime("%m-%d %H:%M", time.localtime(round_at / 1000)) if round_at else "本轮"
    title = "【ChinaMNOs 讯览台】资费监控通知（%s 轮）" % stamp
    sec = _digest_sections(sub, digest, site)
    if sec is None:
        return None
    sec["title"] = title
    return title, {"plain": _render_plain(sec), "markdown": _render_markdown(sec),
                   "html": _render_html(sec)}


def process_digest_files(processed, failed, workers=8):
    """处理采集播报货单（coll_digest_*.json）。返回 (ok, skip, fail, new_failures)。"""
    files = sorted(glob.glob(os.path.join(DATA_DIR, DIGEST_GLOB)))
    if not files:
        return 0, 0, 0, 0

    ok_cnt = skip_cnt = fail_cnt = new_failures = 0
    print("📬 发现采集播报货单 %d 张，拉取订户名单..." % len(files))
    subs, site = fetch_digest_subscribers()
    if subs is None:
        print("  ⚠ 拉取失败：货单全部保留，下轮补扫")
        return 0, 0, 0, 1
    if not subs:
        print("  ℹ 当前无订阅用户，%d 张货单直接归档" % len(files))
        for fp in files:
            os.remove(fp)
            print("  🗑 %s 已归档" % os.path.basename(fp))
        return 0, 0, 0, 0

    for fp in files:
        name = os.path.basename(fp)
        try:
            with open(fp, encoding="utf-8") as f:
                digest = json.load(f)
            if not isinstance(digest, dict) or not isinstance(digest.get("round"), dict):
                raise ValueError("结构不合法（缺 round 对象）")
        except Exception as e:
            print("  ❌ %s 解析失败：%s（保留供排查，不删除）" % (name, e))
            new_failures += 1
            continue

        round_at = int(digest.get("round_at") or 0)
        rows = []
        for sub in subs:
            uid = str(sub.get("uid") or "")
            channel = str(sub.get("channel_type") or "")
            if not uid or ADAPTERS.get(channel) is None:
                continue
            msg = build_digest_message(sub, digest, site)
            if not msg:
                continue
            title, formats = msg
            row = {
                "nid": "collector_digest:%s:%s:%s" % (uid, round_at, channel),
                "uid": uid, "kind": "collector_digest",
                "title": title, "body": formats.get("plain", ""), "channel_type": channel,
            }
            cred = sub.get("cred")
            if isinstance(cred, dict):
                row["cred"] = cred
            if channel == "email" and sub.get("email_target"):
                row["email_target"] = sub.get("email_target")
            row["formats"] = formats  # 三格式包：适配器经 pick_body 按声明取用（邮件 html / 钉钉企微 plain）
            rows.append(row)

        if not rows:
            print("  ℹ %s 无相关订户，归档" % name)
            os.remove(fp)
            continue

        f_ok = f_skip = f_fail = 0
        for nid, channel, status, note in dispatch_rows(rows, processed, workers):
            if status == "ok":
                ok_cnt += 1
                f_ok += 1
                print("  ✅ %s → %s %s" % (nid, channel, str(note)[:90]))
            elif status == "skip":
                skip_cnt += 1
                f_skip += 1
                print("  ⏭  %s 已处理过，去重跳过" % nid)
            else:
                fail_cnt += 1
                f_fail += 1
                new_failures += 1
                append_failed(failed, nid, channel, note)
                print("  ❌ %s (%s)：%s" % (nid, channel, note))

        # 先落盘去重状态再删货单（与 batch 同语义：崩溃最多重发单张货单内的消息）
        _write_json(PROCESSED_FILE, processed)
        os.remove(fp)
        print("  🗑 %s 已消化删除（发送 %d / 去重 %d / 失败 %d）" % (name, f_ok, f_skip, f_fail))
    return ok_cnt, skip_cnt, fail_cnt, new_failures


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    # flock 非阻塞：拿不到 = 已有实例在跑（防并发重复分发/状态文件竞争）
    if fcntl is not None:
        lock_fp = open(LOCK_FILE, "w")
        try:
            fcntl.flock(lock_fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("❌ 已有分发实例在运行（获取锁失败），本次退出。")
            return 1
    else:
        lock_fp = None

    try:
        workers = _dispatch_workers()
        print("🧵 分发并发线程数：%d（TARIFF_CONFIG.notification.dispatch_workers，1~32）" % workers)
        processed = load_processed()
        failed = load_failed()
        files = sorted(glob.glob(os.path.join(DATA_DIR, PAYLOAD_GLOB)))
        if not files:
            # 不提前返回：采集播报货单（coll_digest_*.json）可能有待处理（方案批次三）
            print("📭 无 batch payload（batch_*.json）")

        ok_cnt = skip_cnt = fail_cnt = 0
        new_failures = 0
        for fp in files:
            name = os.path.basename(fp)
            try:
                with open(fp, encoding="utf-8") as f:
                    rows = json.load(f)
            except Exception as e:
                print("❌ %s 解析失败：%s（保留文件供排查，不删除）" % (name, e))
                new_failures += 1
                continue
            if not isinstance(rows, list):
                print("❌ %s 结构不合法（应为行数组），保留文件。" % name)
                new_failures += 1
                continue

            for nid, channel, status, note in dispatch_rows(rows, processed, workers):
                if status == "ok":
                    ok_cnt += 1
                    print("  ✅ %s → %s %s" % (nid, channel, str(note)[:90]))
                elif status == "skip":
                    skip_cnt += 1
                    print("  ⏭  %s 已处理过，去重跳过" % nid)
                else:
                    fail_cnt += 1
                    new_failures += 1
                    append_failed(failed, nid, channel, note)
                    print("  ❌ %s (%s)：%s" % (nid, channel, note))

            # 文件内全部行消化（成功/去重/失败均已记账）→ 先落盘去重状态再删文件：
            # 若中途崩溃，最多重发最后一个文件内的消息，不会全量重发
            _write_json(PROCESSED_FILE, processed)
            os.remove(fp)
            print("  🗑  %s 已消化删除" % name)

        # ── 采集播报货单（方案批次三，与 batch 并行独立）──
        d_ok, d_skip, d_fail, d_new = process_digest_files(processed, failed, workers)
        ok_cnt += d_ok
        skip_cnt += d_skip
        fail_cnt += d_fail
        new_failures += d_new

        _write_json(FAILED_FILE, failed)
        print("✅ 分发完成：成功 %d / 去重跳过 %d / 失败 %d" % (ok_cnt, skip_cnt, fail_cnt))
        return 1 if new_failures else 0
    finally:
        if lock_fp is not None:
            lock_fp.close()


if __name__ == "__main__":
    sys.exit(main())
