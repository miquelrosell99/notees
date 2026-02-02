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
}

// ==================== Component ====================

export function AddFilterMenu({ categories, className = '', style }: AddFilterMenuProps) {
  return (
    <Card 
      className={`add-filter-menu ${className}`} 
      elevation="high"
      style={style}
    >
      {categories.map((category, categoryIndex) => (
        <div key={category.title} className="add-filter-menu__category">
          {/* Category header */}
          <div className="add-filter-menu__category-header">
            <span className="add-filter-menu__category-icon">{category.icon}</span>
            <span className="add-filter-menu__category-title">{category.title}</span>
          </div>
          
          {/* Category items */}
          <div className="add-filter-menu__items">
            {category.items.map((item) => (
              <div
                key={item.id}
                className="add-filter-menu__item"
                onClick={item.onClick}
                title={item.description}
              >
                {item.label}
              </div>
            ))}
          </div>
          
          {/* Divider between categories (except last) */}
          {categoryIndex < categories.length - 1 && (
            <div className="add-filter-menu__divider" />
          )}
        </div>
      ))}
    </Card>
  );
}

export default AddFilterMenu;
