// Who may use templates, by where they are offered: email needs Outreach,
// press needs Media (a manager always may). Saving is the desk's; a
// volunteer granted Media may start a release from one, never save one.
import { areasFor } from '../../lib/perms.js';

export const USES = ['email', 'press'];
export const DESK = ['manager', 'treasurer', 'staff'];
const AREA = { email: 'outreach', press: 'media' };
const WORD = { email: 'Outreach', press: 'Media' };
export const holds = (ctx, use) => ctx?.role === 'manager' || areasFor(ctx).includes(AREA[use]);
// email: the desk only (the Email tab is the desk's); press: anyone holding Media.
export const mayStart = (ctx, use) => holds(ctx, use) && (use === 'press' || DESK.includes(ctx?.role));
export const maySave = (ctx, use) => DESK.includes(ctx?.role) && holds(ctx, use);
export const refusal = (use) => `You don’t have ${WORD[use]}`;
export const GONE = 'That template was removed';
