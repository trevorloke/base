/** What a file is, from its bytes. Never trust the client's filename or content-type. */
export interface Probe {
  kind: "image" | "video" | "gif" | "document";
  mime: string;
  ext: string;
  width?: number;
  height?: number;
}

const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const le16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const be32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));

export function probe(b: Uint8Array): Probe | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { kind: "image", mime: "image/png", ext: "png", width: be32(b, 16), height: be32(b, 20) };
  if (ascii(b, 0, 3) === "GIF") return { kind: "gif", mime: "image/gif", ext: "gif", width: le16(b, 6), height: le16(b, 8) };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    let width: number | undefined;
    let height: number | undefined;
    if (chunk === "VP8X") {
      width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    } else if (chunk === "VP8 ") {
      width = le16(b, 26) & 0x3fff;
      height = le16(b, 28) & 0x3fff;
    } else if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    return { kind: "image", mime: "image/webp", ext: "webp", ...(width ? { width, height } : {}) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      const len = be16(b, o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { kind: "image", mime: "image/jpeg", ext: "jpg", height: be16(b, o + 5), width: be16(b, o + 7) };
      }
      o += 2 + len;
    }
    return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  }
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    return brand === "qt  " ? { kind: "video", mime: "video/quicktime", ext: "mov" } : { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: "video", mime: "video/webm", ext: "webm" };
  if (ascii(b, 0, 5) === "%PDF-") return { kind: "document", mime: "application/pdf", ext: "pdf" };
  return null;
}

/** Duration of an MP4/MOV from its mvhd box. Null when the box is not in the bytes. */
export function mp4DurationSeconds(b: Uint8Array): number | null {
  const find = (start: number, end: number, type: string): number | null => {
    let o = start;
    while (o + 8 <= end) {
      let size = be32(b, o);
      const t = ascii(b, o + 4, 4);
      let header = 8;
      if (size === 1) {
        size = be32(b, o + 12) + be32(b, o + 8) * 2 ** 32;
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header) return null;
      if (t === type) return o + header;
      o += size;
    }
    return null;
  };
  const moov = find(0, b.length, "moov");
  if (moov === null) return null;
  const mvhd = find(moov, b.length, "mvhd");
  if (mvhd === null) return null;
  const version = b[mvhd]!;
  if (version === 1) {
    const timescale = be32(b, mvhd + 20);
    const duration = be32(b, mvhd + 24) * 2 ** 32 + be32(b, mvhd + 28);
    return timescale ? duration / timescale : null;
  }
  const timescale = be32(b, mvhd + 12);
  const duration = be32(b, mvhd + 16);
  return timescale ? duration / timescale : null;
}

/**
 * MP4/MOV duration without holding the file: walks top-level boxes with small ranged reads until `moov` (which
 * may sit at the end of files that were not "fast-started"), then reads only that box.
 */
export async function mp4DurationFromRanges(read: (start: number, length: number) => Promise<Uint8Array>, size: number, maxMoovBytes = 8 * 1024 * 1024): Promise<number | null> {
  let o = 0;
  for (let boxes = 0; o + 8 <= size && boxes < 64; boxes++) {
    const h = await read(o, 16);
    if (h.length < 8) return null;
    let boxSize = be32(h, 0);
    const type = ascii(h, 4, 4);
    if (boxSize === 1) {
      if (h.length < 16) return null;
      boxSize = be32(h, 12) + be32(h, 8) * 2 ** 32;
    } else if (boxSize === 0) boxSize = size - o;
    if (boxSize < 8) return null;
    if (type === "moov") {
      if (boxSize > maxMoovBytes) return null;
      return mp4DurationSeconds(await read(o, boxSize));
    }
    o += boxSize;
  }
  return null;
}
