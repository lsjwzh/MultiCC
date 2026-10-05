'use strict';

// All regions use main-display logical points, independent of JPEG/RFB pixels.
function parseRegion(value = {}) {
  const keys = ['x', 'y', 'width', 'height'];
  if (!keys.some(k => value[k] !== undefined)) return null;
  const r = Object.fromEntries(keys.map(k => [k, Number(value[k])]));
  if (keys.some(k => !['number', 'string'].includes(typeof value[k]) || String(value[k]).trim() === '' || !Number.isFinite(r[k]))
    || r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1
    || keys.some(k => r[k] > 100000)) {
    throw Object.assign(new Error('invalid-region'), { status: 400 });
  }
  return r;
}

function cropGeometry(region, screen, pixels) {
  const x = Math.floor(region.x), y = Math.floor(region.y);
  const right = Math.min(screen.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(screen.height, Math.ceil(region.y + region.height));
  if (right <= x || bottom <= y) throw Object.assign(new Error('region-outside-screen'), { status: 400 });
  const sx = pixels.w / screen.width, sy = pixels.h / screen.height;
  const px = Math.floor(x * sx), py = Math.floor(y * sy);
  const pw = Math.min(pixels.w, Math.ceil(right * sx)) - px;
  const ph = Math.min(pixels.h, Math.ceil(bottom * sy)) - py;
  // Return the actual covered area after physical-pixel rounding.
  return { x: px / sx, y: py / sy, width: pw / sx, height: ph / sy,
    pixelX: px, pixelY: py, pixelWidth: pw, pixelHeight: ph };
}

module.exports = { parseRegion, cropGeometry };
