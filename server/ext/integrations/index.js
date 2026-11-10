// Which optional integrations are on — for the desk. Settings → Services
// (GET /api/connections) is managers only, and a list's or a phone bank's
// page needs to know whether to offer "Send to CallHub".
//
//   GET /api/integrations   → { callhub: true, … }   desk roles; only on or
//                             off, never a setting's name or value
//
// A feature adds itself (from its own index.js):
//   registerIntegration('callhub', () => callhubOn())
import { Hono } from 'hono';

const registry = new Map();
export const registerIntegration = (key, isOn) => { registry.set(key, isOn); };
export const integrationsOn = () => Object.fromEntries([...registry].map(([key, isOn]) => [key, Boolean(isOn())]));

export const api = new Hono();
api.get('/integrations', (c) => (c.get('ctx').role === 'volunteer'
  ? c.json({ error: 'desk only' }, 403)
  : c.json(integrationsOn())));

export const deskOnlyReads = ['/integrations'];
