import { describe, it, expect } from 'vitest';
import { getEffectiveColor, getEffectiveIcon } from './nodeIcon';
import type { Node } from '@/types';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    uuid: '00000000-0000-0000-0000-000000000000',
    name: 'Test Node',
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: true,
    create_date: '2024-01-01T00:00:00Z',
    write_date: '2024-01-01T00:00:00Z',
    ...overrides,
  } as Node;
}

describe('getEffectiveColor', () => {
  it('inherits color from parent class when class node has no own color', () => {
    const parentClass = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Parent Class',
      color: '#ff0000',
      is_class: true,
    });
    const childClass = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Child Class',
      color: null,
      is_class: true,
      // Generic node responses (e.g. getNode) do not populate extends_uuid,
      // so the child response itself has no extends chain.
    });
    const allClasses = [parentClass, makeNode({
      uuid: childClass.uuid,
      name: childClass.name,
      color: null,
      is_class: true,
      extends_uuid: [parentClass.uuid],
    })];

    expect(getEffectiveColor(childClass, allClasses)).toBe('#ff0000');
  });

  it('prefers own color over inherited color', () => {
    const parentClass = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Parent Class',
      color: '#ff0000',
      is_class: true,
    });
    const childClass = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Child Class',
      color: '#00ff00',
      is_class: true,
    });
    const allClasses = [parentClass, makeNode({
      uuid: childClass.uuid,
      name: childClass.name,
      color: '#00ff00',
      is_class: true,
      extends_uuid: [parentClass.uuid],
    })];

    expect(getEffectiveColor(childClass, allClasses)).toBe('#00ff00');
  });

  it('inherits color for a node from an assigned class that extends a colored class', () => {
    const parentClass = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Parent Class',
      color: '#ff0000',
      is_class: true,
    });
    const childClass = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Child Class',
      color: null,
      is_class: true,
      extends_uuid: [parentClass.uuid],
    });
    const page = makeNode({
      uuid: '33333333-3333-3333-3333-333333333333',
      name: 'Page',
      color: null,
      classes_uuid: [childClass.uuid],
    });

    expect(getEffectiveColor(page, [parentClass, childClass])).toBe('#ff0000');
  });

  it('inherits color for a child class node even when it has its own system classes', () => {
    const agentClass = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Agent',
      color: '#ff8800',
      is_class: true,
    });
    const systemClassClass = makeNode({
      uuid: '99999999-9999-9999-9999-999999999999',
      name: 'Class',
      color: null,
      is_class: true,
    });
    const personClass = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Person',
      color: null,
      is_class: true,
      extends_uuid: [agentClass.uuid],
      classes_uuid: [systemClassClass.uuid],
    });

    expect(getEffectiveColor(personClass, [agentClass, systemClassClass, personClass])).toBe('#ff8800');
  });
});

describe('getEffectiveIcon', () => {
  it('inherits icon from parent class when class node has no own icon', () => {
    const parentClass = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Parent Class',
      icon: 'mdi mdi-star',
      is_class: true,
    });
    const childClass = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Child Class',
      icon: null,
      is_class: true,
    });
    const allClasses = [parentClass, makeNode({
      uuid: childClass.uuid,
      name: childClass.name,
      icon: null,
      is_class: true,
      extends_uuid: [parentClass.uuid],
    })];

    expect(getEffectiveIcon(childClass, allClasses)).toBe('mdi mdi-star');
  });

  it('inherits color across multi-level class extends chain', () => {
    const agentClass = makeNode({
      uuid: '11111111-1111-1111-1111-111111111111',
      name: 'Agent Class',
      color: '#ff8800',
      is_class: true,
    });
    const organizationClass = makeNode({
      uuid: '22222222-2222-2222-2222-222222222222',
      name: 'Organization Class',
      color: null,
      icon: 'mdi mdi-office-building',
      is_class: true,
      extends_uuid: [agentClass.uuid],
    });
    const childClass = makeNode({
      uuid: '33333333-3333-3333-3333-333333333333',
      name: 'Child Class',
      color: null,
      icon: null,
      is_class: true,
      extends_uuid: [organizationClass.uuid],
    });

    expect(getEffectiveColor(childClass, [agentClass, organizationClass, childClass])).toBe('#ff8800');
    expect(getEffectiveIcon(childClass, [agentClass, organizationClass, childClass])).toBe('mdi mdi-office-building');
  });
});
