// Pictures for the brand tests, made here so no file has to be kept: a
// real PNG of any size (one colour, or noise that won't shrink), and the
// headers of a JPEG and a WebP — all the server reads of a picture (its
// type and size), never decoded.
import { deflateSync, crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
};

export const png = (w, h, { noise = false, rgba = [0, 57, 121, 255] } = {}) => {
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])]);
  const rows = [];
  const solid = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x += 1) solid.set(rgba, 1 + x * 4);
  for (let y = 0; y < h; y += 1) rows.push(noise ? Buffer.concat([Buffer.from([0]), randomBytes(w * 4)]) : solid);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: noise ? 0 : 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
};

// SOI, a JFIF header, a baseline frame header (the size), EOI.
export const jpeg = (w, h) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xd9]),
]);

// A lossless WebP's header: the size in 14 + 14 bits after the 0x2f signature.
export const webp = (w, h) => {
  const data = Buffer.concat([Buffer.from([0x2f]), u32le(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14))]);
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from('VP8L'), u32le(data.length), data, Buffer.alloc(1)]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
};

export const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;
