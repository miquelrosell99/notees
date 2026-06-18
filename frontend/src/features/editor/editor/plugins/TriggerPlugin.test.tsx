/**
 * Regression tests for TriggerPlugin.
 */

// jsdom does not implement getBoundingClientRect; Lexical's internal selection
// update and our caret-coordinate helper rely on it existing. Provide a stub
// so the tests run without throwing unrelated layout errors.
function stubGetBoundingClientRect() {
  const stub = () =>
    ({ bottom: 0, left: 0, top: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
  if (!('getBoundingClientRect' in Range.prototype)) {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: stub });
  }
  if (!('getBoundingClientRect' in Text.prototype)) {
    Object.defineProperty(Text.prototype, 'getBoundingClientRect', { value: stub });
  }
}
stubGetBoundingClientRect();

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { forwardRef, createRef, useImperativeHandle, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { ParagraphNode, TextNode } from 'lexical';
import { notesEditorTheme } from '../theme';
import { InlineLinkNode } from '../nodes/InlineLinkNode';
import { MathNode } from '../nodes/MathNode';
import { TriggerPlugin } from './TriggerPlugin';

// Mock popup so we only test trigger detection/opening, not search hooks.
vi.mock('./TriggerPopup', () => ({
  TriggerPopup: (props: { type: string }) => (
    <div data-testid="trigger-popup" data-type={props.type}>{props.type}</div>
  ),
}));

vi.mock('@/stores/inputContext', () => ({
  useInputContext: {
    getState: () => ({
      enterPopup: vi.fn(),
      leavePopup: vi.fn(),
    }),
  },
}));

vi.mock('@/stores/editorFocusStore', () => ({
  useEditorFocusStore: {
    getState: () => ({
      openPopup: vi.fn(),
      closePopup: vi.fn(),
      setPendingFocus: vi.fn(),
    }),
  },
}));

vi.mock('@/runtime', () => ({
  getOperationRuntime: () => ({}),
}));

vi.mock('@/runtime/graphHelpers', () => ({
  getNode: () => ({ serverId: 42 }),
}));

vi.mock('@/runtime/eventBus', () => ({
  getRuntimeEventBus: () => ({ flushEvents: vi.fn() }),
}));

vi.mock('@/stores/undoEngine', () => ({
  getUndoEngine: () => ({ applyIntent: vi.fn() }),
}));

const initialConfig = {
  namespace: 'TriggerPluginTest',
  theme: notesEditorTheme,
  nodes: [ParagraphNode, TextNode, InlineLinkNode, MathNode],
  onError: vi.fn(),
  editable: true,
};

interface TestEditorHandle {
  focus: () => void;
}

const TestEditor = forwardRef<TestEditorHandle, object>(function TestEditor(
  _props,
  ref,
): JSX.Element {
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <TestEditorInner ref={ref} />
    </LexicalComposer>
  );
});

const TestEditorInner = forwardRef<TestEditorHandle, object>(function TestEditorInner(
  _props,
  ref,
): JSX.Element {
  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
      el?.focus();
    },
  }));

  return (
    <>
      <RichTextPlugin
        contentEditable={<ContentEditable aria-label="Test content" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <TriggerPlugin blockId="test-block" />
    </>
  );
});

async function setupTriggerTest(trigger: string) {
  const user = userEvent.setup();
  const ref = createRef<TestEditorHandle>();
  render(<TestEditor ref={ref} />);

  await waitFor(() => expect(ref.current).not.toBeNull());

  const contentEditable = document.querySelector('[contenteditable="true"]') as HTMLElement;
  await waitFor(() => expect(contentEditable).toBeTruthy());

  await user.click(contentEditable);
  await user.keyboard(trigger);

  return { user, contentEditable };
}

describe('TriggerPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['@', '+', '#', '/'] as const)('opens a popup when "%s" is typed in edit mode', async (trigger) => {
    await setupTriggerTest(trigger);

    const popup = document.querySelector('[data-testid="trigger-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.getAttribute('data-type')).toBe(
      trigger === '+' ? 'class' : trigger === '@' ? 'link' : trigger === '#' ? 'tag' : 'slash',
    );
  });
});
