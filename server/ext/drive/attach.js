// A file from Google Drive as an ordinary attachment, with every existing
// limit: blast.attach.drive (Outreach) and media.attach.drive (Media), by
// their prefixes. Google files (Docs, Sheets, Slides, Drawings) go as PDF;
// anything else as its own bytes, if the email attachments take its type.
// Google is read in before (no lock); the handler stores what came, as
// blast.attach does (storeAttachment), the event saying only from: 'drive'.
//
// Too big (over 5 MB by Drive's size, or cut off at 5 MB as it streams):
// 409 { error, link: true } — the compose offers a link instead (links.js).
// A Google file too big as a PDF gets link: false.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { ATTACH_KINDS, ATTACH_MAX, extFor, mb, storeAttachment, typeOf } from '../abtests/attach.js';
import { deskOnly, gate, refused, usableGrant } from './grant.js';
import { AS_PDF, getFile, mediaUrl, pdfUrl, refusal } from './files.js';
import { FILE_ID } from './reads.js';
import { openStream, readUpTo } from './stream.js';

export const EVERYONE = ['manager', 'treasurer', 'staff', 'volunteer'];
const GOOGLE = 'application/vnd.google-apps.';
const why = (r) => (r.plain ? r : { ...r, ...refusal(r) });
const clean = (name) => String(name || 'Untitled').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 190) || 'Untitled';
const sizeOf = (n) => (n < 10 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : mb(n));

const fromDrive = async (db, ctx, input) => {
  gate(ctx);
  const g = await usableGrant(db, ctx);
  const f = await getFile(db, g, input.file_id);
  if (!f.ok) throw refused(f, { picked: true });
  const file = f.file;
  const google = file.mimeType.startsWith(GOOGLE);
  let filename = clean(file.name);
  if (google) {
    if (!AS_PDF.includes(file.mimeType)) throw httpError(409, `use ${ATTACH_KINDS}`);
    filename = `${filename}.pdf`;
  } else if (!typeOf(filename) && extFor(file.mimeType)) {
    filename = `${filename}.${extFor(file.mimeType)}`;
  }
  const tooBig = (size) => Object.assign(httpError(409, `${file.name} is ${size} — too big to attach (${mb(ATTACH_MAX)} at most)`), { link: !google });
  // Size first: a 24 MB video can't be attached whatever its type, and a
  // link to it is what people want.
  if (file.size != null && file.size > ATTACH_MAX) throw tooBig(sizeOf(file.size));
  const type = google ? 'application/pdf' : typeOf(filename);
  if (!type) throw httpError(409, `use ${ATTACH_KINDS}`);
  const r = await openStream(db, g, google ? pdfUrl(file.id) : mediaUrl(file.id));
  if (!r.ok) {
    if (why(r).reason === 'exportSizeLimitExceeded') throw tooBig('over 10 MB as a PDF');
    throw refused(why(r), { picked: true });
  }
  const got = await readUpTo(r.body, ATTACH_MAX);
  if (got.over) throw tooBig(`over ${mb(ATTACH_MAX)}`);
  if (!got.buf.length) throw httpError(409, 'empty file');
  return { buf: got.buf, filename, type };
};

const attach = {
  roles: EVERYONE,
  input: z.object({ file_id: z.string().trim().regex(FILE_ID) }),
  before: fromDrive,
  handler: async (tx, ctx, input, emit, ready) => {
    deskOnly(ctx);
    return { attachment: await storeAttachment(tx, ctx, emit, { ...ready, from: 'drive' }) };
  },
};

export const attachActions = {
  'blast.attach.drive': attach,
  'media.attach.drive': { ...attach },
};
