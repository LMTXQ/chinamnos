# -*- coding: utf-8 -*-
"""notify_dispatch.py — 青龙批量通知分发（站外通知推送方案 C-1）

扫描 NOTIFY_DATA_DIR 目录下的 batch_*.json payload 文件（文件即队列）：
  flock 非阻塞锁 → 按通知 ID 去重 → 按渠道适配器逐行分发 →
  消化完成删除 payload 文件；失败行行内重试后进 failed_ids.json；
  脚本以非零码退出 → 触发青龙自带失败通知提醒站长。

当前已注册适配器（新渠道上线时在 ADAPTERS 注册一个函数即可，与 Worker 渠道注册表同构）：
  dingtalk  cred: {webhook, secret?}   secret = SEC 开头加签密钥（可选）
  wecom     cred: {webhook}

payload 行结构（Worker 写入，契约固定）：
  {nid, uid, kind, title, body, channel_type, cred}
  title/body 已由 Worker 按统一消息模板组装完成，本脚本不做二次加工。

环境变量：
  NOTIFY_DATA_DIR   payload 与状态目录（默认：脚本同目录 data/）

仅依赖标准库。
"""
import glob
import json
import os
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

KEEP_DAYS_MS = 30 * 86400 * 1000   # 去重记录保留 30 天
ROW_RETRIES = 2                    # 行失败后行内重试次数（共 3 次尝试）
MAX_FAILED_KEEP = 200              # 失败清单最多保留条数


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
    text = _trunc_bytes("## %s\n%s" % (title, body), 3800)
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
    text = _trunc_bytes("## %s\n%s" % (title, body), 3800)  # 企微 markdown 上限 4096 字节，留余量
    try:
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
            msg = MIMEText(body, "plain", "utf-8")
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


# 适配器注册表（与 Worker 渠道注册表同构；新渠道上线时在此注册）
# 约定：adapter(cred, title, body, row) —— row 为完整 payload 行（邮件适配器用 email_target）
ADAPTERS = {
    "dingtalk": send_dingtalk,
    "wecom": send_wecom,
    "email": send_email,
}


# ───────────────────────── 分发主流程 ─────────────────────────
def dispatch_row(row, processed):
    """分发单行：去重 → 适配器 → 行内重试。返回 (状态, 错误)，状态 ∈ ok|skip|fail。"""
    nid = str(row.get("nid") or "")
    if not nid:
        return "fail", "payload 行缺少 nid"
    if nid in processed:
        return "skip", "已处理过（去重拦截）"
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
                processed[nid] = int(time.time() * 1000) + KEEP_DAYS_MS
                return "ok", err
        except Exception as e:
            err = str(e)
        if attempt < ROW_RETRIES:
            time.sleep(1)
    return "fail", err


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
        processed = load_processed()
        failed = load_failed()
        files = sorted(glob.glob(os.path.join(DATA_DIR, PAYLOAD_GLOB)))
        if not files:
            print("✅ 无待分发 payload（batch_*.json），无事发生。")
            return 0

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

            for row in rows:
                status, note = dispatch_row(row, processed)
                if status == "ok":
                    ok_cnt += 1
                    print("  ✅ %s → %s" % (row.get("nid"), row.get("channel_type")))
                elif status == "skip":
                    skip_cnt += 1
                    print("  ⏭  %s 已处理过，去重跳过" % row.get("nid"))
                else:
                    fail_cnt += 1
                    new_failures += 1
                    append_failed(failed, row.get("nid"), row.get("channel_type"), note)
                    print("  ❌ %s (%s)：%s" % (row.get("nid"), row.get("channel_type"), note))

            # 文件内全部行消化（成功/去重/失败均已记账）→ 先落盘去重状态再删文件：
            # 若中途崩溃，最多重发最后一个文件内的消息，不会全量重发
            _write_json(PROCESSED_FILE, processed)
            os.remove(fp)
            print("  🗑  %s 已消化删除" % name)

        _write_json(FAILED_FILE, failed)
        print("✅ 分发完成：成功 %d / 去重跳过 %d / 失败 %d" % (ok_cnt, skip_cnt, fail_cnt))
        return 1 if new_failures else 0
    finally:
        if lock_fp is not None:
            lock_fp.close()


if __name__ == "__main__":
    sys.exit(main())
