import { describe, it, expect } from 'vitest';
import { TextCrdt } from '../text';

describe('TextCrdt', () => {
  it('round-trips plain text through state reload', () => {
    const crdt = new TextCrdt();
    crdt.insert(0, 'Hello');

    const reloaded = new TextCrdt(crdt.getState());

    expect(reloaded.toPlaintext()).toBe('Hello');
  });

  it('preserves formatting attributes across state reload', () => {
    const crdt = new TextCrdt();
    crdt.insert(0, 'Hello world');
    crdt.format(0, 5, { bold: true });

    const reloaded = new TextCrdt(crdt.getState());

    expect(reloaded.toPlaintext()).toBe('Hello world');
    const deltas = reloaded.toDelta();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      insert: 'Hello',
      attributes: { bold: true },
    });
    expect(deltas[1]).toMatchObject({ insert: ' world' });
  });

  it('merges concurrent formatting updates', () => {
    const base = new TextCrdt();
    base.insert(0, 'Hello world');
    const baseState = base.getState();

    const left = new TextCrdt(baseState);
    left.format(0, 5, { bold: true });

    const right = new TextCrdt(baseState);
    right.format(6, 5, { italic: true });

    const merged = new TextCrdt();
    merged.applyUpdate(left.getState());
    merged.applyUpdate(right.getState());

    expect(merged.toPlaintext()).toBe('Hello world');
    const deltas = merged.toDelta();
    const boldDelta = deltas.find(
      (d) => (d.attributes as Record<string, unknown> | undefined)?.bold === true
    );
    const italicDelta = deltas.find(
      (d) => (d.attributes as Record<string, unknown> | undefined)?.italic === true
    );
    expect(boldDelta?.insert).toBe('Hello');
    expect(italicDelta?.insert).toBe('world');
  });
});
