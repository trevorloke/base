import { useEffect, useState } from "react";
import { brandCss, DEFAULT_BRAND, type Brand } from "@base-air/look";

/**
 * The workspace's look in the browser. The server writes it into index.html (window.__BASE_AIR_BRAND__ and a
 * <style id="base-air-brand">), so the first paint is right; after a save or a workspace switch the room swaps
 * the same style element's text. The Vite dev server writes nothing, so there the room applies it after loading.
 */

declare global {
  interface Window {
    __BASE_AIR_BRAND__?: Brand;
  }
}

const STYLE_ID = "base-air-brand";
let current: Brand | null = typeof window !== "undefined" && window.__BASE_AIR_BRAND__ ? window.__BASE_AIR_BRAND__ : null;
const listeners = new Set<(b: Brand) => void>();

export function currentBrand(): Brand {
  return current ?? DEFAULT_BRAND;
}

/** Paint the room in `b` and tell everyone who shows the name or logo. */
export function applyBrand(b: Brand): void {
  current = b;
  if (typeof document !== "undefined") {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    } else if (el.parentElement === document.head && el !== document.head.lastElementChild) {
      // Stay after every stylesheet the bundle adds, so the brand wins the cascade.
      document.head.appendChild(el);
    }
    el.textContent = brandCss(b);
    document.documentElement.setAttribute("data-brand-mode", b.mode);
    document.title = b.name ? `${b.name} · Base Air` : "Base Air";
  }
  for (const l of listeners) l(b);
}

export function useBrand(): Brand {
  const [b, setB] = useState<Brand>(currentBrand);
  useEffect(() => {
    listeners.add(setB);
    return () => {
      listeners.delete(setB);
    };
  }, []);
  return b;
}
