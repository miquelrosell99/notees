import { useState } from 'react';
import { Icon } from '@/components/ui';

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
        <Icon path={icon} className="graph-sidebar-section__icon" />
        <span className="graph-sidebar-section__title">{title}</span>
        <Icon path="mdi-chevron-down" className={`graph-sidebar-section__chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="graph-sidebar-section__content">
          {children}
        </div>
      )}
    </div>
  );
}
