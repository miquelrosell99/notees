import { describe, it, expect } from 'vitest';
import { isInsideEditorCompanion } from './editorCompanion';

describe('isInsideEditorCompanion', () => {
  it('returns false for a plain target', () => {
    const div = document.createElement('div');
    expect(isInsideEditorCompanion(div)).toBe(false);
  });

  it('returns true when the target itself is marked as a companion', () => {
    const input = document.createElement('input');
    input.setAttribute('data-editor-companion', 'true');
    expect(isInsideEditorCompanion(input)).toBe(true);
  });

  it('returns true when the target is inside a companion ancestor', () => {
    const companion = document.createElement('div');
    companion.setAttribute('data-editor-companion', 'true');
    const wrapper = document.createElement('div');
    const input = document.createElement('input');
    companion.appendChild(wrapper);
    wrapper.appendChild(input);
    expect(isInsideEditorCompanion(input)).toBe(true);
  });

  it('returns false for non-Element targets', () => {
    expect(isInsideEditorCompanion(null)).toBe(false);
    expect(isInsideEditorCompanion(document.createTextNode('x'))).toBe(false);
  });
});
