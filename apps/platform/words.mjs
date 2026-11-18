// What each line of the operator log says, in plain words. Every action the
// console writes has words here (a test checks).
const ENV = { production: 'production', staging: 'staging' };
const envWord = (p) => ENV[p?.env] || 'the';

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
};

export const ACTIONS = Object.keys(WORDS);
export const wordsFor = (action, payload = {}) => (WORDS[action] ? WORDS[action](payload || {}) : action);
