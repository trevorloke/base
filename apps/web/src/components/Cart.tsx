"use client";

import { useEffect, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import { Alert } from "./forms/Field";
import { useApiForm } from "./forms/useApiForm";

export type ShopProduct = {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  tileLabel: string;
  tileBackground: string;
  tileForeground: string;
};

const STORAGE_KEY = "imagine-surrey-cart";
const MAX_QTY = 50;

function QuantityControl({ id, name, value, onChange }: { id: string; name: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="qty" role="group" aria-label={`Quantity of ${name}`}>
      <button type="button" className="qty-btn" onClick={() => onChange(value - 1)} disabled={value === 0} aria-label={`Remove one ${name}`}>
        −
      </button>
      <label className="visually-hidden" htmlFor={id}>
        Quantity of {name}
      </label>
      <input
        id={id}
        className="qty-input"
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_QTY}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
      <button type="button" className="qty-btn" onClick={() => onChange(value + 1)} disabled={value >= MAX_QTY} aria-label={`Add one ${name}`}>
        +
      </button>
    </div>
  );
}

export function Cart({ products }: { products: ShopProduct[] }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);
  const { submit, pending, error } = useApiForm<{ url: string }>("/api/shop/checkout");

  // Remember the cart between visits on this device.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      if (saved && typeof saved === "object") setQty(saved);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(qty));
    } catch {}
  }, [qty]);

  const set = (slug: string, n: number) => setQty((q) => ({ ...q, [slug]: Math.max(0, Math.min(MAX_QTY, Math.round(n))) }));
  const lines = products.filter((p) => (qty[p.slug] ?? 0) > 0);
  const count = lines.reduce((n, p) => n + qty[p.slug], 0);
  const total = lines.reduce((sum, p) => sum + p.priceCents * qty[p.slug], 0);
  const summary = count === 0 ? "Your cart is empty" : `${count} ${count === 1 ? "item" : "items"} · ${formatCents(total)}`;

  // Announce the running total to screen readers whenever it changes.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setAnnouncement(count === 0 ? "Your cart is empty." : `${count} ${count === 1 ? "item" : "items"} in your cart, total ${formatCents(total)}.`);
  }, [count, total]);

  // The drawer is a native dialog: modal, Escape closes it, focus stays inside.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  useEffect(() => {
    if (open && count === 0) setOpen(false);
  }, [open, count]);

  function closeDrawer() {
    setOpen(false);
    opener.current?.focus();
  }

  async function checkout() {
    if (pending || lines.length === 0) return;
    const result = await submit({ items: lines.map((p) => ({ slug: p.slug, quantity: qty[p.slug] })) });
    if (result) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      window.location.assign(result.url);
    }
  }

  return (
    <>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="products">
        {products.map((p) => {
          const n = qty[p.slug] ?? 0;
          return (
            <article key={p.slug} className="product" aria-labelledby={`product-${p.slug}`}>
              <div className="product-tile" style={{ background: p.tileBackground, color: p.tileForeground }}>
                {p.tileLabel}
              </div>
              <div className="product-meta">
                <h3 id={`product-${p.slug}`}>{p.name}</h3>
                <span className="price">{formatCents(p.priceCents)}</span>
              </div>
              {p.description && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.45, color: "var(--muted)" }}>{p.description}</p>}
              <QuantityControl id={`qty-${p.slug}`} name={p.name} value={n} onChange={(v) => set(p.slug, v)} />
            </article>
          );
        })}
      </div>
      {error && !open && <Alert>{error}</Alert>}
      {count > 0 && (
        <div className="cart-bar">
          <span className="cart-summary">{summary}</span>
          <div className="cart-bar-actions">
            <button ref={opener} type="button" className="btn btn--outline btn--lg" style={{ borderColor: "#fff", color: "#fff" }} onClick={() => setOpen(true)} aria-haspopup="dialog">
              View cart
            </button>
            <button type="button" className="btn btn--yellow btn--lg" onClick={checkout} aria-busy={pending || undefined} aria-disabled={pending || undefined}>
              {pending ? "Opening checkout…" : "Check out"}
            </button>
          </div>
        </div>
      )}
      <dialog
        ref={dialog}
        className="cart-dialog"
        aria-labelledby="cart-title"
        aria-modal="true"
        onClose={() => {
          setOpen(false);
          opener.current?.focus();
        }}
      >
        {open && (
          <div className="cart-dialog-inner">
            <div className="cart-dialog-head">
              <h2 id="cart-title">Your cart</h2>
              <button type="button" className="btn btn--outline" onClick={closeDrawer} aria-label="Close cart">
                Close
              </button>
            </div>
            <ul className="cart-lines">
              {lines.map((p) => (
                <li key={p.slug} className="cart-line">
                  <div>
                    <p className="cart-line-name">{p.name}</p>
                    <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>{formatCents(p.priceCents)} each</p>
                  </div>
                  <QuantityControl id={`cart-qty-${p.slug}`} name={p.name} value={qty[p.slug]} onChange={(v) => set(p.slug, v)} />
                  <span className="cart-line-price">{formatCents(p.priceCents * qty[p.slug])}</span>
                </li>
              ))}
            </ul>
            <p className="cart-total">
              <span>Total</span>
              <span>{formatCents(total)}</span>
            </p>
            <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>Shipping is calculated at checkout. We ship across Canada.</p>
            {error && <Alert>{error}</Alert>}
            <div className="cart-dialog-actions">
              <button type="button" className="btn btn--outline btn--lg" onClick={closeDrawer}>
                Keep shopping
              </button>
              <button type="button" className="btn btn--red btn--lg" onClick={checkout} aria-busy={pending || undefined} aria-disabled={pending || undefined}>
                {pending ? "Opening checkout…" : "Check out"}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
