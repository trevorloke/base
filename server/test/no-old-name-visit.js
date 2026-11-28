// For no-old-name.test.js: one server start, in this process, with only the
// settings this process was given, and what it answers a manager. Prints one
// line, `VISIT {…}`: every page as text, keyed by what it is, plus the
// health answer, the Settings → Services rows, and the start-up log.
// The email provider is stood in for here; nothing leaves this machine.

// Everything the server writes from its first line on, kept.
let startup = '';
for (const k of ['log', 'info', 'warn', 'error']) {
  const real = console[k].bind(console);
  console[k] = (...args) => { startup += `${args.map(String).join(' ')}\n`; if (k !== 'log' && k !== 'info') real(...args); };
}

const sent = [];
const realFetch = globalThis.fetch;
process.env.RESEND_API_KEY = 'test-key';
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
  }
  if (String(url).startsWith('http://') || String(url).startsWith('https://')) throw new Error(`nothing outside is reached here: ${new URL(String(url)).host}`);
  return realFetch(url, init);
};

const { app } = await import('../index.js');
const { freshDb, Client } = await import('./helpers.js');
await freshDb();

const pages = {};
const status = {};
const asText = async (name, res) => {
  status[name] = res.status;
  const head = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
  pages[name] = `${head}\n\n${await res.text()}`;
};
const mgr = new Client();
const signup = await mgr.signup({ name: 'Avery Example', email: 'avery@example.org', workspaceName: 'Riverbend 2026', jurisdiction: 'bc-municipal' });
if (signup.status !== 201) throw new Error(`sign-up: ${signup.status} ${JSON.stringify(signup.json)}`);
const get = (path, init = {}) => app.request(path, { ...init, headers: { cookie: mgr.cookie, ...(init.headers || {}) } });

const healthRes = await get('/api/health');
const health = await healthRes.clone().json();
await asText('health', healthRes);
// The same, asked at the public address (as anyone opening it would).
const healthPublicRes = await get(new URL('/api/health', process.env.BASE_PUBLIC_URL).href);
const healthPublic = await healthPublicRes.clone().json();
await asText('healthPublic', healthPublicRes);

const servicesRes = await get('/api/connections');
const servicesBody = await servicesRes.clone().json();
await asText('services', servicesRes);

// One email: "Send me a test" of a newsletter.
const t = await mgr.action('blast.test', { kind: 'newsletter', subject: 'Riverbend news', body: 'Hi all, the **spring** door-knocking starts Saturday.' });
if (t.status !== 200) throw new Error(`test email: ${t.status} ${JSON.stringify(t.json)}`);
pages.email = JSON.stringify(sent);

// Someone on the list, so the export and the download have a row.
await mgr.action('person.create', { name: 'Robin Example', email: 'robin@example.org', phone: '604-555-0123' });
await asText('export', await get('/api/export'));
await asText('csv', await get('/api/export/people.csv'));

// The public site from the Imagine Surrey preset: made on first look, then its privacy page.
const site = await mgr.get('/api/site');
if (site.status !== 200) throw new Error(`site: ${site.status}`);
await asText('privacy', await app.request('http://localhost/site/privacy', { headers: { 'x-forwarded-for': '198.51.100.7' } }));

pages.startup = startup;
const services = Array.isArray(servicesBody) ? servicesBody : (servicesBody.services || servicesBody.list || []);
process.stdout.write(`VISIT ${JSON.stringify({ pages, status, health, healthPublic, services, emails: sent.length })}\n`);
process.exit(0);
