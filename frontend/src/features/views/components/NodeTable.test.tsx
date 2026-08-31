import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NodeTable, type TableColumn } from './NodeTable';
import type { Node } from '@/types';

// Stub the content-feature cell components — the test targets NodeTable's
// node-cell detection, not their rendering.
vi.mock('@/features/content', () => ({
  NodeInline: () => null,
  NodeNameContent: ({ name }: { name: string }) => <span data-testid="node-name">{name}</span>,
  NodeCellEditable: () => null,
  NodeBreadcrumbs: () => null,
}));

/**
 * Nodes projected from the local-first SQLite store have no numeric `id`
 * (uuids are the only identity). A stale `isNode` check requiring a numeric
 * `id` made the name column fall through to rendering the raw Node object,
 * crashing React with "Objects are not valid as a React child".
 */
const projectedNode = {
  uuid: 'node-uuid-1',
  name: 'Classed node',
  content: '',
  display_name: 'Classed node',
  icon: null,
  color: null,
  parent_uuid: null,
  page_uuid: null,
  sequence: 0,
  active: true,
  is_page: false,
  is_class: false,
  create_date: '2026-08-31T00:00:00Z',
  write_date: '2026-08-31T00:00:00Z',
} as unknown as Node;

const nameColumn: TableColumn<Node> = {
  key: 'name',
  header: 'Name',
  // Mirrors TableView's name column: returns the row node itself
  accessor: (node) => node as unknown as ReactNode,
  renderNodeCell: true,
};

describe('NodeTable node-cell detection', () => {
  it('renders a node name cell for projected nodes without a numeric id', () => {
    render(
      <NodeTable
        data={[projectedNode]}
        columns={[nameColumn]}
        getRowKey={(n) => n.uuid}
        selectable={false}
        caption="Test table"
      />,
    );
    expect(screen.getByTestId('node-name')).toHaveTextContent('Classed node');
  });

  it('still renders plain values for non-node cells', () => {
    const textColumn: TableColumn<Node> = {
      key: 'write_date',
      header: 'Modified',
      accessor: (node) => String(node.write_date ?? ''),
      renderNodeCell: false,
    };
    render(
      <NodeTable
        data={[projectedNode]}
        columns={[textColumn]}
        getRowKey={(n) => n.uuid}
        selectable={false}
        caption="Test table"
      />,
    );
    expect(screen.getByText('2026-08-31T00:00:00Z')).toBeInTheDocument();
  });
});
