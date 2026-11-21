// The control centre's one script (the CSP allows no other): Copy buttons,
// a busy word on slow forms (Check now, Save address), the time zone that
// follows the province, and the two random values in the New campaign
// .env block, made here in the browser so the server never sees them.
(() => {
  const live = () => {
    let el = document.getElementById('oc-live');
    if (!el) {
      el = document.createElement('p');
      el.id = 'oc-live';
      el.className = 'oc-sr';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  };
  const say = (words) => { const el = live(); el.textContent = ''; setTimeout(() => { el.textContent = words; }, 30); };

  // 32 random bytes as 43 base64url characters.
  const randomValue = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  for (const span of document.querySelectorAll('[data-random]')) span.textContent = randomValue();
  if (document.querySelector('[data-random]')) for (const p of document.querySelectorAll('[data-when-empty]')) p.hidden = true;

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* below */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'oc-sr';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  };
  document.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-copy]');
    if (!button) return;
    const from = document.getElementById(button.dataset.copy);
    if (!from) return;
    const ok = await copyText(from.textContent);
    const was = button.dataset.words || button.textContent;
    button.dataset.words = was;
    button.textContent = ok ? 'Copied' : 'Select it and copy';
    say(ok ? 'Copied' : 'Couldn’t copy: select the text and copy it.');
    setTimeout(() => { button.textContent = was; }, 2000);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.dataset.busy) return;
    const button = form.querySelector('button[type=submit]');
    if (button) { button.textContent = form.dataset.busy; button.setAttribute('aria-busy', 'true'); }
    say(form.dataset.busy);
  });

  const province = document.getElementById('province');
  const tz = document.getElementById('tz');
  if (province && tz) {
    province.addEventListener('change', () => {
      const zone = province.selectedOptions[0]?.dataset.tz;
      if (zone) tz.value = zone;
    });
  }
})();
