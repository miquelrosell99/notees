/**
 * GroupBySelector Component
 *
 * A panel for selecting the "group by" field in NodeCollection views.
 * Uses the same UI style as PropertyColumnSelector.
 *
 * Options:
 *  - None (no grouping)
 *  - Page (group by source page — pseudo-property)
 *  - Any real property (by UUID)
 *
 * When `multi` is true, the selector supports multi-level grouping for list
 * view: clicking an option toggles it, selected options render as removable
 * chips, and "None" clears the selection back to 'none'.
 */
import { useState, useMemo, useRef, useEffect } from 'react';
import { useProperties } from '../hooks';
import { Spinner } from '@/components/ui/Spinner';
import { SearchIcon, NodeIcon, CheckIcon, CloseIcon } from '@/components/ui/icons';
import type { NodeCollectionGroupBy } from '@/types/nodeCollection';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import './GroupBySelector.css';

// ── Pseudo-options shown before real properties ──────────────────────────────

interface PseudoOption {
  propertyUuid: string;
  name: string;
  type: string;
}

const NONE_OPTION: PseudoOption = {
  propertyUuid: 'none',
  name: 'None',
  type: '',
};

const PAGE_OPTION: PseudoOption = {
  propertyUuid: 'page',
  name: 'Page',
  type: 'NODE',
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GroupBySelectorProps {
  /** Currently active groupBy value ('none', 'page', property UUID, or array) */
  value: NodeCollectionGroupBy;
  /** Called when a new groupBy is selected */
  onChange: (groupBy: NodeCollectionGroupBy) => void;
  /** Optional close callback (passed from ButtonWithPanel) */
  onClose?: () => void;
  /** Hide the "Page" pseudo-option (e.g. for card view where page grouping is not supported) */
  hidePageOption?: boolean;
  /** When true, enable multi-selection for list view multi-level grouping */
  multi?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GroupBySelector({ value, onChange, onClose, hidePageOption = false, multi = false }: GroupBySelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: properties = [], isLoading } = useProperties();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const pseudoOptions: PseudoOption[] = showPseudo
    ? (hidePageOption ? [NONE_OPTION] : [NONE_OPTION, PAGE_OPTION])
    : [];

  // Resolve the human-readable label for a selected option UUID
  const getOptionLabel = (propertyUuid: string): string => {
    if (propertyUuid === 'page') return PAGE_OPTION.name;
    if (propertyUuid === 'none') return NONE_OPTION.name;
    return properties.find(p => p.uuid === propertyUuid)?.name ?? 'Property';
  };

  const getOptionIcon = (propertyUuid: string): string | null | undefined => {
    if (propertyUuid === 'page') return undefined;
    return properties.find(p => p.uuid === propertyUuid)?.icon;
  };

  const selectedPropertyUuids = useMemo<string[]>(() => {
    if (!multi) return [];
    if (Array.isArray(value)) return value;
    if (value && value !== 'none') return [value];
    return [];
  }, [multi, value]);

  const isSelected = (propertyUuid: string): boolean => {
    if (!multi) return value === propertyUuid;
    if (propertyUuid === 'none') return !value || value === 'none';
    return selectedPropertyUuids.includes(propertyUuid);
  };

  const handleToggle = (propertyUuid: string) => {
    if (!multi) {
      onChange(propertyUuid);
      onClose?.();
      return;
    }

    if (propertyUuid === 'none') {
      onChange('none');
      onClose?.();
      return;
    }

    const next = selectedPropertyUuids.includes(propertyUuid)
      ? selectedPropertyUuids.filter(u => u !== propertyUuid)
      : [...selectedPropertyUuids, propertyUuid];
    onChange(next.length > 0 ? next : 'none');
  };

  const removeChip = (propertyUuid: string) => {
    const next = selectedPropertyUuids.filter(u => u !== propertyUuid);
    onChange(next.length > 0 ? next : 'none');
  };

  if (isLoading) {
    return (
      <div className="group-by-selector">
        <div className="group-by-selector__loading"><Spinner size="sm" label="Loading properties…" /></div>
      </div>
    );
  }

  return (
    <div className="group-by-selector">
      {/* Header */}
      <div className="group-by-selector__header">
        <h3 className="group-by-selector__title">Group By</h3>
      </div>

      {/* Selected chips (multi mode only) */}
      {multi && selectedPropertyUuids.length > 0 && (
        <div className="group-by-selector__chips">
          {selectedPropertyUuids.map(propertyUuid => (
            <span key={propertyUuid} className="group-by-selector__chip">
              {propertyUuid !== 'page' && getOptionIcon(propertyUuid) && (
                <NodeIcon icon={getOptionIcon(propertyUuid)} size="xs" />
              )}
              <span className="group-by-selector__chip-label">{getOptionLabel(propertyUuid)}</span>
              <button
                type="button"
                className="group-by-selector__chip-remove"
                onClick={() => removeChip(propertyUuid)}
                aria-label={`Remove ${getOptionLabel(propertyUuid)}`}
                title="Remove"
              >
                <CloseIcon size="xs" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="group-by-selector__search">
        <div className="group-by-selector__search-box">
          <SearchIcon size="sm" />
          <input
            type="text"
            className="group-by-selector__search-input"
            placeholder="Search properties…"
            aria-label="Search properties"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            ref={inputRef}
          />
        </div>
      </div>

      {/* Option list */}
      <div className="group-by-selector__list">
        {/* Pseudo-options: None, Page */}
        {pseudoOptions.map((opt) => {
          const active = isSelected(opt.propertyUuid);
          return (
            <button
              type="button"
              key={opt.propertyUuid}
              className={`group-by-selector__item ${active ? 'group-by-selector__item--active' : ''}`}
              onClick={() => handleToggle(opt.propertyUuid)}
            >
              <span className="group-by-selector__check">{active ? <CheckIcon size="xs" /> : null}</span>
              <span className="group-by-selector__item-content">
                <span className="group-by-selector__item-name">{opt.name}</span>
                {opt.type && (
                  <span className="group-by-selector__item-type">{opt.type}</span>
                )}
              </span>
            </button>
          );
        })}

        {/* Divider between pseudo-options and real properties */}
        {showPseudo && filteredProperties.length > 0 && (
          <div className="group-by-selector__divider" />
        )}

        {/* Real properties */}
        {filteredProperties.map((prop) => {
          const active = isSelected(prop.uuid);
          return (
            <button
              type="button"
              key={prop.uuid}
              className={`group-by-selector__item ${active ? 'group-by-selector__item--active' : ''}`}
              onClick={() => handleToggle(prop.uuid)}
            >
              <span className="group-by-selector__check">{active ? <CheckIcon size="xs" /> : null}</span>
              <span className="group-by-selector__item-content">
                <span className="group-by-selector__item-name">
                  {prop.icon && <NodeIcon icon={prop.icon} size="xs" />}
                  {prop.name}
                </span>
                <span className="group-by-selector__item-type">{prop.type.toUpperCase()}</span>
              </span>
            </button>
          );
        })}

        {filteredProperties.length === 0 && searchQuery && (
          <div className="group-by-selector__empty">No properties found</div>
        )}
      </div>
    </div>
  );
}
