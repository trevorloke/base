#!/bin/bash
# What Imagine Surrey's server answers, saved to a folder, so two versions of
# the code can be compared with `diff -r`.
#
#   scripts/preset-dump.sh OUT_DIR [PORT]
#
# It starts this checkout's server on PORT (default 4790) with an in-memory
# database and Imagine Surrey's production settings (render.yaml, base-win),
# signs up the first manager, and saves:
#   api/         110 signed-in API reads
#   pages/       47 pages signed in (body and headers)
#   pages-anon/  8 pages signed out
#   extra/       the old and new training addresses, the icons and website
#                pictures, the website after first use, one membership with a
#                Star Club gift, and the sample data
# OUT_DIR/raw is as answered. OUT_DIR/norm is the same with ids, dates, the
# commit and the built files' names replaced by fixed words: compare that one.
#
#   diff -r before/norm after/norm
#
# Take both sides on the same side of the campaign's midnight: two answers
# (texting's quiet hours) say "9 am tomorrow" before it and "9 am" after.
#
# Run `npm run build` first: the app's page is the built one.
# PRESET_DUMP_DATA=/path/to/folder uses a database kept on disk instead (the
# script signs in when the campaign is already set up).
# PRESET_DUMP_BRAND= (empty) leaves BASE_BRAND unset.
set -u
OUT=${1:?usage: scripts/preset-dump.sh OUT_DIR [PORT]}
P=${2:-4790}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
RAW=$OUT/raw
rm -rf "$RAW" "$OUT/norm"
mkdir -p "$RAW/api" "$RAW/pages" "$RAW/pages-anon" "$RAW/extra"
JAR=$OUT/cookies.jar
rm -f "$JAR"
URL=http://127.0.0.1:$P

# Imagine Surrey's production settings: render.yaml, the base-win service.
# No candidates, map area or province are set there.
export BASE_ENV=production
export BASE_ORG_NAME="Imagine Surrey"
export BASE_CITY=Surrey
export BASE_JURISDICTION=bc-municipal
export BASE_TZ=America/Vancouver
export BASE_SLATES="council:City council,school_board:School board"
# A setting cleared here is cleared under both its names: an older name left in
# the shell would still be read (shared/old-names.js holds both).
both() { node --input-type=module -e "import { bothNames } from '$ROOT/shared/old-names.js'; console.log(process.argv.slice(1).flatMap(bothNames).join(' '))" "$@"; }
if [ "${PRESET_DUMP_BRAND-imagine-surrey}" = "" ]; then unset $(both BASE_BRAND); else export BASE_BRAND="${PRESET_DUMP_BRAND-imagine-surrey}"; fi
unset $(both BASE_CANDIDATES BASE_GEO_BOUNDS BASE_PROVINCE BASE_PUBLIC_URL BASE_OPEN_SIGNUP) NODE_ENV RENDER DATABASE_URL BASE_PATH
export BASE_DATA=${PRESET_DUMP_DATA:-memory}
export GEOCODE_ON_SAVE=off

PORT=$P node "$ROOT/server/index.js" > "$OUT/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null' EXIT
for i in $(seq 1 120); do
  curl -s -o /dev/null "$URL/api/health" && break
  kill -0 $SERVER 2>/dev/null || { echo "the server stopped: see $OUT/server.log" >&2; exit 1; }
  sleep 0.5
done

EMAIL=pat@example.test
PASS=correct-horse-battery-9
code=$(curl -s -c "$JAR" -o "$RAW/auth-signup.json" -w "%{http_code}" -H 'content-type: application/json' \
  -d "{\"name\":\"Pat Manager\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$URL/api/auth/signup")
