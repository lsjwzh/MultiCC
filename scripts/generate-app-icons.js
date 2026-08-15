#!/usr/bin/env node
'use strict';
// Regenerate every platform launcher-icon slot from app/assets/branding/icon.svg.
//
// Run this after any edit to that SVG:  node scripts/generate-app-icons.js
//
// The SVG is the single source; the PNGs under ios/.../AppIcon.appiconset and
// android/.../res/mipmap-* are generated artefacts that must be regenerated and
// committed together with it. They drifted apart once already — the SVG was
// updated and shipped while every PNG stayed on the Flutter scaffold default,
// so the app kept the old icon. Committing this script makes that failure mode
// a one-command fix instead of an archaeology exercise.
//
// Rasterising goes through headless Chrome because this repo has no imaging
// dependency, and the PNG codec below is hand-rolled because iOS rejects app
// icons carrying an alpha channel and sips cannot strip one.

const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const path = require('path');
const { execFileSync } = require('child_process');

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error('only 8-bit supported, got ' + depth);
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error('unsupported color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

function encodePNG(width, height, rgba, { alpha }) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // no filter: these are tiny, deflate handles it
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = y * (stride + 1) + 1 + x * channels;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// Area-average downsample. Premultiplies so the transparent surround of the
// adaptive foreground does not bleed dark fringes into the glow.
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * sw + sx) * 4, sa = src[s + 3] / 255;
          r += src[s] * sa; g += src[s + 1] * sa; b += src[s + 2] * sa;
          a += src[s + 3]; n++;
        }
      }
      const d = (y * dw + x) * 4, am = a / n;
      const un = am > 0 ? (n * 255) / a : 0;
      out[d] = Math.round(Math.min(255, (r / n) * un));
      out[d + 1] = Math.round(Math.min(255, (g / n) * un));
      out[d + 2] = Math.round(Math.min(255, (b / n) * un));
      out[d + 3] = Math.round(am);
    }
  }
  return out;
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.env.CHROME_PATH,
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'no Chromium-family browser found for rasterising; set CHROME_PATH to one');
}

// Two masters off the same SVG: the full artwork for the square/legacy icons,
// and a background-free copy for the Android adaptive foreground layer (the
// launcher supplies its own background and parallaxes the layers separately).
function renderMasters(svgPath) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const foreground = svg.replace(/\n *<rect width="1024" height="1024" fill="url\(#bg\)"\/>/, '');
  if (foreground === svg) {
    throw new Error('could not strip the background rect; did icon.svg change shape?');
  }

  const chrome = findChrome();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-icons-'));
  const shell = '<!doctype html><meta charset=utf-8>'
    + '<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>';

  const render = (markup, name) => {
    const html = path.join(workDir, `${name}.html`);
    const png = path.join(workDir, `${name}.png`);
    fs.writeFileSync(html, shell + markup);
    execFileSync(chrome, [
      '--headless', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--window-size=1024,1024',
      `--screenshot=${png}`,
      `file://${html}`,
    ], { stdio: 'ignore' });
    return decodePNG(fs.readFileSync(png));
  };

  try {
    return { full: render(svg, 'full'), fg: render(foreground, 'fg') };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const root = process.argv[2] || path.resolve(__dirname, '..');
const { full, fg } = renderMasters(path.join(root, 'app/assets/branding/icon.svg'));

function emit(master, target, size, alpha) {
  const data = size === master.width
    ? master.data
    : resize(master.data, master.width, master.height, size, size);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePNG(size, size, data, { alpha }));
  return `${path.relative(root, target)} ${size}x${size} ${alpha ? 'RGBA' : 'RGB'}`;
}

const written = [];

// iOS — every slot in the existing appiconset, opaque (App Store rejects alpha).
const IOS = [
  ['Icon-App-20x20@1x.png', 20], ['Icon-App-20x20@2x.png', 40], ['Icon-App-20x20@3x.png', 60],
  ['Icon-App-29x29@1x.png', 29], ['Icon-App-29x29@2x.png', 58], ['Icon-App-29x29@3x.png', 87],
  ['Icon-App-40x40@1x.png', 40], ['Icon-App-40x40@2x.png', 80], ['Icon-App-40x40@3x.png', 120],
  ['Icon-App-60x60@2x.png', 120], ['Icon-App-60x60@3x.png', 180],
  ['Icon-App-76x76@1x.png', 76], ['Icon-App-76x76@2x.png', 152],
  ['Icon-App-83.5x83.5@2x.png', 167],
  ['Icon-App-1024x1024@1x.png', 1024],
];
const iosDir = path.join(root, 'app/ios/Runner/Assets.xcassets/AppIcon.appiconset');
for (const [name, size] of IOS) written.push(emit(full, path.join(iosDir, name), size, false));

// Android legacy launcher icon, plus the adaptive foreground layer at 108dp.
const DPI = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];
const resDir = path.join(root, 'app/android/app/src/main/res');
for (const [bucket, scale] of DPI) {
  written.push(emit(full, path.join(resDir, `mipmap-${bucket}/ic_launcher.png`), Math.round(48 * scale), false));
  written.push(emit(fg, path.join(resDir, `mipmap-${bucket}/ic_launcher_foreground.png`), Math.round(108 * scale), true));
}

console.log(written.join('\n'));
