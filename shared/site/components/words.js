// The hero headline: a fixed start and a word that changes every few
// seconds (as on imaginesurrey.ca). It can be paused (WCAG 2.2.2: it moves
// for longer than five seconds), never moves under prefers-reduced-motion,
// and is not read out again on every change.
import { createElement, useEffect, useState } from 'react';
import { html } from './h.js';
import { Icon } from './icons.js';

export function RotatingWords({ prefix = '', words = [], level = 1, interval = 2600 }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const moving = words.length > 1 && !paused && !reduced;
  useEffect(() => {
    if (!moving) return undefined;
    const timer = setInterval(() => setIndex((i) => i + 1), interval);
    return () => clearInterval(timer);
  }, [moving, interval]);

  const word = words.length ? words[index % words.length] : '';
  const heading = createElement(`h${level === 1 ? 1 : 2}`, { className: 'hero-title display' },
    prefix,
    prefix && word ? html`<br />` : null,
    word ? html`<span className="hero-word-wrap" aria-live="off"><span key=${index} className="hero-word">${word}</span></span>` : null);

  return html`<div className="hero-headline">
    ${heading}
    ${words.length > 1 && !reduced ? html`<button type="button" className="rotate-toggle" aria-pressed=${paused ? 'true' : 'false'}
        aria-label="Pause the rotating words" title=${paused ? 'Play the rotating words' : 'Pause the rotating words'} onClick=${() => setPaused((p) => !p)}>
      <${Icon} name=${paused ? 'play' : 'pause'} size=${16} stroke=${2.6} />
    </button>` : null}
  </div>`;
}
