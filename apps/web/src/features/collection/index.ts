/**
 * Views barrel — importing this module registers every built-in view
 * (registration side effects), so containers only import from here.
 */

import "./OutlineView.js";
import "./ProseView.js";
import "./CardsView.js";
import "./TableView.js";
import "./graph/GraphView.js";
import "./pivot/PivotView.js";
import "./gantt/GanttView.js";

export { registerView, unregisterView, getViewDefinition, getRegisteredViewModes, getViewModeOptions, availableViewModes } from "./registry.js";
export type { ViewAvailabilityContext, ViewModeOption } from "./registry.js";
export { computeViewAvailability, useAvailableViewModes } from "./availability.js";
export { groupByContainingPage } from "./grouping.js";
export type { ContainingPageGrouping } from "./grouping.js";
export { useWindowed, DEFAULT_WINDOW_SIZE } from "./useWindowed.js";
export type { UseWindowedOptions, WindowedState } from "./useWindowed.js";
export { ShowMoreButton } from "./ShowMoreButton.js";
export { NodeCollection } from "./NodeCollection.js";
export { SECTION_DEFAULT_TAB, NodeCollectionTabs, autoViewName } from "./NodeCollectionTabs.js";
export { NodeCollectionTopBar } from "./NodeCollectionTopBar.js";
export { planSectionView, applySectionView, resolveSectionViewProbed, useSectionViewResolution } from "./sectionViewResolve.js";
export { ViewSwitcher } from "./ViewSwitcher.js";
export { ViewToolbar } from "./ViewToolbar.js";
export type {
  AnyClient,
  CollectionGroup,
  HostedViewsConfig,
  NodeCollectionItem,
  NodeCollectionProps,
  SortMode,
  TableColumn,
  SortDirection,
  SortSpec,
  ViewCapabilities,
  ViewMode,
  ViewRegistryEntry,
} from "./types.js";
