#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Yomi UI Emoji 的「按页子集化 & 内嵌」

  pip install fonttools brotli
  python3 scripts/subset_emoji.py                 # 默认：按本页实际用到的 emoji 做子集（推荐，体积最小）
  python3 scripts/subset_emoji.py --variant full   # 全量：保留字体里全部 1655 个 emoji（CBDT 位图压不动，≈18 MB，一般不用）
  python3 scripts/subset_emoji.py --check          # 只报告体积，不写文件
  python3 scripts/subset_emoji.py --dry-run-chars  # 只列出页面用到、参与子集的码位
  python3 scripts/subset_emoji.py --extra-chars glyphs.txt  # 追加码位/字符

说明：
  - 字体来自 lingyicute/Yomi-Android 的 assets/Yomi-UI-Emoji.ttf（Samsung Color Emoji 改版，CBDT/CBLC 位图）
  - 只保留页面里真正出现的 emoji 码位（默认模式）→ 19.0 MB 完整字体压到几十 KB
  - 与其他两个字体一致：生成的子集以 data: URL 内嵌进 index.html，无网络请求；同时在 scripts/ 保留 -subset.woff2 便于核验
  - 位图字体子集化不需要重绘字形，fontTools 会连同 CBDT/CBLC 一起裁剪；不要加 --desubroutinize 之类的参数