if [ "$code" != "200" ]; then
  code=$(curl -s -c "$JAR" -o "$RAW/auth-signup.json" -w "%{http_code}" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$URL/api/auth/login")
fi
[ "$code" = "200" ] || { echo "could not sign up or sign in ($code): see $RAW/auth-signup.json" >&2; exit 1; }

name_of() { local n; n=$(echo "$1" | sed 's#^/##; s#/#_#g'); [ -z "$n" ] && n=root; echo "$n"; }

# ── 110 API reads, signed in ──
API="auth/me auth/setup health scale fields audience/choices lists lists/tags scripts templates learn learn/progress media/contacts media/outlets media/releases media/stats letters/outlets media/letters letters/mine site site/campaigns site/pictures site/posts site/fonts site/fonts/catalogue site/languages site/microsites guide site/guide membership/form payments receipts receipts/needs money/filing-dates brief dashboard map/config map/credit map/check map/check/services pathtowin ladders surveys surveys/active texting/settings texting/status senders mail/domain integrations admin/permissions teams team members candidates candidate/home banks passes reports quick-reports-menu schedule/week places gotv/setup gotv/places voted/status voted/summary stewardship share share/kits share/top connections google gmail gcal drive mailchimp callhub/pushes requests volunteers shifts shifts/board signs turfs persons persons/count contacts events blasts blasts/stats subscriptions actions export operator two-step intake/keys geocode/status duplicates followups/mine field-report webdid shiftturfs moves/counts calltime/seats calltime/pledges relationships/mine relationships/key data data/sample data/status brand brand/settings"
for a in $API; do
  f=$RAW/api/$(echo "$a" | tr '/' '_').json
  code=$(curl -s -b "$JAR" -o "$f" -w "%{http_code}" "$URL/api/$a")
  echo "$code $a $(wc -c < "$f")"
done > "$RAW/api/_index.txt"

# ── 47 pages, signed in ──
PAGES="/ /admin /join /donate /site/ /site /manifest.webmanifest /sw.js /signup /login /volunteer /membership /member /learn /u /robots.txt /sitemap.xml /site/sitemap.xml /site/robots.txt /site/feed.xml /site/about /site/platform /site/news /site/events /site/donate /site/volunteer /site/join /site/contact /site/team /site/candidates /site/privacy /site/guide /guide /vote /favicon.ico /star.png /base-mark.svg /apple-touch-icon.png /icon-192.png /site-assets/site.css /site-assets/imagine-surrey/logo.webp /site-assets/imagine-surrey/logo-light.png /calendar /events /sign /petition /share"
for p in $PAGES; do
  n=$(name_of "$p")
  code=$(curl -s -b "$JAR" -o "$RAW/pages/$n" -D "$RAW/pages/$n.headers" -w "%{http_code} %{content_type}" "$URL$p")
  echo "$code $p $(wc -c < "$RAW/pages/$n")"
done > "$RAW/pages/_index.txt"

# ── 8 pages, signed out ──
for p in / /join /donate /site/ /manifest.webmanifest /signup /login /api/auth/setup; do
  n=$(name_of "$p")
  code=$(curl -s -o "$RAW/pages-anon/$n" -w "%{http_code} %{content_type}" "$URL$p")
  echo "$code $p $(wc -c < "$RAW/pages-anon/$n")"
done > "$RAW/pages-anon/_index.txt"

# ── Five more captures ──
X=$RAW/extra
{
  # (c) the old and the new training address: status and where it sends you.
  for p in /imagineu /imagineu/x?y=1 /training; do
    echo "$(curl -s -b "$JAR" -o /dev/null -w "%{http_code} location=%{redirect_url}" "$URL$p" | sed "s#$URL##") $p"
  done
  # (e) the icons and the website's pictures, at their addresses.
  for p in /star.png /icon-192.png /icon-512.png /apple-touch-icon.png \
           /site-assets/imagine-surrey/logo.webp /site-assets/imagine-surrey/logo-light.png \
           /site-assets/imagine-surrey/hero-park.jpg /site-assets/imagine-surrey/members-rally.jpg; do
    n=$(name_of "$p")
    code=$(curl -s -o "$X/$n" -w "%{http_code} %{content_type}" "$URL$p")
    echo "$code $p $(wc -c < "$X/$n") $(md5sum < "$X/$n" | cut -d' ' -f1)"
  done
} > "$X/_index.txt"

# (d) the website after first use: the home page, and every page as stored.
curl -s -o "$X/site_home.html" "$URL/site/"
curl -s -b "$JAR" -o "$X/site_after.json" "$URL/api/site"
n=0
for id in $(jq -r '.pages[]?.id // empty' "$X/site_after.json" 2>/dev/null); do
  n=$((n + 1))
  curl -s -b "$JAR" -o "$X/site_page_$(printf %02d $n).json" "$URL/api/site/pages/$id"
done
for slug in $(jq -r '.pages[]? | select(.status == "published") | .slug // empty' "$X/site_after.json" 2>/dev/null); do
  curl -s -o "$X/site_public_$(echo "$slug" | tr -c 'a-z0-9\n' '_').html" "$URL/site/$slug"
done

# (b) one membership: a one-year term and a Star Club gift, then their page.
curl -s -b "$JAR" -o "$X/membership_enter.json" -H 'content-type: application/json' -d '{
  "first_name":"Morgan","last_name":"Dumpcheck","birth_date":"1980-05-06","email":"morgan.dumpcheck@example.test",
  "phone":"604-555-0142","address":"100 Example St","city":"Surrey","postal":"V3T 1A1","citizenship":"citizen",
  "term":1,"once":{"kind":"star"},"method":"cheque","signed":true,"signed_on":"2026-01-15"}' "$URL/api/actions/membership.enter"
