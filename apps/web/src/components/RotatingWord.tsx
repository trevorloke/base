"use client";

import { useEffect, useState } from "react";

/**
 * The hero headline: a fixed prefix and a word that rotates every few
 * seconds. The rotation can be paused (it moves for longer than five
 * seconds), never runs under prefers-reduced-motion, and is not announced
 * to screen readers on every change.
 */
export function RotatingWord({ words, prefix, intervalMs = 2600 }: { words: string[]; prefix: string; intervalMs?: number }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const rotating = words.length > 1 && !paused && !reduced;
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => setIndex((i) => i + 1), intervalMs);
    return () => clearInterval(timer);
  }, [rotating, intervalMs]);

  const word = words[index % words.length] ?? "";
  return (
    <div className="hero-headline">
      <h1 className="hero-title pop">
        {prefix}
        <br />
        <span className="hero-word-wrap" aria-live="off">
          {/* The key remounts the span so the fade-in replays for each word. */}
          <span key={index} className="hero-word">
            {word}
          </span>
        </span>
      </h1>
      {words.length > 1 && !reduced && (
        <button type="button" className="rotate-toggle" aria-pressed={paused} aria-label="Pause the rotating words" title={paused ? "Play the rotating words" : "Pause the rotating words"} onClick={() => setPaused((p) => !p)}>
          {paused ? (
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 4.5v15l13-7.5z" />
            </svg>
          ) : (
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
