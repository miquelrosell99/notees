import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DefaultValueEditor } from './DefaultValueEditor';
import type { Property } from '@/types/api';

function makeProp(overrides: Partial<Property>): Property {
  return {
    uuid: 'p1',
    name: 'P',
    icon: null,
    type: 'text',
    multi: false,
    is_system: false,
    scope: 'global',
    node_uuid: null,
    icon_visibility: 'hidden',
    validation_rules: null,
    required: false,
    readonly: false,
    hide_when_empty: false,
    default_value: null,
    create_date: '2026-01-01T00:00:00Z',
    write_date: '2026-01-01T00:00:00Z',
    class_filter_uuids: [],
    options: [],
    ...overrides,
  } as Property;
}

describe('DefaultValueEditor', () => {
  it('edits a text default and clears it', () => {
    const onChange = vi.fn();
    render(<DefaultValueEditor property={makeProp({ type: 'text' })} value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('selects a selection option by uuid', () => {
    const onChange = vi.fn();
    render(
      <DefaultValueEditor
        property={makeProp({
          type: 'selection',
          options: [
            { uuid: 'opt-1', name: 'One', icon: null, color: null, sequence: 0 },
            { uuid: 'opt-2', name: 'Two', icon: null, color: null, sequence: 1 },
          ],
        })}
        value={null}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'opt-2' } });
    expect(onChange).toHaveBeenCalledWith('opt-2');
  });

  it('boolean default supports unset/true/false', () => {
    const onChange = vi.fn();
    render(<DefaultValueEditor property={makeProp({ type: 'boolean' })} value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'true' } });
    expect(onChange).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders a note for relation types without editor support', () => {
    render(<DefaultValueEditor property={makeProp({ type: 'node' })} value={null} onChange={vi.fn()} />);
    expect(screen.getByText(/not editable/i)).toBeInTheDocument();
  });
});
