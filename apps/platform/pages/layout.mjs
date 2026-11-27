// The page every console screen sits in: the app's own look (app.css and
// its variables), the console's few classes (ops.css, prefixed oc-), the
// one script (ops.js), and when signed in a short bar: Campaigns, Log,
// base.win’s key, Sign out (and Render, only while a Render key is set).
import { html, raw } from './html.mjs';
import { cfg } from '../config.mjs';

export const page = ({ title, body, nav = false, here = '' }) => html`<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<!-- The header says no-referrer; a browser then sends "Origin: null" on this
     page's own forms, which the Origin check refuses. same-origin still
     sends no Referer to any other site. -->
<meta name="referrer" content="same-origin">
<title>${title} · base.win control centre</title>
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/ops.css">
<script src="/ops.js" defer></script>
</head>
<body class="oc-body">
<header class="oc-top">
  <a class="oc-brand" href="/">base.win control centre</a>
  ${nav ? html`<nav class="oc-nav" aria-label="Control centre">
    <a href="/"${here === 'campaigns' ? raw(' aria-current="page"') : ''}>Campaigns</a>
    <a href="/log"${here === 'log' ? raw(' aria-current="page"') : ''}>Log</a>
    <a href="/key"${here === 'key' ? raw(' aria-current="page"') : ''}>base.win’s key</a>${cfg().render ? html`
    <a href="/render"${here === 'render' ? raw(' aria-current="page"') : ''}>Render</a>` : ''}
    <form method="post" action="/signout" class="oc-inline"><button class="btn btn-quiet" type="submit">Sign out</button></form>
  </nav>` : ''}
</header>
<main class="oc-main">
${body}
</main>
</body>
</html>`;

// A field: label, input, one helper line.
export const field = ({ label, name, type = 'text', value = '', help = '', required = false, autocomplete = '', inputmode = '', id = name }) => html`
<div class="field">
  <label for="${id}">${label}</label>
  <input class="input" id="${id}" name="${name}" type="${type}" value="${value}"${required ? raw(' required') : ''}${autocomplete ? html` autocomplete="${autocomplete}"` : ''}${inputmode ? html` inputmode="${inputmode}"` : ''}${help ? html` aria-describedby="${id}-help"` : ''}>
  ${help ? html`<p class="oc-help" id="${id}-help">${help}</p>` : ''}
</div>`;

// The status line: read out when it changes.
export const status = (text, kind = '') => html`<p class="oc-status${kind ? ` oc-${kind}` : ''}" role="status" aria-live="polite">${text || ''}</p>`;

// "It’s been more than 10 minutes": the Code field on a form whose window has passed.
export const codeField = (stale) => (stale ? field({ label: 'Code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', help: 'It’s been more than 10 minutes: type your code.', required: true }) : '');
