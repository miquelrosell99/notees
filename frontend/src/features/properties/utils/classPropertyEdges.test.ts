/**
 * orderClassPropertyEdges tests.
 *
 * The frontend fetches inherited class properties per class; enforcement
 * (backend get_class_property_edges_for_node) resolves edges ordered by
 * (depth, class position): all direct class edges first, then inherited.
 * The helper must reproduce that so first-occurrence-wins dedup agrees.
 */
import { describe, it, expect } from 'vitest';
import { orderClassPropertyEdges } from './classPropertyEdges';
import type { ClassProperty } from '@/types/api';

function edge(partial: Partial<ClassProperty>): ClassProperty {
  return {
    class_node_uuid: 'class-x',
    class_node_name: 'X',
    property_uuid: 'prop',
    property_name: 'P',
    property_type: 'text',
    sequence: 0,
    default_value: null,
    hidden: false,
    required: null,
    readonly: null,
    hide_when_empty: null,
    ...partial,
  };
}

describe('orderClassPropertyEdges', () => {
  it('puts direct edges of all classes before inherited edges (backend order)', () => {
    // NEW-3: property P is declared directly on class B and inherited by
    // class A from an ancestor. Enforcement resolves B's direct edge
    // (depth 0) before A's ancestor edge; the display must agree.
    const classUuids = ['class-a', 'class-b'];
    const perClass = [
      [
        edge({ property_uuid: 'prop-a', class_node_uuid: 'class-a' }),
        edge({ property_uuid: 'prop-p', class_node_uuid: 'ancestor-a' }), // inherited by A
      ],
      [
        edge({ property_uuid: 'prop-p', class_node_uuid: 'class-b' }), // direct on B
      ],
    ];

    const ordered = orderClassPropertyEdges(classUuids, perClass);

    expect(ordered.map(e => `${e.property_uuid}@${e.class_node_uuid}`)).toEqual([
      'prop-a@class-a',
      'prop-p@class-b',
      'prop-p@ancestor-a',
    ]);
  });

  it('preserves per-class order within the direct and inherited buckets', () => {
    const classUuids = ['class-a', 'class-b'];
    const perClass = [
      [
        edge({ property_uuid: 'p1', class_node_uuid: 'class-a' }),
        edge({ property_uuid: 'p2', class_node_uuid: 'anc-1' }),
        edge({ property_uuid: 'p3', class_node_uuid: 'anc-2' }),
      ],
      [
        edge({ property_uuid: 'p4', class_node_uuid: 'class-b' }),
        edge({ property_uuid: 'p5', class_node_uuid: 'anc-3' }),
      ],
    ];

    expect(orderClassPropertyEdges(classUuids, perClass).map(e => e.property_uuid))
      .toEqual(['p1', 'p4', 'p2', 'p3', 'p5']);
  });

  it('skips classes whose edges have not loaded yet', () => {
    const ordered = orderClassPropertyEdges(
      ['class-a', 'class-b'],
      [undefined, [edge({ property_uuid: 'p', class_node_uuid: 'class-b' })]],
    );
    expect(ordered.map(e => e.property_uuid)).toEqual(['p']);
  });

  it('returns an empty list for a classless node', () => {
    expect(orderClassPropertyEdges([], [])).toEqual([]);
  });
});
