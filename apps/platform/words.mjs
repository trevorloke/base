// What each line of the operator log says, in plain words. Every action the
// console writes has words here (a test checks).
const ENV = { production: 'production', staging: 'staging' };
const envWord = (p) => ENV[p?.env] || 'the';

// What a Render change was, as the log says it ("Asked Render to …").
const RENDER_ASKED = {
  deploy: () => 'deploy the latest version',
  restart: () => 'restart the server',
  key: () => 'set base.win’s key',
  domain: (p) => (p.host ? `add ${p.host}` : 'add its address'),
  'close-db': () => 'close the database to the internet',
};
const RENDER_DENIED = { code: 'wrong code', old: 'old page', target: 'not this campaign’s service', caps: 'too many changes', busy: 'another change was still running', state: 'nothing to change' };
const renderResult = (p) => {
  if (p.ok) return 'Render did it';
  if (p.unsure) return 'No answer from Render';
  return p.status ? `Render didn’t do it (answer ${p.status})` : 'Render didn’t do it';
};

export const WORDS = {
  setup: (p) => (p.reopened ? 'Set up again (new password and authenticator)' : 'Set up the control centre'),
  signin: (p) => (p.via === 'recovery' ? 'Signed in with a recovery code' : 'Signed in'),
  'signin.locked': () => 'Too many wrong codes: app codes locked until a recovery code is used',
  'recovery.used': (p) => `Used a recovery code (${p.left} left)`,
  stepup: () => 'Typed a fresh code',
  'campaign.create': () => 'Made the campaign',
  'campaign.add-existing': () => 'Added a campaign that was already running',
  'campaign.edit': () => 'Edited the campaign',
  'campaign.archive': () => 'Archived the campaign',
  'campaign.unarchive': () => 'Brought the campaign back',
  'environment.pin': (p) => `Recognised the ${envWord(p)} server`,
  'environment.repin': (p) => `Confirmed the ${envWord(p)} server changed`,
  'checklist.tick': (p) => `Ticked “${p.words || p.item}”`,
  'checklist.untick': (p) => `Unticked “${p.words || p.item}”`,
  'desk.open': (p) => (p.purpose === 'invite' ? `Invited the first manager and opened the ${envWord(p)} desk` : `Opened the ${envWord(p)} desk`),
  'render.link': (p) => `Connected to Render: ${p.label || 'its service'}${p.database ? ` and ${p.database}` : ''}`,
  'render.start': (p) => `Asked Render to ${(RENDER_ASKED[p.what] || (() => 'make a change'))(p)}`,
  'render.result': (p) => renderResult(p),
  'render.denied': (p) => `Refused a Render change: ${RENDER_DENIED[p.problem] || 'not allowed'}`,
};

export const ACTIONS = Object.keys(WORDS);
export const wordsFor = (action, payload = {}) => (WORDS[action] ? WORDS[action](payload || {}) : action);
