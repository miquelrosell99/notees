import { Checkbox } from '@/components/ui/Checkbox';
import type { PropertyValueProps } from '@/features/content/components/properties/propertyValueRegistry';

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
