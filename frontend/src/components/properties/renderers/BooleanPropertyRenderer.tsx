import { Checkbox } from '@/components/core/Checkbox';
import type { PropertyValueProps } from '../propertyValueRegistry';

/**
 * Boolean property value renderer.
 */
export function BooleanPropertyValue({
  value,
  readOnly,
  onChange,
}: PropertyValueProps) {
  return (
    <Checkbox
      size="sm"
      checked={Boolean(value)}
      disabled={readOnly}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
