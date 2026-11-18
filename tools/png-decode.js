'use strict';
/*
 * 极简 PNG 解码器 —— 只处理 ICO 里会遇到的那一种：
 *   8bit / colorType=6(RGBA) / 非隔行 / 无调色板
 *
 * 为什么要自己解：把 PNG 帧转成 DIB 帧需要原始像素，而项目零依赖不能装 sharp。
 * PNG 的压缩体就是 zlib，Node 自带 zlib，所以只差「解 IDAT + 反 filter」这一步。
 */
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解析 PNG，返回 { width, height, rgba: Buffer(w*h*4) } */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG');

  let off = 8;
  let ihdr = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // len(4) + type(4) + data + crc(4)
  }

  if (!ihdr) throw new Error('缺少 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${ihdr.bitDepth}`);
  if (ihdr.colorType !== 6) throw new Error(`只支持 RGBA(colorType 6)，实际 ${ihdr.colorType}`);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG');

  const { width, height } = ihdr;
  const bpp = CHANNELS[ihdr.colorType]; // 4
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error(`IDAT 长度不足：${raw.length} < ${expected}`);

  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0; // 左
      const b = prev ? prev[x] : 0; // 上
      const c = prev && x >= bpp ? prev[x - bpp] : 0; // 左上
      let v = src[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: throw new Error(`未知 filter ${filter} @ row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }

  return { width, height, rgba: out };
}

module.exports = { decodePng, SIG };
