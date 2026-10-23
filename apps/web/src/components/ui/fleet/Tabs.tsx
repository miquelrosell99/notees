/**
 * Tabs Component
 *
 * A reusable, accessible tab switcher styled after the node tab bar.
 * Provides a contained pill bar, a sliding underline indicator for the
 * active tab, muted vertical dividers between tabs, and an optional
 * add-tab button.
 *
 * Thin fleet wrapper over the normalized catalog tabs
 * (src/components/ui/tabs.tsx — Radix Tabs underneath): focus management,
 * arrow-key navigation, activation, and the tab/tabpanel ARIA wiring are
 * the catalog's (Radix's). The sliding-indicator pill-bar register is the
 * app's and stays in Tabs.css, with the legacy `tabs__*` classes kept as
 * the hook feature CSS compounds on (SectionViewTabs, NodeSelector).
 *
 * Usage:
 *   <Tabs value={activeTab} onChange={setActiveTab}>
 *     <Tabs.List>
 *       <Tabs.Tab value="a" icon="mdi mdi-home">Tab A</Tabs.Tab>
 *       <Tabs.Tab value="b">Tab B</Tabs.Tab>
 *       <Tabs.AddButton onClick={handleAdd} aria-label="Add tab" />
 *     </Tabs.List>
 *     <Tabs.Panel value="a">Content A</Tabs.Panel>
 *     <Tabs.Panel value="b">Content B</Tabs.Panel>
 *   </Tabs>
 */
import {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type CSSProperties,
} from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { Button } from './Button.js';
import { Icon } from '../../../ui/Icon.js';
import { cn } from './cn.js';
import './Tabs.css';

/** The controlled value + change handler, provided by the root: the list
 * re-measures its sliding indicator when the active tab changes, and the
 * Tab trigger activates on CLICK as well as Radix's mousedown (the app's
 * interaction contract predates the catalog). */
const TabsValueContext = createContext<{ value: string; onChange: (value: string) => void }>({
  value: "",
  onChange: () => {},
});

export interface TabsProps<TValue extends string = string> {
  /** Currently active tab value. */
  value: TValue;
  /** Called when the active tab changes. */
  onChange: (value: TValue) => void;
  /** Tab list and optional panels. */
  children: ReactNode;
  /** Additional class on the root element. */
  className?: string;
}

export function Tabs<TValue extends string = string>({
  value,
  onChange,
  children,
  className = '',
}: TabsProps<TValue>) {
  return (
    <TabsValueContext.Provider
      value={{ value, onChange: (v) => onChange(v as TValue) }}
    >
      <TabsPrimitive.Root
        value={value}
        onValueChange={(v) => onChange(v as TValue)}
        className={cn('tabs', className)}
      >
        {children}
      </TabsPrimitive.Root>
    </TabsValueContext.Provider>
  );
}

export type TabsVariant = 'ghost' | 'contained';

export interface TabsListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  children: ReactNode;
  /** Visual variant. `ghost` is minimal (no border/background). `contained` renders the node-tab pill bar. */
  variant?: TabsVariant;
}

function TabsList({ children, variant = 'ghost', className = '', ...props }: TabsListProps) {
  // The controlled value drives the indicator: re-measure when it changes
  // (the active trigger swaps via Radix's data-state).
  const { value } = useContext(TabsValueContext);
  const listRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<CSSProperties>({});

  const updateIndicator = useCallback(() => {
    const list = listRef.current;
    if (!list) return;

    const activeTab = list.querySelector('.tabs__tab[data-state="active"]') as HTMLElement | null;
    if (!activeTab) {
      setIndicatorStyle({});
      return;
    }

    const listRect = list.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    const indicatorWidth = Math.min(Math.max(16, tabRect.width * 0.55), 36);
    const offsetLeft = tabRect.left - listRect.left + (tabRect.width - indicatorWidth) / 2;

    setIndicatorStyle({
      width: indicatorWidth,
      transform: `translateX(${offsetLeft}px)`,
    });
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    updateIndicator();

    const ro = new ResizeObserver(updateIndicator);
    ro.observe(list);
    list.querySelectorAll('.tabs__tab').forEach((tab) => ro.observe(tab));

    return () => ro.disconnect();
  }, [value, updateIndicator]);

  return (
    <TabsPrimitive.List
      ref={listRef}
      className={cn('tabs__list', `tabs__list--${variant}`, className)}
      {...props}
    >
      <span className="tabs__indicator" style={indicatorStyle} aria-hidden="true" />
      {children}
    </TabsPrimitive.List>
  );
}

export interface TabProps<TValue extends string = string>
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'aria-selected' | 'value'> {
  /** Unique value for this tab. */
  value: TValue;
  /** Tab label. */
  children: ReactNode;
  /** Optional MDI icon class (e.g. "mdi mdi-home"). */
  icon?: string;
  /** Whether the tab is disabled. */
  disabled?: boolean;
}

function Tab<TValue extends string = string>({
  value: tabValue,
  children,
  icon,
  disabled = false,
  className = '',
  onClick,
  ...props
}: TabProps<TValue>) {
  const { onChange } = useContext(TabsValueContext);
  return (
    <TabsPrimitive.Trigger
      value={String(tabValue)}
      disabled={disabled}
      data-value={String(tabValue)}
      className={cn('tabs__tab', className)}
      onClick={(event) => {
        // The app contract activates tabs on click (Radix activates on
        // mousedown); the controlled root makes both paths converge.
        if (!disabled) onChange(String(tabValue));
        onClick?.(event);
        // Radix focuses the activated trigger, and the programmatic focus
        // draws the focus-visible ring — read as a selection border after
        // a pointer click (owner 2026-10-23). POINTER activation (detail >
        // 0) blurs; keyboard activation keeps focus — the ring and the
        // arrow-key navigation stay for keyboard users.
        if (event.detail > 0) event.currentTarget.blur();
      }}
      {...props}
    >
      {icon && <Icon path={icon} size={0.75} className="tabs__tab-icon" />}
      <span className="tabs__tab-label">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

export interface TabsAddButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'variant' | 'size' | 'icon'> {
  /** Accessible label for the add button. */
  'aria-label': string;
}

function TabsAddButton({ className = '', title, ...props }: TabsAddButtonProps) {
  // The add button is icon-only: the accessible name doubles as the hover
  // tooltip unless the caller names it explicitly.
  return (
    <div className={cn('tabs__add-slot', className)}>
      <span className="tabs__section-divider" aria-hidden="true" />
      <Button
        variant="ghost"
        size="xs"
        icon="mdi mdi-plus"
        className="tabs__add-button"
        title={title ?? props['aria-label']}
        {...props}
      />
    </div>
  );
}

export interface TabPanelProps<TValue extends string = string> extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** Value of the tab this panel belongs to. */
  value: TValue;
  children: ReactNode;
}

function TabPanel<TValue extends string = string>({
  value: panelValue,
  children,
  className = '',
  ...props
}: TabPanelProps<TValue>) {
  return (
    <TabsPrimitive.Content
      value={String(panelValue)}
      className={cn('tabs__panel', className)}
      {...props}
    >
      {children}
    </TabsPrimitive.Content>
  );
}

Tabs.List = TabsList;
Tabs.Tab = Tab;
Tabs.AddButton = TabsAddButton;
Tabs.Panel = TabPanel;