"""
import argparse
import base64
import html as html_lib
import io
import os
import re
import sys
import tempfile
import unicodedata
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_HTML = os.path.join(ROOT, "index.html")

FAMILY = "Yomi UI Emoji"
LOCAL_FONT = os.path.join(ROOT, "assets", "Yomi-UI-Emoji.ttf")
REMOTE_FONT = "https://raw.githubusercontent.com/lingyicute/Yomi-Android/main/assets/Yomi-UI-Emoji.ttf"

# 两种变体：compact（按页子集，默认）/ full（字体全量 emoji）
VARIANTS = {
    "compact": {
        "output": os.path.join(HERE, "Yomi-UI-Emoji-subset.woff2"),
        "label": "按页子集",
    },
    "full": {
        "output": os.path.join(HERE, "Yomi-UI-Emoji-full-subset.woff2"),
        "label": "全量",
    },
}

# 与 subset_font.py 保持一致的「生成块」注释标记，两个脚本可以互相识别、重复运行幂等
GEN_COMMENT_RE = r'/\* ===== (?:(?!\*/).)*?子集（内嵌，离线可用）=====(?:(?!\*/).)*?===== \*/\s*'
FONT_FACE_RE = re.compile(r'(?:' + GEN_COMMENT_RE + r')?@font-face\s*\{[^}]*\}', re.S)
FAMILY_RE = re.compile(r'font-family\s*:\s*["\']?([^"\';}]+?)["\']?\s*;')

# emoji 相关码位区间（Emoji 属性的粗粒度覆盖；命中与否最终还要看字体 cmap）
EMOJI_RANGES = (
    (0x2190, 0x21FF),   # 箭头
    (0x2300, 0x23FF),   # ⌚ ⏰ ⏳ …
    (0x2460, 0x24FF),   # ① 类圈号
    (0x25A0, 0x27BF),   # 几何图形 / 杂项符号 / Dingbats（✦ ✧ ✹ ✅ ❤ …）
    (0x2900, 0x297F),
    (0x2B00, 0x2BFF),   # ⭐ ⬛ …
    (0x3030, 0x3030),
    (0x303D, 0x303D),
    (0x3297, 0x3299),
    (0x1F000, 0x1FAFF),  # 主体 emoji 区
    (0x1F1E6, 0x1F1FF),  # 区域指示符（国旗）
)
# 组成 emoji 序列必需的控制字符
EMOJI_JOINERS = "\ufe0f\u200d\u20e3"


def strip_generated(html):
    """去掉所有已生成的 @font-face（base64 巨块），避免把字体二进制当正文统计。"""
    return FONT_FACE_RE.sub("", html)


def is_emoji_codepoint(ch):
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in EMOJI_RANGES)


def collect_emoji_chars(html):
    """收集页面中出现的 emoji 码位（连同 ZWJ / VS16 / keycap）。"""
    src = html_lib.unescape(strip_generated(html))
    chars = {ch for ch in src if is_emoji_codepoint(ch)}
    if chars:
        chars |= set(EMOJI_JOINERS)
    return chars


def collect_all_chars(font_path):
    from fontTools.ttLib import TTFont
    font = TTFont(font_path, lazy=True)
    return {chr(cp) for cp in font.getBestCmap() if cp}


def build_subset(chars, ttf_path):
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options

    font = TTFont(ttf_path, recalcTimestamp=False)   # 不写 head.modified，同样输入 → 同样字节
    subsetter = Subsetter(options=Options())
    subsetter.populate(text="".join(sorted(chars)))
    subsetter.subset(font)
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    covered = set(font.getBestCmap().keys())
    return data, covered


def download(url, path):
    with urllib.request.urlopen(url, timeout=120) as r, open(path, "wb") as f:
        f.write(r.read())


def resolve_font(args, tmpdir):
    if args.ttf:
        if not os.path.exists(args.ttf):
            sys.exit("找不到字体文件：%s（--ttf）" % args.ttf)
        return args.ttf, os.path.basename(args.ttf)
    if os.path.exists(LOCAL_FONT):
        return LOCAL_FONT, os.path.basename(LOCAL_FONT)
    url = args.font_url or REMOTE_FONT
    tmp_path = os.path.join(tmpdir, "Yomi-UI-Emoji.ttf")
    print("本地缺少完整字体，下载：%s" % url)
    download(url, tmp_path)
    return tmp_path, "Yomi-UI-Emoji.ttf（远程）"


def describe(chars):
    items = []
    for ch in sorted(chars, key=ord):
        cp = ord(ch)
        try:
            name = unicodedata.name(ch)
        except ValueError:
            name = "?"
        items.append("U+%04X %s %s" % (cp, ch, name))
    return items


def make_font_face(b64, source_bytes, woff_kb, b64_kb, count, mode):
    return (
        "/* ===== %s 子集（内嵌，离线可用）=====\n"
        "   由 scripts/subset_emoji.py 生成（源：lingyicute/Yomi-Android assets/Yomi-UI-Emoji.ttf）：\n"
        "   %s模式，只保留 %d 个码位。\n"
        "   %.1f MB 完整字体 → %.1f KB woff2（base64 后 %.1f KB），随页面一起加载、无网络请求。 ===== */\n"
        "@font-face {\n"
        "  font-family: '%s';\n"
        '  src: url("data:font/woff2;base64,%s") format("woff2");\n'
        "  font-weight: 400;\n"
        "  font-style: normal;\n"
        "  font-display: swap;\n"
        "}"
        % (FAMILY, mode, count, source_bytes / 1048576, woff_kb, b64_kb, FAMILY, b64)
    )


def main():
    ap = argparse.ArgumentParser(description="GamesArcade —— Yomi UI Emoji 按页子集化 & 内嵌")
    ap.add_argument("--html", default=DEFAULT_HTML, help="页面文件路径，默认 index.html")
    ap.add_argument("--variant", choices=sorted(VARIANTS), default="compact",
                    help="compact=按页面实际用到的 emoji（默认）；full=保留字体全部 emoji")
    ap.add_argument("--ttf", help="完整字体路径（默认 assets/Yomi-UI-Emoji.ttf，缺失则远程下载）")
    ap.add_argument("--font-url", default=REMOTE_FONT, help="远程兜底字体 URL")
    ap.add_argument("--extra-chars", help="追加字符（或 U+XXXX 码位）所在的文本文件")
    ap.add_argument("--check", action="store_true", help="只报告，不写入")
    ap.add_argument("--dry-run-chars", action="store_true", help="只列出命中子集的码位")
    args = ap.parse_args()

    if not os.path.exists(args.html):
        sys.exit("找不到页面文件：%s" % args.html)
    with open(args.html, encoding="utf-8") as f:
        html = f.read()

    extra = ""
    if args.extra_chars:
        with open(args.extra_chars, encoding="utf-8") as f:
            extra = f.read()
    extra_chars = {ch for ch in extra if is_emoji_codepoint(ch)}
    for m in re.finditer(r"U\+([0-9A-Fa-f]{2,6})", extra):
        extra_chars.add(chr(int(m.group(1), 16)))

    with tempfile.TemporaryDirectory(prefix="gamesarcade-emoji-") as tmpdir:
        ttf, label = resolve_font(args, tmpdir)
        source_size = os.path.getsize(ttf)
        print("完整字体：%.1f MB（%s）" % (source_size / 1048576, label))

        if args.variant == "full":
            chars = collect_all_chars(ttf)
            mode = "全量"
        else:
            chars = collect_emoji_chars(html) | extra_chars
            mode = "按页"

        if not chars:
            sys.exit("页面里没有找到任何 emoji 码位；可用 --extra-chars 手动指定。")

        if args.dry_run_chars:
            print("参与子集的 %d 个码位：" % len(chars))
            for line in describe(chars):
                print("  " + line)
            return

        print("\n需要保留的码位：%d 个（%s）" % (len(chars), mode))
        for line in describe(chars):
            print("  " + line)

        woff, covered = build_subset(chars, ttf)
        missing = {c for c in chars if ord(c) not in covered}
        print("\n子集：%.1f KB woff2（%.2f%% 于原字体），码位：%d 个" % (
            len(woff) / 1024, len(woff) / source_size * 100, len(covered)))
        if missing:
            print("⚠️ 字体本身不含这些字符（会回退到系统 emoji 字体，属正常现象）：%s" % (
                " ".join("U+%04X(%s)" % (ord(c), c) for c in sorted(missing))))

        if args.check:
            print("\n--check：未写入字体或页面。")
            return

        output = VARIANTS[args.variant]["output"]
        with open(output, "wb") as f:
            f.write(woff)
        print("子集文件：%s" % output)

        b64 = base64.b64encode(woff).decode("ascii")
        new_face = make_font_face(b64, source_size, len(woff) / 1024, len(b64) / 1024, len(covered), mode)

        # 1) 已有同族 @font-face → 原地替换（变体切换也走这里）
        replaced = [0]

        def repl(m):
            fam_m = FAMILY_RE.search(m.group(0))
            if fam_m and fam_m.group(1).strip().strip('"').strip("'") == FAMILY:
                replaced[0] += 1
                return new_face
            return m.group(0)

        new_html = FONT_FACE_RE.sub(repl, html)

        # 2) 页面里还没有这个字体 → 插到最后一个 @font-face 之后
        if replaced[0] == 0:
            faces = list(FONT_FACE_RE.finditer(new_html))
            if not faces:
                sys.exit("页面里没有找到任何 @font-face 块，无法定位插入点。")
            pos = faces[-1].end()
            new_html = new_html[:pos] + "\n\n" + new_face + new_html[pos:]
            print("页面中没有 '%s'，已插入新的 @font-face（位于其他字体之后）。" % FAMILY)

        if new_html == html:
            print("页面已经是目标内容，未改动。")
            return
        with open(args.html, "w", encoding="utf-8") as f:
            f.write(new_html)
        print("\n已更新 %s（@font-face 替换 %d 处，插入 %d 处）" % (
            args.html, replaced[0], 1 if replaced[0] == 0 else 0))
        print("页面大小：%.1f KB → %.1f KB" % (len(html.encode()) / 1024, len(new_html.encode()) / 1024))


if __name__ == "__main__":
    main()
