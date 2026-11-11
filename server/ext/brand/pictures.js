// The campaign's pictures for its brand (Settings → Brand): the logo, a
// logo for dark backgrounds, a square mark, and the app icons the browser
// makes from the mark. They live in the website's and Outreach's store
// (the media table: JPG, PNG or WebP, the type read from the file's own
// first bytes) under tighter limits, because every phone draws them: the
// size is read from the bytes too, never taken from what the browser says.
// The browser shrinks a picture and turns an SVG into a PNG before it
// uploads (an SVG is never stored), so a manager meets these limits only
// with a file the browser could not shrink.
import { sniffImage } from '../abtests/media.js';

export const BRAND_PICTURE_MAX = 512 * 1024;

// kind → what it is called on screen, and its sizes.
//   longest   the longest side at most (px)
//   minTall   at least this tall (a logo drawn 36 px tall on a sharp screen)
//   square    as wide as tall, between minSide and longest
//   exact     [w, h] and a PNG: an app icon, declared at that size
export const BRAND_PICTURES = {
  logo: { word: 'logo', longest: 1024, minTall: 64 },
  logoDark: { word: 'logo for dark backgrounds', longest: 1024, minTall: 64 },
  mark: { word: 'square mark', square: true, minSide: 180, longest: 1024 },
  icon192: { word: 'app icon', exact: [192, 192] },
  icon512: { word: 'app icon', exact: [512, 512] },
  maskable: { word: 'app icon', exact: [512, 512] },
  touch: { word: 'home-screen icon', exact: [180, 180] },
};
export const BRAND_PICTURE_KINDS = Object.keys(BRAND_PICTURES);
export const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// A picture's width and height, read from its own header, or null when the
// header can't be read. PNG: the IHDR chunk. JPEG: the first frame header
// (SOFn). WebP: the VP8 (lossy), VP8L (lossless) or VP8X (extended) header.
export const imageSize = (buf) => {
  const type = sniffImage(buf);
  try {
    if (type === 'image/png') {
      if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (type === 'image/webp') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
      return null;
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xff) { i += 1; continue; } // fill
        // Markers with no length: RSTn, SOI, EOI, TEM.
        if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
        // A frame header (SOF0–SOF15, not DHT, JPG or DAC) holds the size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
  } catch { /* a header cut short */ }
  return null;
};

const num = (n) => Number(n).toLocaleString('en-CA');
const px = (n) => `${num(n)} px`;
const dims = (w, h) => `${num(w)} × ${num(h)}`;

// Why a picture can't be this kind of brand picture, in the manager's words
// — or null when it can. buf: the file's bytes.
export const pictureProblem = (kind, buf) => {
  const rule = BRAND_PICTURES[kind];
  if (!rule) return 'that isn’t one of the brand’s pictures';
  const type = sniffImage(buf);
  if (!type) return 'use a JPG, PNG or WebP picture';
  if (buf.length > BRAND_PICTURE_MAX) return `this ${rule.word} is too big — 512 KB at most. Choose it again here and it is made smaller for you.`;
  const size = imageSize(buf);
  if (!size || !size.w || !size.h) return `this ${rule.word} can’t be read — save it again as a PNG and try again`;
  const { w, h } = size;
  if (rule.exact) {
    const [ew, eh] = rule.exact;
    if (type !== 'image/png' || w !== ew || h !== eh) return `the ${rule.word} must be a PNG of ${dims(ew, eh)} px — this one is ${type === 'image/png' ? '' : `a ${EXT[type].toUpperCase()} of `}${dims(w, h)}`;
    return null;
  }
  if (Math.max(w, h) > rule.longest) return `this ${rule.word} is ${dims(w, h)} px — ${px(rule.longest)} at most on its longest side. Choose it again here and it is made smaller for you.`;
  if (rule.square) {
    if (w !== h) return `the ${rule.word} must be square — this one is ${dims(w, h)} px`;
    if (w < rule.minSide) return `the ${rule.word} is ${dims(w, h)} px — it needs at least ${dims(rule.minSide, rule.minSide)} to stay sharp`;
    return null;
  }
  if (h < rule.minTall) return `this ${rule.word} is ${px(h)} tall — it needs at least ${px(rule.minTall)} to stay sharp. Use a bigger file.`;
  return null;
};
