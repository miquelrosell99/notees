/**
 * Add Filter Button Component
 * 
 * Dropdown button for adding new filter blocks.
 */
import { useState, useRef, useEffect } from 'react';
import { mdiPlus } from '@mdi/js';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { FILTER_TYPE_OPTIONS } from './constants';
import type { QueryBlockType } from '@/types/query';

interface AddFilterButtonProps {
  onSelect: (type: QueryBlockType) => void;
}

export function AddFilterButton({ onSelect }: AddFilterButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  const handleSelect = (type: QueryBlockType) => {
    onSelect(type);
    setIsOpen(false);
  };
  
  return (
    <div className="add-filter" ref={menuRef}>
      <Button
        icon={mdiPlus}
        size="sm"
        variant="ghost"
        onClick={() => setIsOpen(!isOpen)}
      >
        Add filter
      </Button>
      
      {isOpen && (
        <Card variant="filled" padding={false} radius="md" elevation="high" className="add-filter__menu">
          {FILTER_TYPE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              className="add-filter__item"
              onClick={() => handleSelect(opt.value)}
            >
              <div className="add-filter__item-text">
                <span className="add-filter__item-label">{opt.label}</span>
                <span className="add-filter__item-desc">{opt.description}</span>
              </div>
            </button>
          ))}
        </Card>
      )}
    </div>
  );
}
