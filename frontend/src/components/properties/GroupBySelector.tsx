/**
 * GroupBySelector Component
 *
 * A panel for selecting the "group by" field in NodeCollection views.
 * Uses the same UI style as PropertyColumnSelector but single-select.
 *
 * Options:
 *  - None (no grouping)
 *  - Page (group by source page — pseudo-property)
 *  - Any real property (by UUID)
 */
import { useState, useMemo } from 'react';
import { useProperties } from '@/hooks';
import { SearchIcon } from '../core/icons';
import type { NodeCollectionGroupBy } from '@/types/nodeCollection';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import './GroupBySelector.css';

// ── Pseudo-options shown before real properties ──────────────────────────────

interface PseudoOption {
  uuid: string;
  name: string;
  type: string;
}

const NONE_OPTION: PseudoOption = {
  uuid: 'none',
  name: 'None',
  type: '',
};

const PAGE_OPTION: PseudoOption = {
  uuid: 'page',
  name: 'Page',
  type: 'PAGE',
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GroupBySelectorProps {
  /** Currently active groupBy value ('none', 'page', or property UUID) */
  value: NodeCollectionGroupBy;
  /** Called when a new groupBy is selected */
  onChange: (groupBy: NodeCollectionGroupBy) => void;
  /** Optional close callback (passed from ButtonWithPanel) */
  onClose?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GroupBySelector({ value, onChange, onClose }: GroupBySelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const { data: properties = [], isLoading } = useProperties();

  // Build filterable property list (exclude hidden system props and image/text types
  // that aren't useful for grouping)
  const availableProperties = useMemo(() => {
    return properties.filter(
      p =>
        p.uuid !== SYSTEM_PROPERTY_UUIDS.show_hierarchy &&
        !p.name.startsWith('_') &&
        p.type !== 'image' &&
        p.type !== 'text'
    );
  }, [properties]);

  const filteredProperties = useMemo(() => {
    if (!searchQuery.trim()) return availableProperties;
    const q = searchQuery.toLowerCase();
    return availableProperties.filter(p => p.name.toLowerCase().includes(q));
  }, [availableProperties, searchQuery]);

  // Show pseudo-options only when not searching
  const showPseudo = !searchQuery.trim();

  const pseudoOptions: PseudoOption[] = showPseudo ? [NONE_OPTION, PAGE_OPTION] : [];

  const handleSelect = (uuid: string) => {
    onChange(uuid);
    onClose?.();
  };

  if (isLoading) {
    return (
      <div className="group-by-selector">
        <div className="group-by-selector__loading">Loading properties…</div>
      </div>
    );
  }

  return (
    <div className="group-by-selector">
      {/* Header */}
      <div className="group-by-selector__header">
        <h3 className="group-by-selector__title">Group By</h3>
      </div>

      {/* Search */}
      <div className="group-by-selector__search">
        <div className="group-by-selector__search-box">
          <SearchIcon size="sm" />
          <input
            type="text"
            className="group-by-selector__search-input"
            placeholder="Search properties…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
        </div>
      </div>

      {/* Option list */}
      <div className="group-by-selector__list">
        {/* Pseudo-options: None, Page */}
        {pseudoOptions.map((opt) => {
          const isActive = value === opt.uuid;
          return (
            <div
              key={opt.uuid}
              className={`group-by-selector__item ${isActive ? 'group-by-selector__item--active' : ''}`}
              onClick={() => handleSelect(opt.uuid)}
            >
              <span className="group-by-selector__check">{isActive ? '✓' : ''}</span>
              <span className="group-by-selector__item-content">
                <span className="group-by-selector__item-name">{opt.name}</span>
                {opt.type && (
                  <span className="group-by-selector__item-type">{opt.type}</span>
                )}
              </span>
            </div>
          );
        })}

        {/* Divider between pseudo-options and real properties */}
        {showPseudo && filteredProperties.length > 0 && (
          <div className="group-by-selector__divider" />
        )}

        {/* Real properties */}
        {filteredProperties.map((prop) => {
          const isActive = value === prop.uuid;
          return (
            <div
              key={prop.uuid}
              className={`group-by-selector__item ${isActive ? 'group-by-selector__item--active' : ''}`}
              onClick={() => handleSelect(prop.uuid)}
            >
              <span className="group-by-selector__check">{isActive ? '✓' : ''}</span>
              <span className="group-by-selector__item-content">
                <span className="group-by-selector__item-name">
                  {prop.icon && <span className="group-by-selector__item-icon">{prop.icon}</span>}
                  {prop.name}
                </span>
                <span className="group-by-selector__item-type">{prop.type.toUpperCase()}</span>
              </span>
            </div>
          );
        })}

        {filteredProperties.length === 0 && searchQuery && (
          <div className="group-by-selector__empty">No properties found</div>
        )}
      </div>
    </div>
  );
}
