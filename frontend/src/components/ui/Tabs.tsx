/**
 * Tabs Component
 *
 * A reusable, accessible tab switcher styled after the node tab bar.
 * Provides a contained pill bar, a sliding underline indicator for the
 * active tab, muted vertical dividers between tabs, and an optional
 * add-tab button.
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
  useMemo,
  useId,
  type ReactNode,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from 'react';

import { Button } from './Button';
import { Icon } from '@/components/ui/icons';
import { cn } from '@/utils/cn';
import './Tabs.css';

interface TabsContextValue<TValue extends string = string> {
  value: TValue;
  onChange: (value: TValue) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue<string> | null>(null);

function useTabsContext<TValue extends string = string>(componentName: string): TabsContextValue<TValue> {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used inside <Tabs>`);
  }
  return ctx as unknown as TabsContextValue<TValue>;
}

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
  const baseId = useId();
  const ctx = useMemo<TabsContextValue<TValue>>(
    () => ({ value, onChange, baseId }),
    [value, onChange, baseId],
  );

  return (
    <TabsContext.Provider value={ctx as unknown as TabsContextValue<string>}>
      <div className={cn('tabs', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export type TabsVariant = 'ghost' | 'contained';

export interface TabsListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  children: ReactNode;
  /** Visual variant. `ghost` is minimal (no border/background). `contained` renders the node-tab pill bar. */
  variant?: TabsVariant;
}

function TabsList({ children, variant = 'ghost', className = '', ...props }: TabsListProps) {
  const { value } = useTabsContext('Tabs.List');
  const listRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});

  const updateIndicator = useCallback(() => {
    const list = listRef.current;
    if (!list) return;

    const activeTab = list.querySelector('.tabs__tab--active') as HTMLElement | null;
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
    <div
      ref={listRef}
      className={cn('tabs__list', `tabs__list--${variant}`, className)}
      role="tablist"
      {...props}
    >
      <span className="tabs__indicator" style={indicatorStyle} aria-hidden="true" />
      {children}
    </div>
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
  onKeyDown,
  ...props
}: TabProps<TValue>) {
  const { value, onChange, baseId } = useTabsContext<TValue>('Tabs.Tab');
  const isActive = value === tabValue;
  const valueKey = String(tabValue);
  const tabId = `${baseId}-tab-${valueKey}`;
  const panelId = `${baseId}-panel-${valueKey}`;

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!disabled && !isActive) {
        onChange(tabValue);
      }
      onClick?.(e);
    },
    [disabled, isActive, onChange, tabValue, onClick],
  );

  // WAI-ARIA tabs: ArrowLeft/ArrowRight (plus Home/End) move focus between
  // tabs and activate the target tab (automatic activation).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
        onKeyDown?.(e);
        return;
      }
      const list = e.currentTarget.closest('[role="tablist"]');
      const tabs = list
        ? Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
        : [];
      const currentIndex = tabs.indexOf(e.currentTarget);
      if (currentIndex === -1) {
        onKeyDown?.(e);
        return;
      }
      e.preventDefault();
      let nextIndex = currentIndex;
      if (e.key === 'ArrowLeft') nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
      else if (e.key === 'ArrowRight') nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
      else if (e.key === 'Home') nextIndex = 0;
      else nextIndex = tabs.length - 1;
      const nextTab = tabs[nextIndex];
      nextTab.focus();
      const nextValue = nextTab.dataset.value as TValue | undefined;
      if (nextValue !== undefined && nextValue !== tabValue) {
        onChange(nextValue);
      }
      onKeyDown?.(e);
    },
    [onChange, tabValue, onKeyDown],
  );

  return (
    <button
      id={tabId}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={panelId}
      disabled={disabled}
      tabIndex={isActive ? 0 : -1}
      data-value={valueKey}
      className={cn(
        'tabs__tab',
        isActive && 'tabs__tab--active',
        disabled && 'tabs__tab--disabled',
        className,
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {icon && <Icon path={icon} size={0.75} className="tabs__tab-icon" />}
      <span className="tabs__tab-label">{children}</span>
    </button>
  );
}

export interface TabsAddButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'variant' | 'size' | 'icon'> {
  /** Accessible label for the add button. */
  'aria-label': string;
}

function TabsAddButton({ className = '', ...props }: TabsAddButtonProps) {
  return (
    <div className={cn('tabs__add-slot', className)}>
      <span className="tabs__section-divider" aria-hidden="true" />
      <Button
        variant="ghost"
        size="xs"
        icon="mdi mdi-plus"
        className="tabs__add-button"
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
  const { value, baseId } = useTabsContext<TValue>('Tabs.Panel');
  const isActive = value === panelValue;
  const valueKey = String(panelValue);
  const tabId = `${baseId}-tab-${valueKey}`;
  const panelId = `${baseId}-panel-${valueKey}`;

  if (!isActive) return null;

  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      className={cn('tabs__panel', className)}
      {...props}
    >
      {children}
    </div>
  );
}

Tabs.List = TabsList;
Tabs.Tab = Tab;
Tabs.AddButton = TabsAddButton;
Tabs.Panel = TabPanel;
