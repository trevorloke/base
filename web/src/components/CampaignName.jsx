// Settings → Campaign (managers): what the campaign is called — the name on
// top of every screen, on sign-in and sign-up (GET /api/auth/setup gives the
// campaign's own name once it's set up, not STARBASE_ORG_NAME), on public
// pages and in emails (workspace.update). Not the sender emails come from:
// that's MAIL_FROM on the server, shown under Services. A campaign set up
// under one name (a staging copy, a renamed party) is renamed here in one
// step.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';

export default function CampaignName({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const current = me?.workspace?.name || '';
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const next = name.trim();
  const save = async (e) => {
    e.preventDefault();
    if (!next || next === current) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await action('workspace.update', { name: next });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <>
      <h2 className="ot-sec-h">Campaign name</h2>
      <p className="muted">On top of every screen, on the sign-in page, on public pages and in emails. Emails still come from the sender shown under Services.</p>
      <form className="ot-invite" onSubmit={save}>
        <label htmlFor="ws-name" className="ot-sr">Campaign name</label>
        <input id="ws-name" className="input ot-invite__email" maxLength={200} value={name}
          onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        <button type="submit" className="btn btn-primary ot-btn-tap" disabled={busy || !online || !next || next === current}>Save</button>
      </form>
      {!online && <NeedsSignalLine>Renaming the campaign needs signal</NeedsSignalLine>}
      {error && <p className="error" role="alert">{error}</p>}
      {saved && <p className="muted" role="status">✓ Saved — the campaign is now {current}.</p>}
    </>
  );
}