PID=$(jq -r '.person.id // .person_id // .result.person.id // .result.person_id // empty' "$X/membership_enter.json" 2>/dev/null)
if [ -n "$PID" ]; then
  curl -s -b "$JAR" -o "$X/membership_person.json" "$URL/api/persons/$PID"
  curl -s -b "$JAR" -o "$X/membership_person_terms.json" "$URL/api/persons/$PID/membership"
else
  echo "no person id in the membership answer" > "$X/membership_person.json"
fi
curl -s -b "$JAR" -o "$X/membership_members.json" "$URL/api/members"

# (a) the sample data, then what it made.
curl -s -b "$JAR" -o "$X/sample_post.json" -X POST -H 'content-type: application/json' -d '{}' "$URL/api/data/sample"
for a in "persons?limit=500" fields turfs shifts signs lists/tags; do
  curl -s -b "$JAR" -o "$X/sample_$(echo "$a" | sed 's/?.*//; s#/#_#g').json" "$URL/api/$a"
done

kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null
trap - EXIT
rm -f "$JAR"

# ── The copy to compare: ids, dates, the commit and built names as fixed words ──
node --input-type=module - "$RAW" "$OUT/norm" "$P" <<'NORM'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const [from, to, port] = process.argv.slice(2);
// A picture is told by what it holds, not its name: /favicon.ico answers with the app's page.
const DROP_HEADERS = /^(date|etag|last-modified|content-length|set-cookie|x-build):/i;
const norm = (name, text, dir) => {
  let t = text
    .replaceAll(`127.0.0.1:${port}`, 'HOST')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'ID')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?/g, 'DATETIME')
    .replace(/\b20\d\d-\d\d-\d\d\b/g, 'DATE')
    .replace(/\b20\d{6}T\d{6}Z\b/g, 'DATETIME')
    .replace(/([A-Za-z0-9_.]+)-[A-Za-z0-9_-]{8}\.(js|css)\b/g, '$1-HASH.$2')
    .replace(/"(payload_hash|hash|prev_hash)":"[0-9a-f]{64}"/g, '"$1":"HASH"')
    .replace(/\b1[5-9]\d{11}\b/g, 'EPOCH')
    .replace(/"instance":"[^"]*"/g, '"instance":"INSTANCE"')
    .replace(/"commit":("[^"]*"|null)/g, '"commit":"COMMIT"');
  if (name.endsWith('.headers')) t = t.split(/\r?\n/).filter((l) => !DROP_HEADERS.test(l)).join('\n');
  // The index of a folder: the status and the address (a page's length
  // changes with the built files' names).
  if (name === '_index.txt' && !/extra$/.test(dir)) t = t.split('\n').map((l) => l.replace(/ \d+$/, '')).join('\n');
  return t;
};
const walk = (dir, out) => {
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(dir).sort()) {
    const a = join(dir, name);
    if (statSync(a).isDirectory()) { walk(a, join(out, name)); continue; }
    const buf = readFileSync(a);
    if (buf.includes(0)) writeFileSync(join(out, name), buf);
    else writeFileSync(join(out, name), norm(name, buf.toString('utf8'), dir));
  }
};
walk(from, to);
NORM
echo "saved: $OUT/raw (as answered) and $OUT/norm (compare this one)"
