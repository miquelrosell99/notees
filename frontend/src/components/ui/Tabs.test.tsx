import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Tabs } from './Tabs';

describe('Tabs', () => {
  it('renders tabs and marks the active one with aria-selected', () => {
    render(
      <Tabs value="b" onChange={() => {}}>
        <Tabs.List>
          <Tabs.Tab value="a">Tab A</Tabs.Tab>
          <Tabs.Tab value="b">Tab B</Tabs.Tab>
          <Tabs.Tab value="c">Tab C</Tabs.Tab>
        </Tabs.List>
      </Tabs>,
    );

    const tabA = screen.getByRole('tab', { name: 'Tab A' });
    const tabB = screen.getByRole('tab', { name: 'Tab B' });
    const tabC = screen.getByRole('tab', { name: 'Tab C' });

    expect(tabA).toHaveAttribute('aria-selected', 'false');
    expect(tabB).toHaveAttribute('aria-selected', 'true');
    expect(tabC).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onChange when a non-active tab is clicked', async () => {
    const handleChange = vi.fn();
    render(
      <Tabs value="a" onChange={handleChange}>
        <Tabs.List>
          <Tabs.Tab value="a">Tab A</Tabs.Tab>
          <Tabs.Tab value="b">Tab B</Tabs.Tab>
        </Tabs.List>
      </Tabs>,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Tab B' }));
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith('b');
  });

  it('does not call onChange when the active tab is clicked', async () => {
    const handleChange = vi.fn();
    render(
      <Tabs value="a" onChange={handleChange}>
        <Tabs.List>
          <Tabs.Tab value="a">Tab A</Tabs.Tab>
          <Tabs.Tab value="b">Tab B</Tabs.Tab>
        </Tabs.List>
      </Tabs>,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Tab A' }));
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('does not call onChange when a disabled tab is clicked', async () => {
    const handleChange = vi.fn();
    render(
      <Tabs value="a" onChange={handleChange}>
        <Tabs.List>
          <Tabs.Tab value="a">Tab A</Tabs.Tab>
          <Tabs.Tab value="b" disabled>Tab B</Tabs.Tab>
        </Tabs.List>
      </Tabs>,
    );

    expect(screen.getByRole('tab', { name: 'Tab B' })).toBeDisabled();
    await userEvent.click(screen.getByRole('tab', { name: 'Tab B' }));
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('renders an icon when provided', () => {
    render(
      <Tabs value="a" onChange={() => {}}>
        <Tabs.List>
          <Tabs.Tab value="a" icon="mdi mdi-home">Tab A</Tabs.Tab>
        </Tabs.List>
      </Tabs>,
    );

    const tab = screen.getByRole('tab', { name: 'Tab A' });
    expect(tab.querySelector('svg')).toBeInTheDocument();
  });

  it('calls onClick for the add button', async () => {
    const handleAdd = vi.fn();
    render(
      <Tabs value="a" onChange={() => {}}>
        <Tabs.List>
          <Tabs.Tab value="a">Tab A</Tabs.Tab>
          <Tabs.AddButton onClick={handleAdd} aria-label="Add tab" />
        </Tabs.List>
      </Tabs>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    expect(handleAdd).toHaveBeenCalledTimes(1);
  });

  it('only renders the active panel', () => {
    render(
      <Tabs value="b" onChange={() => {}}>
        <Tabs.List>
          <Tabs.Tab value="a">Tab A</Tabs.Tab>
          <Tabs.Tab value="b">Tab B</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="a">Content A</Tabs.Panel>
        <Tabs.Panel value="b">Content B</Tabs.Panel>
      </Tabs>,
    );

    expect(screen.queryByText('Content A')).not.toBeInTheDocument();
    expect(screen.getByText('Content B')).toBeInTheDocument();
  });

  it('links tab and panel with aria-controls and aria-labelledby', () => {
    render(
      <Tabs value="a" onChange={() => {}}>
        <Tabs.List>
          <Tabs.Tab value="a">Tab A</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="a">Content A</Tabs.Panel>
      </Tabs>,
    );

    const tab = screen.getByRole('tab', { name: 'Tab A' });
    const panel = screen.getByRole('tabpanel');

    expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
  });
});
