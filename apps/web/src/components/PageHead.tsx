import type { ReactNode } from "react";

export function PageHead({ title, children, eyebrow }: { title: ReactNode; children?: ReactNode; eyebrow?: string }) {
  return (
    <section className="section--navy on-dark page-head">
      <div className="container stack" style={{ gap: 14 }}>
        {eyebrow && <p className="eyebrow eyebrow--yellow">{eyebrow}</p>}
        <h1 className="display pop">{title}</h1>
        {children && (
          <p className="lede" style={{ maxWidth: 760 }}>
            {children}
          </p>
        )}
      </div>
    </section>
  );
}
