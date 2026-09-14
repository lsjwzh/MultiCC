'use strict';
// 最小 PNG 解码 + 取样口，只服务于「到底画出来了没有」这一类断言。
//
// 为什么要有它：彩虹圈坏掉的那种方式（圈被不透明后代盖住）在 DOM 里完全看不出来
// —— class 该在的都在、几何该对的都对、getComputedStyle 也照样报着动画在跑，只有
// 真正落到屏幕上的那几像素知道不对劲。要断这种事就只能读截图，而 node 里没有内置
// 解码。这里只做够用的一份：8 位、非隔行、颜色类型 2/6（RGB / RGBA），正好是
// CDP Page.captureScreenshot 会给的两种。要更多就去依赖一个库，别在这里长。
//
// 用法：const { captureRegion, saturation } = require('./helpers/png-pixels');
//      const shot = await captureRegion(page, { x, y, width, height });
//      saturation(shot.at(4, 2)) // → 0 表示灰/白，越大越彩

const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 的 Paeth 预测器（过滤类型 4）：取三个邻居里和 p 最接近的那个。
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** 解出一张 8 位非隔行 PNG 的像素，返回 { width, height, at(x, y) → [r,g,b] }。 */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG');
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，拿到 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`只支持颜色类型 2/6，拿到 ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      const v = line[x];
      if (filter === 0) out[x] = v;
      else if (filter === 1) out[x] = (v + a) & 0xff;
      else if (filter === 2) out[x] = (v + b) & 0xff;
      else if (filter === 3) out[x] = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) out[x] = (v + paeth(a, b, c)) & 0xff;
      else throw new Error(`未知的过滤类型 ${filter}`);
    }
    previous = out;
  }
  return {
    width, height,
    at(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`取样越界 (${x}, ${y}) / ${width}×${height}`);
      const i = y * stride + x * channels;
      return [pixels[i], pixels[i + 1], pixels[i + 2]];
    },
  };
}

/** 截一块区域并解成像素。坐标是页面 CSS 像素，和 getBoundingClientRect 同一套。 */
async function captureRegion(page, { x, y, width, height, scale = 1 }) {
  const captured = await page.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
    clip: { x: Math.max(0, x), y: Math.max(0, y), width, height, scale },
  });
  return decodePng(Buffer.from(captured.data, 'base64'));
}

/** 饱和度 = 最大通道减最小通道。白/灰/淡底色接近 0，纯色相接近 255。 */
const saturation = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);

module.exports = { decodePng, captureRegion, saturation };
