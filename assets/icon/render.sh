#!/bin/bash
# 用 Chrome 无头模式把 stage.html 渲染成 7 个尺寸的透明 PNG。
#
# 为什么走 Chrome 而不是引 npm 包：项目零依赖；SVG 文字排版需要真正的字体引擎，
# 自己写光栅化会得到糊字。Chrome 的 --default-background-color=00000000 能输出
# 真透明背景，这是关键（否则 DIB 帧会带一圈白边）。
set -e
cd "$(dirname "$0")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
# 必须用 Windows 风格绝对路径：MSYS 的 /e/... 交给 node 会被解释成 E:\e\...
OUT_WIN="E:\\学习项目\\dev-switch\\assets\\icon"
OUT="/e/学习项目/dev-switch/assets/icon"
mkdir -p "$OUT"

for s in 16 24 32 48 64 128 256; do
  # pad=0：图标满幅。Windows 图标本身自带视觉留白（圆角方块），
  # 再加外部 padding 会让小尺寸显得太小。
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 \
    --default-background-color=00000000 \
    --screenshot="$OUT_WIN\\i${s}.png" \
    --window-size=${s},${s} \
    "file:///E:/学习项目/dev-switch/assets/icon/stage.html?s=${s}&pad=0" 2>&1 | grep -v "^\[" || true
  # 复核尺寸：Chrome 偶尔会按 --window-size 的 CSS 像素出图，
  # 若设备缩放不为 1 就会错，宁可在这里报错也不要静默变形
  PNG_DIR="$OUT_WIN" SIZE="$s" node -e '
    const fs = require("fs"), path = require("path");
    const file = path.join(process.env.PNG_DIR, "i" + process.env.SIZE + ".png");
    const b = fs.readFileSync(file);
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20), n = Number(process.env.SIZE);
    if (w !== n || h !== n) { console.error("i" + n + ".png 实际 " + w + "x" + h); process.exit(1); }
    console.log("  i" + n + ".png  " + w + "x" + h + "  " + b.length + " 字节");
  '
done
echo "渲染完成 → $OUT"
