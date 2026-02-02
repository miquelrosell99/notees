/**
 * AddFilterMenu Component
 * 
 * Reusable dropdown menu for adding query filters.
 * Displays all available condition types organized by category.
 */

import { Card } from '@/components/core/Card';
import './AddFilterMenu.css';

// ==================== Types ====================

export interface FilterMenuItem {
  id: string;
  label: string;
  description?: string;
  onClick: () => void;
}

export interface FilterMenuCategory {
  title: string;
  icon: string;
  items: FilterMenuItem[];
}

interface AddFilterMenuProps {
  /** Categorized menu items */
  categories: FilterMenuCategory[];
  /** Additional CSS classes */
  className?: string;
  /** Inline styles for positioning */
  style?: React.CSSProperties;
  /** Callback when an item is clicked */
  onItemClick?: () => void;
}

// ==================== Component ====================

export function AddFilterMenu({ categories, className = '', style, onItemClick }: AddFilterMenuProps) {
  // Flatten all items from all categories into a single list
  const allItems = categories.flatMap(category => category.items);
  
  return (
    <Card 
      className={`add-filter-menu ${className}`} 
      elevation="high"
      style={style}
    >
      <div className="add-filter-menu__items">
        {allItems.map((item, index) => (
          <div
            key={item.id}
            className="add-filter-menu__item"
            onClick={() => {
              item.onClick();
              onItemClick?.();
            }}
            title={item.description}
            data-menu-item
            data-index={index}
          >
            {item.label}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default AddFilterMenu;
