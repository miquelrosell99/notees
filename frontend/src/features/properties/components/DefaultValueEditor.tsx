/**
 * DefaultValueEditor Component
 *
 * Type-appropriate editor for a property's default value:
 * - text/url/email: text input (empty string clears the default)
 * - integer/float: number input (empty clears the default)
 * - boolean: unset/true/false select
 * - selection: dropdown of the property's options (value = option uuid)
 * - node/date/image/date_range: read-only note (API-only this round)
 *
 * `onChange(null)` means "no default".
 */
import type { ChangeEvent } from 'react';
import type { Property } from '@/types/api';
import { TextField } from '@/components/ui/TextField';
import { cn } from '@/utils/cn';
import './DefaultValueEditor.css';

interface DefaultValueEditorProps {
  property: Property;
  value: unknown | null;
  onChange: (value: unknown | null) => void;
  className?: string;
  /**
   * When set, applied to the underlying control so an external
   * `<label htmlFor>` can name it; the aria-label fallback is then dropped.
   */
  id?: string;
}

const TEXT_TYPES = ['text', 'url', 'email'];
const NUMBER_TYPES = ['integer', 'float'];

export function DefaultValueEditor({ property, value, onChange, className, id }: DefaultValueEditorProps) {
  // An external <label htmlFor={id}> names the control when id is provided;
  // otherwise the control carries its own aria-label.
  const a11yName = id ? undefined : 'Default value';
  if (TEXT_TYPES.includes(property.type)) {
    return (
      <TextField
        id={id}
        className={cn('default-value-editor__input', className)}
        type="text"
        size="sm"
        aria-label={a11yName}
        value={typeof value === 'string' ? value : ''}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          onChange(e.target.value === '' ? null : e.target.value)
        }
        placeholder="No default"
      />
    );
  }

  if (NUMBER_TYPES.includes(property.type)) {
    return (
      <TextField
        id={id}
        className={cn('default-value-editor__input', className)}
        type="number"
        size="sm"
        step={property.type === 'float' ? 'any' : 1}
        aria-label={a11yName}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          onChange(e.target.value === '' ? null : Number(e.target.value))
        }
        placeholder="No default"
      />
    );
  }

  if (property.type === 'boolean') {
    return (
      <select
        id={id}
        className={cn('default-value-editor__select', className)}
        aria-label={a11yName}
        value={value === true ? 'true' : value === false ? 'false' : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}
      >
        <option value="">No default</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  if (property.type === 'selection') {
    return (
      <select
        id={id}
        className={cn('default-value-editor__select', className)}
        aria-label={a11yName}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">No default</option>
        {(property.options || []).map((opt) => (
          <option key={opt.uuid} value={opt.uuid}>
            {opt.name}
          </option>
        ))}
      </select>
    );
  }

  // node/date/image/date_range — defaults are API-only this round
  return (
    <span className={cn('default-value-editor__note', className)}>
      Default not editable here
    </span>
  );
}
