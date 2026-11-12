// The brand's pictures, made ready in the browser before they are uploaded
// (Settings → Brand; the limits are the server's, ext/brand/pictures.js):
//   - a JPG, PNG or WebP, or an SVG — which is drawn to a PNG here and never
//     stored (an SVG shown as a picture can't run script or fetch anything,
//     and what leaves this file is a bitmap);
//   - a logo: longest side 1,024 px, 512 KB at most, at least 64 px tall;
//   - the square mark: padded to square, 512 px;
//   - the app's icons, drawn from the mark: 192, 512, a 512 "maskable" with
//     the mark at 70% on a solid ground, a 180 touch icon on a solid ground.
// And the check a manager is warned by: how much of a logo can be seen on
// the grounds it will sit on (brand-notes.js hiddenShare).
import { action } from '../api.js';
import { at } from '../base.js';
import { toDataUrl } from './MarkdownField.jsx';
import { hiddenShare } from './brand-notes.js';

const MAX_BYTES = 512 * 1024;
const LONGEST = 1024;
const MIN_TALL = 64;
const MARK = 512;
const MARK_MIN = 180;
const num = (n) => Number(n).toLocaleString('en-CA');

const isSvg = (file) => file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');
const isPicture = (file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || isSvg(file);
export const BRAND_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,.svg';

const loadFrom = (src) => new Promise((resolve, reject) => {
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = () => reject(new Error('That picture couldn’t be read. Save it again as a PNG and try again.'));
  im.src = src;
});
// A file (or a picture already on this server, by its address) as an image
// with a size. An SVG that states no size takes its viewBox's.
const loadPicture = async (file) => {
  const blob = isSvg(file) && file.type !== 'image/svg+xml' ? new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' }) : file;
  const url = URL.createObjectURL(blob);
  try {
    const im = await loadFrom(url);
    let w = im.naturalWidth; let h = im.naturalHeight;
    if (isSvg(file) && (!w || !h)) {
      const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(await file.text());
      w = box ? Number(box[1]) : 300; h = box ? Number(box[2]) : 150;
    }
    if (!w || !h) throw new Error('That picture couldn’t be read. Save it again as a PNG and try again.');
    return { im, w, h, svg: isSvg(file), photo: file.type === 'image/jpeg' };
  } finally {
    // The image is decoded by now; a later draw doesn't need the address.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
};
const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
// The canvas as a file. A browser won't give back a canvas an SVG drew a
// web page's text on (a foreignObject, as some drawing tools export text):
// said in words a manager can act on.
const blobOf = (canvas, type = 'image/png', q) => new Promise((resolve, reject) => {
  try { canvas.toBlob(resolve, type, q); } catch { reject(new Error('This SVG can’t be turned into a picture here. Save it as a PNG and upload that.')); }
});

// A logo within the limits: drawn smaller until it fits (a photo as a JPG,
// anything else as a PNG, which keeps its see-through parts). An SVG has no
// size of its own, so it is drawn as large as a logo may be.
export async function fitLogo(file, word = 'logo') {
  if (!isPicture(file)) throw new Error('Use a JPG, PNG or WebP picture, or an SVG.');
  const p = await loadPicture(file);
  let scale = p.svg ? LONGEST / Math.max(p.w, p.h) : Math.min(1, LONGEST / Math.max(p.w, p.h));
  for (let i = 0; i < 8; i += 1) {
    const w = Math.max(1, Math.round(p.w * scale));
    const h = Math.max(1, Math.round(p.h * scale));
    if (h < MIN_TALL) {
      throw new Error(i === 0 && scale === 1
        ? `This ${word} is ${num(h)} px tall — it needs at least ${num(MIN_TALL)} px to stay sharp. Use a bigger file.`
        : `This ${word} is too wide or too heavy to keep sharp. Crop it closer to the ${word}, or use a simpler file.`);
    }
    const canvas = canvasOf(w, h);
    const g = canvas.getContext('2d');
    if (p.photo) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
    g.drawImage(p.im, 0, 0, w, h);
    const blob = await blobOf(canvas, p.photo ? 'image/jpeg' : 'image/png', 0.86);
    if (blob && blob.size <= MAX_BYTES) return { blob, w, h, canvas };
    scale *= 0.8;
  }
  throw new Error(`This ${word} is too big — try a simpler file.`);
}

// The square mark: the picture whole, centred on a see-through square.
export async function fitMark(file) {
  if (!isPicture(file)) throw new Error('Use a JPG, PNG or WebP picture, or an SVG.');
  const p = await loadPicture(file);
  if (!p.svg && Math.max(p.w, p.h) < MARK_MIN) throw new Error(`This square mark is ${num(p.w)} × ${num(p.h)} px — it needs at least ${num(MARK_MIN)} × ${num(MARK_MIN)} to stay sharp.`);
  for (const side of [MARK, 384, 256, MARK_MIN]) {
    if (!p.svg && side > Math.max(p.w, p.h) && side !== MARK_MIN) continue; // never drawn bigger than it is
    const canvas = canvasOf(side, side);
    const k = side / Math.max(p.w, p.h);
    const w = p.w * k; const h = p.h * k;
    canvas.getContext('2d').drawImage(p.im, (side - w) / 2, (side - h) / 2, w, h);
    const blob = await blobOf(canvas);
    if (blob && blob.size <= MAX_BYTES) return { blob, w: side, h: side, canvas };
  }
  throw new Error('This square mark is too big — try a simpler file.');
}

// The ground an icon gets where it must be solid (a phone's home screen
// fills see-through parts with black): the mark's own corner when it has
// one, else white.
const groundOf = (canvas) => {
  const [r, g, b, a] = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
  return a >= 250 ? `rgb(${r}, ${g}, ${b})` : '#ffffff';
};
const iconOf = (mark, side, { ground = null, share = 1 } = {}) => {
  const canvas = canvasOf(side, side);
  const g = canvas.getContext('2d');
  if (ground) { g.fillStyle = ground; g.fillRect(0, 0, side, side); }
  const s = side * share;
  g.imageSmoothingQuality = 'high';
  g.drawImage(mark, (side - s) / 2, (side - s) / 2, s, s);
  return blobOf(canvas);
};
// mark: the canvas fitMark gave. → the four icons as PNGs, by their kind.
export async function iconsFrom(mark) {
  const ground = groundOf(mark);
  return {
    icon192: await iconOf(mark, 192),
    icon512: await iconOf(mark, 512),
    // A launcher may crop a maskable icon to a circle: the mark keeps to the
    // middle 70%.
    maskable: await iconOf(mark, 512, { ground, share: 0.7 }),
    // A mark that fills its square keeps it; a see-through one gets a margin.
    touch: await iconOf(mark, 180, { ground, share: ground === '#ffffff' ? 0.86 : 1 }),
  };
}

// One of the brand's pictures, kept by the server: → { id, type, w, h, url }.
export async function uploadBrandPicture(kind, blob, name = '') {
  const res = await action('brand.picture', { kind, data: await toDataUrl(blob), name: String(name).slice(0, 200) });
  const p = res.picture;
  return { id: p.id, type: p.type, w: p.width, h: p.height, url: p.url };
}

// A picture already on this server (a look's own logo, the website's), as a
// file to make ready like any other.
export async function fileFrom(url) {
  const res = await fetch(at(url));
  if (!res.ok) throw new Error('That picture couldn’t be fetched. Upload it here instead.');
  const blob = await res.blob();
  return new File([blob], url.split('/').pop() || 'logo', { type: blob.type });
}

// How much of a picture is hidden on each ground (brand-notes.js), read at
// 200 px wide. url: this server's own address for it.
export async function seenOn(url, grounds) {
  const im = await loadFrom(at(url));
  const w = 200;
  const h = Math.max(1, Math.round((im.naturalHeight / Math.max(1, im.naturalWidth)) * w));
  const canvas = canvasOf(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0, w, h);
  const { data } = g.getImageData(0, 0, w, h);
  return grounds.map((ground) => hiddenShare(data, ground));
}
