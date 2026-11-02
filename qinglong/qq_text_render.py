# QQTEXT-1 需求内容：仅 1428846389@qq.com 的 QQ 群采集播报改用全角文本表格，其余账号与渠道原样
# QQTEXT-1 改动说明：独立模块承载白名单与渲染逻辑，整文件删除即回退（主文件仅 3 处接线）
"""QQ 群专用：全角文本表格版式。

为什么用全角：QQ 群 markdown 不支持表格，管道符会原样显示；而中文环境下全角字符
（全角数字、全角空格 U+3000、全角竖线）宽度恒定，逐格补位后即可对齐成表格观感。
每行放入引用块（>），避免 QQ 把相邻行合并成一段。

对外只暴露 maybe_add_formats()：主文件调用一次，未命中白名单时什么都不做。
"""

QQ_TEXT_UID_WHITELIST = {"01K3H9BCBO02T1CGBZ000DC004"}  # 1428846389@qq.com

FW_DIGITS = {str(i): chr(0xFF10 + i) for i in range(10)}
FW_SPACE = "\u3000"      # 全角空格：宽度恒等于一个汉字
FW_BAR = "\uFF5C"        # 全角竖线：列边界在所有行停在同一位置
TRAILER = "你关注省份的变更摘要已送达 · 若希望关闭打扰，请前往站点「通知设置」调整关注范围或关闭"


def fw(s):
    """ASCII 数字转全角，保证与汉字落在同一套格子里。"""
    return "".join(FW_DIGITS.get(ch, ch) for ch in str(s))


def _cell(s, w, right=False):
    """按全角宽度补位：right 右对齐（数字列），否则居中（省份列）。"""
    pad = max(0, w - len(s))
    if right:
        return FW_SPACE * pad + s
    left = pad // 2
    return FW_SPACE * left + s + FW_SPACE * (pad - left)


def _bar(label):
    """板块标题条：与 markdown 版式保持同一风格，零标题标签。"""
    return "── %s ────" % label


def _stat_table(seg):
    """单个运营商段 → 引用块表格（表头 + 各省行 + 合计行）。
    QQTEXT-1 改动说明：列宽改为「表头与数据的最长者」，去掉固定 4 格留白；
    每行以 > 紧贴表头起排，表格更紧凑、更接近常规表格观感。"""
    rows = seg.get("rows") or []
    if not rows:
        return []
    pw = max([3] + [len(str(r[0])) for r in rows])      # 最小 3 格：两字省份也留出呼吸位
    nw = max([3] + [len(fw(x)) for r in rows for x in r[1:]])  # 最小 3 格：单/双位数字更稳
    lines = [">" + FW_BAR.join([_cell("省份", pw), _cell("新增", nw, True),
                                _cell("修改", nw, True), _cell("下架", nw, True)])]
    for name, a, c, r in rows:
        lines.append(">" + FW_BAR.join([_cell(str(name), pw), _cell(fw(a), nw, True),
                                        _cell(fw(c), nw, True), _cell(fw(r), nw, True)]))
    ta, tc, tr = seg.get("totals") or (0, 0, 0)
    lines.append(">" + FW_BAR.join([_cell("合计", pw), _cell(fw(ta), nw, True),
                                    _cell(fw(tc), nw, True), _cell(fw(tr), nw, True)]))
    return lines


def _today_line(secs):
    """今日累计只给一行汇总，控制消息长度、避免手机折行。"""
    ta = tc = tr = provs = 0
    for s in secs:
        a, c, r = s.get("totals") or (0, 0, 0)
        ta += a
        tc += c
        tr += r
        provs += int(s.get("n") or 0)
    parts = ["新增 %d 条" % ta]
    if tc:
        parts.append("修改 %d 条" % tc)
    if tr:
        parts.append("下架 %d 条" % tr)
    return "共 %d 省：%s" % (provs, " / ".join(parts))


def render(sec):
    """结构树 → QQ 群全角文本版式（自带标题行，与 markdown 版式对齐口径）。"""
    lines = ["**%s**" % sec.get("title", ""), ""]
    if sec.get("round"):
        lines.append(_bar("本轮采集"))
        lines.append("")
        for seg in sec["round"]:
            lines.append("**%s**" % seg.get("name", ""))
            lines.append("")
            lines.extend(_stat_table(seg))
            lines.append("")
        lines.append(_bar("今日累计"))
        lines.append("")
        lines.append(FW_SPACE + (_today_line(sec.get("today") or [])
                                if sec.get("today") else "（你关注的范围今日暂无变化）"))
        lines.append("")
    if sec.get("announce"):
        lines.append(_bar("公告新增"))
        lines.append("")
        for seg in sec["announce"]:
            lines.append(FW_SPACE + seg.get("name", ""))
            lines.append("")
            for it in seg.get("items") or []:
                if it.get("link"):
                    lines.append(FW_SPACE + "· [%s](%s) %s" % (it.get("title", ""), it["link"], it.get("date", "")))
                else:
                    lines.append(FW_SPACE + "· %s %s" % (it.get("title", ""), it.get("date", "")))
            lines.append("")
    lines.append("─" * 16)
    lines.append("")
    lines.append(TRAILER)
    lines.append("")
    if sec.get("site"):
        lines.append("站点：%s" % sec["site"])
    return "\n".join(lines)


def maybe_add_formats(formats, sub, sec):
    """白名单命中才追加 qq_text 键；未命中不动 formats，其他格式完全不受影响。"""
    if str((sub or {}).get("uid") or "") not in QQ_TEXT_UID_WHITELIST:
        return
    formats["qq_text"] = render(sec)
