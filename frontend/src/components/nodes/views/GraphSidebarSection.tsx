import { useState } from 'react';

interface GraphSidebarSectionProps {
  title: string;
  icon: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

/** Inline collapsible sidebar section for GraphView */
export function GraphSidebarSection({
  title,
  icon,
  children,
  defaultOpen = true,
}: GraphSidebarSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="graph-sidebar-section">
      <button
        className="graph-sidebar-section__header"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className={`mdi ${icon}`} />
        <span className="graph-sidebar-section__title">{title}</span>
        <span className={`mdi mdi-chevron-down graph-sidebar-section__chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="graph-sidebar-section__content">
          {children}
        </div>
      )}
    </div>
  );
}
