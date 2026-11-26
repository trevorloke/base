// Nothing of one client's reaches another: the built app (web/dist), the
// files the server hands out as written, and every file name among them,
// are scanned for the words in server/test/neutral-words/*.txt — one word
// or phrase a line, any case, whole words only ("Locke" is not in "blocked").
//
//   npm run build && npm run test:bundle
//
// It ends 1 when a word is found, and says where.
//
// A list with a marker beside it (n2-fields.txt + n2-fields.pending) belongs
// to work not done yet: its finds are shown and do not fail. A marker may
// also hold lines of its own — words from another list that are still in the
// build only because of that same unfinished work, optionally "word @ part
// of a file's name": those finds are shown and do not fail either, until the
// marker is deleted. The work that finishes a part deletes its marker.
//
// server/test/neutral-boot.test.js uses the same lists on what a neutral
// campaign's server answers.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const WORDS_DIR = join(ROOT, 'server/test/neutral-words');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words: no letter or digit right before or after.
const finder = (word) => new RegExp(`(?<![A-Za-z0-9])${escape(word)}(?![A-Za-z0-9])`, 'gi');
const lines = (file) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// → [{ group, pending, words: [{ word, re }] }] and the marker's own lines:
// [{ group, word, where }] (where: part of a file's name, or '' for any).
export const loadWords = (dir = WORDS_DIR) => {
  const names = readdirSync(dir).sort();
  const groups = names.filter((n) => n.endsWith('.txt')).map((n) => {
    const group = n.slice(0, -4);
    return { group, pending: names.includes(`${group}.pending`), words: lines(join(dir, n)).map((word) => ({ word, re: finder(word) })) };
  });
  const owed = names.filter((n) => n.endsWith('.pending')).flatMap((n) => lines(join(dir, n)).map((l) => {
    const [word, where = ''] = l.split(' @ ').map((x) => x.trim());
    return { group: n.slice(0, -8), word: word.toLowerCase(), where };
  }));
  return { groups, owed };
};

// One text → its finds: [{ group, word, at, near, pending, owedTo }].
export const findIn = (text, name, { groups, owed }) => {
  const out = [];
  for (const g of groups) {
    for (const { word, re } of g.words) {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (!m) continue;
      const excuse = g.pending ? null : owed.find((o) => o.word === word.toLowerCase() && (!o.where || name.includes(o.where)));
      out.push({
        group: g.group, word, at: name, pending: g.pending, owedTo: excuse ? excuse.group : null,
        near: text.slice(Math.max(0, m.index - 40), m.index + word.length + 40).replace(/\s+/g, ' '),
      });
    }
  }
  return out;
};

const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
}) : []);
const TEXT = /\.(js|mjs|css|html|json|webmanifest|svg|txt|xml|map|md)$/i;

// Everything every campaign is handed: the built app, the two files served
// as written, and the names of every file under the built app and the
// website's assets.
export const scanBuild = (words = loadWords()) => {
  const dist = join(ROOT, 'web/dist');
  const built = walk(dist);
  const asWritten = ['shared/site/site.css', 'shared/site/embed.js'].map((p) => join(ROOT, p)).filter(existsSync);
  const named = [...built, ...walk(join(ROOT, 'shared/site/assets'))];
  const finds = [];
  for (const file of [...built.filter((f) => TEXT.test(f)), ...asWritten]) {
    finds.push(...findIn(readFileSync(file, 'utf8'), relative(ROOT, file), words));
  }
  for (const file of named) {
    const name = relative(ROOT, file);
    finds.push(...findIn(name, `${name} (the file's name)`, words));
  }
  return { finds, files: built.length };
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (!existsSync(join(ROOT, 'web/dist/index.html'))) {
    console.error('web/dist is not built: run `npm run build` first.');
    process.exit(2);
  }
  const words = loadWords();
  const { finds, files } = scanBuild(words);
  const say = (f) => `  ${f.group}: “${f.word}” in ${f.at}\n      …${f.near}…`;
  const failing = finds.filter((f) => !f.pending && !f.owedTo);
  const waiting = finds.filter((f) => f.pending || f.owedTo);
  const pendingGroups = words.groups.filter((g) => g.pending).map((g) => g.group);
  console.log(`Scanned ${files} built files, the files served as written, and every file name.`);
  if (waiting.length) {
    console.log(`\nStill there, waiting on work not done yet (${pendingGroups.join(', ') || 'none'}): ${waiting.length}`);
    for (const f of waiting) console.log(`${say(f)}${f.owedTo ? `\n      (owed to ${f.owedTo})` : ''}`);
  }
  if (failing.length) {
    console.error(`\nFOUND: ${failing.length} — one client's own words are in what every campaign is handed:`);
    for (const f of failing) console.error(say(f));
    process.exit(1);
  }
  console.log(`\nClean: no word of the live lists (${words.groups.filter((g) => !g.pending).map((g) => g.group).join(', ')}) is in the build.`);
}
