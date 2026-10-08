/**
 * Views barrel — importing this module registers every built-in view
 * (registration side effects), so containers only import from here.
 */

import "./OutlineView.js";
import "./ProseView.js";
import "./CardsView.js";
import "./TableView.js";
import "./graph/GraphView.js";

export { registerView, unregisterView, getViewDefinition, getRegisteredViewModes, getViewModeOptions } from "./registry.js";
export type { ViewModeOption } from "./registry.js";
export { groupByContainingPage } from "./grouping.js";
export { useWindowed, DEFAULT_WINDOW_SIZE } from "./useWindowed.js";
export type { UseWindowedOptions, WindowedState } from "./useWindowed.js";
export { ShowMoreButton } from "./ShowMoreButton.js";
export { NodeCollection } from "./NodeCollection.js";
export { SECTION_DEFAULT_TAB, SectionViewTabs, autoViewName } from "./SectionViewTabs.js";
export { planSectionView, applySectionView, resolveSectionViewProbed, useSectionViewResolution } from "./sectionViewResolve.js";
export { ViewSwitcher } from "./ViewSwitcher.js";
export { ViewToolbar } from "./ViewToolbar.js";
export type {
  AnyClient,
  CollectionGroup,
  HostedViewsConfig,
  NodeCollectionItem,
  NodeCollectionProps,
  TableColumn,
  SortDirection,
  SortSpec,
  ViewCapabilities,
  ViewMode,
  ViewRegistryEntry,
} from "./types.js";
