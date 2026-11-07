export interface TabDef {
  id: string;
  label: string;
  badge?: number;
}

/** The phone's bottom bar: the same four panels, one at a time. */
export function Tabs({ tabs, active, onChange }: { tabs: TabDef[]; active: string; onChange: (id: string) => void }) {
  return (
    <nav className="tabbar" aria-label="Panels">
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            className={`tab${isActive ? " tab-active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onChange(t.id)}
          >
            <span className="tab-label">{t.label}</span>
            {t.badge ? <span className="tab-badge mono">{t.badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
