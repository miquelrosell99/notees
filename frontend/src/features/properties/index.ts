/**
 * Public surface of the properties feature.
 *
 * Cross-feature imports should prefer `@/features/properties` (this barrel) over
 * reaching into internal subdirectories.
 */

// Components
export { PropertiesSection } from './components/PropertiesSection';
export { PropertyCell } from './components/PropertyCell';
export { PropertyValue } from './components/PropertyValue';
export { PropertyList } from './components/PropertyList';
export type { PropertyListProps, PropertyEntry } from './components/PropertyList';
export { PropertySuggestionPopup } from './components/PropertySuggestionPopup';
export { PropertyColumnSelector } from './components/PropertyColumnSelector';
export { PropertyCreateModal } from './components/PropertyCreateModal';
export { PropertyConfigSection } from './components/PropertyConfigSection';
export { PropertyForm } from './components/PropertyForm';
export { ClassPropertiesEditor } from './components/ClassPropertiesEditor';
export { PropertyIconButton } from './components/PropertyIconButton';
export { GroupBySelector } from './components/GroupBySelector';
export { GanttPropertySelector } from './components/GanttPropertySelector';
export type { GanttPropertySelectorProps, GanttTimeScale } from './components/GanttPropertySelector';
export { NodePropertyCell } from './components/NodePropertyCell';
export { SelectionPropertyCell } from './components/SelectionPropertyCell';
export { UrlPropertyCell } from './components/UrlPropertyCell';
export { EmailPropertyCell } from './components/EmailPropertyCell';
export { DatePropertyCell } from './components/DatePropertyCell';
export { DatePropertyValue } from './components/DatePropertyValue';
export { UrlPropertyValue } from './components/UrlPropertyValue';
export { EmailPropertyValue } from './components/EmailPropertyValue';
export { TextPropertyBlock } from './components/TextPropertyBlock';
export { InlineBlock } from './components/InlineBlock';

// Renderer registry
export {
  getPropertyValueRenderer,
  registerPropertyValueRenderer,
  getRegisteredPropertyTypes,
  getRegisteredRenderers,
  type PropertyValueProps,
  type PropertyCellProps,
  type PropertyValueRenderer,
} from './utils/propertyValueRegistry';

// Side-effect: register built-in property value renderers
import './utils/registerPropertyRenderers';

// Hooks
export * from './hooks';

// Constants
export { PROPERTY_TYPE_ICONS } from './utils/constants';

// Types
export * from './types';
