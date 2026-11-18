'use strict';
/*
 * 从 assets/icon/i{N}.png 打包 devswitch.ico。
 *
 * ## 两条硬规则（都是踩过坑才写进来的）
 *
 * 1. **小尺寸必须用 DIB，不能用 PNG。**
 *    Windows 正式支持 PNG 压缩的 ICO 帧只限 256×256 一档；16/24/32/48/64/128
 *    若用 PNG，Explorer 取小图标时解码失败，会整体回退成「白纸 + 蓝色箭头」的
 *    通用快捷方式图标 —— 表现为「双击能启动，但图标不对」。
 *    对照样本：C:\Windows\System32\OneDrive.ico 的 8 个帧全是 DIB，零个 PNG。
 *
 * 2. **每个尺寸必须是独立的、满幅的原图。**
 *    上一版 ico 的 16px 帧是全透明的、128px 帧是被裁切的局部大图 ——
 *    说明生成时是从一张大图上按坐标裁的，而不是逐尺寸缩放渲染。
 *    现在改为对每个尺寸单独用 Chrome 渲染 stage.html，天然满幅居中。
 *
 * 256 仍保留 PNG：存成 32bpp DIB 要 262KB，ico 会从 36KB 涨到 290KB，
 * 而 256 用 PNG 是微软明确支持的。
 */
const fs = require('fs');
const path = require('path');

const { decodePng } = require('./png-decode');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SRC_DIR = path.join(__dirname, '..', 'assets', 'icon');
const OUT = path.join(__dirname, '..', 'devswitch.ico');

/** 允许 PNG 帧的最大尺寸（只有 256 这一档用 PNG） */
const PNG_MIN = 256;
const BMP_HEADER = 40;

/**
 * RGBA → ICO 内嵌 DIB 帧
 * 布局：BITMAPINFOHEADER(40) + XOR 位图(BGRA, 自底向上) + AND 掩码(1bpp, 自底向上)
 */
function encodeDib(rgba, w, h) {
  const xorStride = w * 4; // 32bpp 天然 4 字节对齐
  const maskStride = Math.ceil(w / 32) * 4; // 1bpp 行必须 4 字节对齐
  const xorSize = xorStride * h;
  const maskSize = maskStride * h;
  const out = Buffer.alloc(BMP_HEADER + xorSize + maskSize);

  out.writeUInt32LE(BMP_HEADER, 0); // biSize
  out.writeInt32LE(w, 4); // biWidth
  out.writeInt32LE(h * 2, 8); // biHeight = XOR + AND 两层总高（ICO 约定）
  out.writeUInt16LE(1, 12); // biPlanes
  out.writeUInt16LE(32, 14); // biBitCount
  out.writeUInt32LE(0, 16); // biCompression = BI_RGB
  out.writeUInt32LE(xorSize + maskSize, 20); // biSizeImage
  // XOR 位图：RGBA → BGRA，行序自底向上
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = BMP_HEADER + y * xorStride;
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      out[d] = rgba[s + 2]; // B
      out[d + 1] = rgba[s + 1]; // G
      out[d + 2] = rgba[s]; // R
      out[d + 3] = rgba[s + 3]; // A
    }
  }

  /*
   * AND 掩码：1 = 透明，0 = 不透明。
   *
   * 32bpp 图标理论上由 alpha 通道决定透明度，掩码是历史遗留的兜底。
   * 但若掩码全写 0（"全不透明"），某些渲染路径（旧 GDI 缩略、部分 shell
   * 扩展）会无视 alpha、把圆角外的区域画成黑块 —— 蓝方块四角会出现黑角。
   * 所以这里按 alpha 阈值如实置位，让 alpha 与掩码表达同一件事。
   */
  const maskBase = BMP_HEADER + xorSize;
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = maskBase + y * maskStride;
    for (let x = 0; x < w; x++) {
      const alpha = rgba[srcRow + x * 4 + 3];
      if (alpha < 128) {
        // 第 x 位：高位在前（MSB 优先）
        out[dstRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return out;
}

const frames = [];
for (const s of SIZES) {
  const file = path.join(SRC_DIR, `i${s}.png`);
  if (!fs.existsSync(file)) throw new Error(`缺少源图 ${file}`);
  const png = fs.readFileSync(file);
  const { width, height, rgba } = decodePng(png);
  if (width !== s || height !== s) throw new Error(`i${s}.png 实际 ${width}x${height}`);

  if (s >= PNG_MIN) {
    frames.push({ w: s, h: s, bpp: 32, data: png, kind: 'PNG' });
  } else {
    frames.push({ w: s, h: s, bpp: 32, data: encodeDib(rgba, s, s), kind: 'DIB' });
  }
}

const HEADER = 6;
const ENTRY = 16;
let offset = HEADER + ENTRY * frames.length;

const head = Buffer.alloc(HEADER);
head.writeUInt16LE(0, 0); // reserved
head.writeUInt16LE(1, 2); // type = 1 (icon)
head.writeUInt16LE(frames.length, 4);

const entries = frames.map((f) => {
  const e = Buffer.alloc(ENTRY);
  e.writeUInt8(f.w >= 256 ? 0 : f.w, 0); // 256 在 1 字节字段里写 0
  e.writeUInt8(f.h >= 256 ? 0 : f.h, 1);
  e.writeUInt8(0, 2); // 调色板色数（真彩为 0）
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(f.bpp, 6);
  e.writeUInt32LE(f.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += f.data.length;
  return e;
});

const out = Buffer.concat([head, ...entries, ...frames.map((f) => f.data)]);
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
fs.writeFileSync(OUT, out);

console.log(`已生成 devswitch.ico：${out.length} 字节，${frames.length} 个尺寸`);
for (const f of frames) {
  console.log(`  ${String(f.w).padStart(3)}x${f.h}  ${String(f.data.length).padStart(6)} 字节  ${f.kind}`);
}
