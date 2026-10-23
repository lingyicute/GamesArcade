#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nebulove + Pacifico Local 字体子集化 & 内嵌（移植自 lingyicute/yimines）

  pip install fonttools brotli

  python3 scripts/subset_font.py                     # 就地：对 index.html 中的两个 @font-face 做子集化并内嵌
  python3 scripts/subset_font.py --check             # 只报告，不写入
  python3 scripts/subset_font.py --all-text          # 保守模式：文件里出现的字符全收
  python3 scripts/subset_font.py --extra-chars glyphs.txt

说明：
  - 直接复用 yimines/scripts/subset_font.py 的核心逻辑（strip_non_render_text / collect_chars / build_subset）
  - 扩展为双字体：Nebulove（中文，~1.3MB）+ Pacifico Local（英文手写体，~17KB，实际为 Jua）
  - 完整字体默认从本地 assets/ 读取；若 Nebulove 本地缺失则从 GitHub 远程下载（与 yimines 一致）
  - 生成的子集以 data: URL 内嵌到 index.html，无需网络请求；同时在 scripts/ 下保留 -subset.woff2 便于核验
"""
import argparse
import base64
import io
import os
import re
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HTML = os.path.join(os.path.dirname(HERE), "index.html")

# 字体配置：family 为 CSS 中的 font-family，local 为仓库内路径，remote 为备用下载地址
FONT_CONFIGS = [
    {
        "family": "Nebulove",
        "local": os.path.join(os.path.dirname(HERE), "assets", "Nebulove.woff2"),
        "remote": "https://raw.githubusercontent.com/lingyicute/Nebulove/main/Nebulove.woff2",
        "display": "block",
        "weight": "400",
        "output": os.path.join(HERE, "Nebulove-subset.woff2"),
    },
    {
        "family": "Pacifico Local",
        "local": os.path.join(os.path.dirname(HERE), "assets", "pacifico.woff2"),
        "remote": None,
        "display": "block",
        "weight": "400",
        "output": os.path.join(HERE, "pacifico-subset.woff2"),
    },
]

ASCII = {chr(c) for c in range(32, 127)}
PUNCT = set("：，。！？；‘’“”（）【】—…·《》×＝÷＋－、")

# 同时吃掉由本脚本生成的注释块，否则每次重跑都会在文件里多插一份注释
# yimines 原版为固定 Nebulove 前缀，这里扩展为泛化匹配，兼容两种字体
GEN_COMMENT_RE = r'/\* ===== .*?子集（内嵌，离线可用）=====.*?===== \*/\s*'
FONT_FACE_RE = re.compile(r'(?:' + GEN_COMMENT_RE + r')?@font-face\s*\{[^}]*\}', re.S)


def strip_non_render_text(html):
    """剔除不会渲染的文字：HTML 注释、<style>、<script> 里的注释。"""
    html = re.sub(r'<!--.*?-->', '', html, flags=re.S)
    html = re.sub(r'<style\b[^>]*>.*?</style>', '', html, flags=re.S | re.I)

    def _js(m):
        s = re.sub(r'/\*.*?\*/', ' ', m.group(1), flags=re.S)      # 块注释
        s = re.sub(r'(?m)^[ \t]*//.*$', ' ', s)                    # 行注释
        return s

    return re.sub(r'<script\b[^>]*>(.*?)</script>', _js, html, flags=re.S | re.I)


def collect_chars(html, all_text=False, extra=""):
    if all_text:
        chars = set(html)
    else:
        chars = set(strip_non_render_text(html))
    chars |= ASCII | PUNCT | set(extra)
    chars.discard("\n")
    chars.discard("\r")
    chars.discard("\t")
    return chars


def build_subset(chars, ttf_path):
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options

    font = TTFont(ttf_path, recalcTimestamp=False)   # 不写 head.modified，保证同样输入 → 同样字节
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
    with urllib.request.urlopen(url, timeout=60) as r, open(path, "wb") as f:
        f.write(r.read())


def make_font_face(family, b64, source_kb, woff_kb, b64_kb, count, mode, display="block", weight="400"):
    # 保持与 yimines 一致的中文注释与统计信息，仅 family 与 display/weight 区分
    # Pacifico Local 含空格，使用双引号；Nebulove 使用单引号与原版一致
    family_quoted = '"%s"' % family if " " in family else "'%s'" % family
    return (
        "/* ===== %s 子集（内嵌，离线可用）=====\n"
        "   由 scripts/subset_font.py 生成：只保留本页会用到的 %d 个字形（%s 模式）。\n"
        "   %.0f KB 完整字体 → %.1f KB woff2（base64 后 %.1f KB），随页面一起加载、无网络请求。 ===== */\n"
        "@font-face {\n"
        "  font-family: %s;\n"
        '  src: url("data:font/woff2;base64,%s") format("woff2");\n'
        "  font-weight: %s;\n"
        "  font-style: normal;\n"
        "  font-display: %s;\n"
        "}" % (family, count, mode, source_kb, woff_kb, b64_kb, family_quoted, b64, weight, display)
    )


def resolve_ttf(config, args, tmpdir):
    """解析单字体源文件路径：优先本地，其次命令行覆盖，最后远程下载。"""
    family = config["family"]
    # 命令行覆盖：--ttf 专指 Nebulove（兼容 yimines 测试），--pacifico-ttf 指 Pacifico
    if family == "Nebulove" and args.ttf:
        path = args.ttf
        if not os.path.exists(path):
            sys.exit("找不到字体文件：%s（--ttf）" % path)
        return path, os.path.basename(path)
    if family == "Pacifico Local" and getattr(args, "pacifico_ttf", None):
        path = args.pacifico_ttf
        if not os.path.exists(path):
            sys.exit("找不到字体文件：%s（--pacifico-ttf）" % path)
        return path, os.path.basename(path)

    # 仓库本地
    if os.path.exists(config["local"]):
        return config["local"], os.path.basename(config["local"])

    # 远程下载（仅 Nebulove 有）
    remote = args.font_url if family == "Nebulove" and args.font_url else config["remote"]
    if remote:
        tmp_path = os.path.join(tmpdir, os.path.basename(config["local"]))
        print("下载完整字体：%s → %s" % (remote, family))
        download(remote, tmp_path)
        return tmp_path, os.path.basename(config["local"]) + "（远程）"

    sys.exit("找不到字体文件：%s，且无远程地址可下载。" % config["local"])


def main():
    ap = argparse.ArgumentParser(description="GamesArcade 字体子集化（双字体版，移植自 yimines）")
    ap.add_argument("--html", default=DEFAULT_HTML, help="页面文件路径，默认 index.html")
    ap.add_argument("--font-url", default=FONT_CONFIGS[0]["remote"], help="Nebulove 远程字体 URL（本地缺失时下载）")
    ap.add_argument("--ttf", help="Nebulove 本地字体路径（不下载）；兼容 yimines 参数")
    ap.add_argument("--pacifico-ttf", help="Pacifico Local 本地字体路径")
    ap.add_argument("--extra-chars", help="追加字符集合所在的文本文件")
    ap.add_argument("--all-text", action="store_true", help="保守模式：文件里出现的字符全收")
    ap.add_argument("--check", action="store_true", help="只报告，不写入")
    args = ap.parse_args()

    if not os.path.exists(args.html):
        sys.exit("找不到页面文件：%s" % args.html)
    with open(args.html, encoding="utf-8") as f:
        html = f.read()
    if not FONT_FACE_RE.search(html):
        sys.exit("页面里没有找到 @font-face 块，无法替换。")

    extra = ""
    if args.extra_chars:
        with open(args.extra_chars, encoding="utf-8") as f:
            extra = f.read()

    chars = collect_chars(html, all_text=args.all_text, extra=extra)
    mode = "全文本" if args.all_text else "可渲染文本"
    print("需要保留的字符：%d 个（%s）" % (len(chars), mode))
    print("ASCII：95 个 + 中文标点：%d 个 + 页面可渲染字符 + 额外字符" % len(PUNCT))

    # 仅处理页面中实际出现的字体族，避免对不存在的字体报错（如 yimines 的单字体测试页）
    present_families = set()
    for m in FONT_FACE_RE.finditer(html):
        fam_m = re.search(r'font-family\s*:\s*["\']?([^\"\'\};]+)["\']?\s*;', m.group(0))
        if fam_m:
            present_families.add(fam_m.group(1).strip().strip('"').strip("'"))
    active_configs = [c for c in FONT_CONFIGS if c["family"] in present_families] if present_families else FONT_CONFIGS
    if len(active_configs) != len(FONT_CONFIGS):
        print("检测到页面包含字体：%s（仅处理这些）" % "、".join(c["family"] for c in active_configs))

    # Keep downloads out of the repository and remove them on every exit path.
    with tempfile.TemporaryDirectory(prefix="gamesarcade-font-") as tmpdir:
        results = []  # per-font: (config, source_size, woff, covered, b64)

        for config in active_configs:
            family = config["family"]
            ttf, label = resolve_ttf(config, args, tmpdir)
            source_size = os.path.getsize(ttf)
            print("\n[%s] 完整字体：%.0f KB（%s）" % (family, source_size / 1024, label))

            woff, covered = build_subset(chars, ttf)
            missing = {c for c in chars if ord(c) not in covered}
            print("[%s] 子集：%.2f KB woff2（%.1f%% 于原字体），字形：%d 个" % (
                family, len(woff) / 1024, len(woff) / source_size * 100 if source_size else 0, len(covered)))
            if missing:
                # 与 yimines 一致：报告字体本身不含的字符（将回退到系统字体）
                # 按 Unicode 排序，便于对比
                miss_list = " ".join("U+%04X(%s)" % (ord(c), c) if c.isprintable() and ord(c) < 0xFFFF else "U+%04X" % ord(c) for c in sorted(missing))
                # 但为保持与原版输出精简，额外打印可读字符清单（仅前 100）
                readable = " ".join(repr(c) for c in sorted(missing)[:20])
                print("[%s] ⚠️ 字体本身不含这些字符（将回退到系统字体）：%s" % (
                    family, " ".join("U+%04X" % ord(c) for c in sorted(missing))))
                # 额外提示可读字符，便于调试
                if len(missing) <= 20:
                    print("       字符：%s" % " ".join(sorted(missing)))

            results.append((config, source_size, woff, covered, label))

            if args.check:
                # --check 模式不写文件，仅报告
                continue

            # 写入子集文件到 scripts/（与 yimines 保持一致：HERE 目录）
            keep = config["output"]
            with open(keep, "wb") as f:
                f.write(woff)
            print("[%s] 子集文件：%s" % (family, keep))

        if args.check:
            print("\n--check：未写入字体或页面。")
            # 仍需打印总体压缩比
            for config, source_size, woff, covered, label in results:
                print("[%s] %.0f KB → %.1f KB（%.1f%%）" % (config["family"], source_size/1024, len(woff)/1024, len(woff)/source_size*100 if source_size else 0))
            return

        # 生成新的 @font-face 块
        new_faces = {}
        for config, source_size, woff, covered, label in results:
            b64 = base64.b64encode(woff).decode("ascii")
            new_face = make_font_face(
                config["family"], b64,
                source_size / 1024, len(woff) / 1024, len(b64) / 1024,
                len(covered), mode,
                display=config["display"], weight=config["weight"]
            )
            new_faces[config["family"]] = new_face

        # 按 font-family 替换：解析每个匹配块中的 family，取对应 new_face
        def repl(m):
            block = m.group(0)
            # 提取 family
            fam_m = re.search(r'font-family\s*:\s*["\']?([^\"\'\};]+)["\']?\s*;', block)
            if fam_m:
                fam = fam_m.group(1).strip()
                # 兼容引号内外空格
                fam = fam.strip('"').strip("'")
                if fam in new_faces:
                    return new_faces[fam]
            # 未识别的 @font-face 保留原样（避免误删第三方字体）
            return block

        new_html, n = FONT_FACE_RE.subn(repl, html)

        if new_html == html:
            print("\n页面已经是目标内容，未改动。")
            return
        with open(args.html, "w", encoding="utf-8") as f:
            f.write(new_html)
        print("\n已更新 %s（@font-face 替换 %d 处）" % (args.html, n))
        print("页面大小：%.0f KB → %.0f KB" % (len(html.encode()) / 1024, len(new_html.encode()) / 1024))
        # 汇总压缩
        total_orig = sum(s for _, s, _, _, _ in results)
        total_new = sum(len(w) for _, _, w, _, _ in results)
        print("字体总计：%.0f KB → %.1f KB（%.1f%%）" % (total_orig/1024, total_new/1024, total_new/total_orig*100 if total_orig else 0))


if __name__ == "__main__":
    main()
