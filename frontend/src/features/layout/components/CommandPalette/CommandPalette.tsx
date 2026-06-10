/**
 * CommandPalette - Floating search modal (Ctrl+K)
 *
 * Features:
 * - Search all node names including parent hierarchy
 * - Pages section (with + Add page if no match)
 * - Blocks section
 * - Auto-select first result for quick navigation
 * - Quick add section
 * - Filter prefix system: class:, uuid:, is_page:, is_class:, is_daily:
 * - class: triggers class suggestion popup for easy class selection
 */
import './CommandPalette.css';
import { useCommandPalette } from './useCommandPalette';
import { ResultItem } from './CommandPaletteResult';
import { SuggestionPopup } from '@/features/content/components/nodes/SuggestionPopup';
import { NodeRef } from '@/features/content/components/nodes/NodeRef';
import { DuplicatePageModal } from '../Modals';
import { Button } from '@/components/ui/Button';
import { Icon, AddIcon, CalendarIcon, ImportIcon, CheckIcon, ChevronRightIcon } from '@/components/ui/icons';

import type { CommandPaletteProps } from './CommandPalette.types';

export type { CommandPaletteProps } from './CommandPalette.types';

export function CommandPalette(props: CommandPaletteProps) {
  const {
    query,
    setQuery,
    appliedFilters,
    classPopupPosition,
    duplicateModal,
    setDuplicateModal,
    inputRef,
    containerRef,
    isTypingClass,
    isTypingFilter,
    classQuery,
    isLoading,
    debouncedSearchTerm,
    parsedDate,
    pathInfo,
    isOpen,
    allItems,
    selectedIndex,
    handleKeyDown,
    handleSelect,
    handleClassSelect,
    handleRemoveFilter,
    handleClassCreate,
    handleBackdropClick,
    groupedItems,
    pageClassId,
    allClasses,
    allPages,
    searchResults,
    openNode,
    refreshRandomPages,
  } = useCommandPalette(props);

  const { onClose } = props;

  const {
    dateItems,
    pageItems,
    blockItems,
    propertyItems,
    quickAddItems,
    commandItems,
    filterPrefixItems,
    booleanOptionItems,
    browseRecentAccessed,
    browseRecentCreated,
    browseRandom,
    indexMap,
  } = groupedItems;

  return (
    <>
    <div className={`command-palette__backdrop${isOpen ? '' : ' command-palette__backdrop--hidden'}`} onClick={handleBackdropClick}>
      <div ref={containerRef} className="command-palette">
        <div className="command-palette__input-container">
          <input
            ref={inputRef}
            type="text"
            className="command-palette__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={appliedFilters.length > 0 ? "Search with active filters..." : "Search pages, blocks, properties... (try class: uuid: is_page:)"}
          />
          {/* Filter pills — classes + boolean filters */}
          {appliedFilters.length > 0 && (
            <div className="command-palette__class-pills">
              {appliedFilters.map((filter, idx) => (
                filter.type === 'class' ? (
                  <NodeRef
                    key={`class-${filter.classNode.id}`}
                    node={filter.classNode}
                    onRemove={() => handleRemoveFilter(idx)}
                    readOnly={false}
                  />
                ) : (
                  <span key={`bool-${filter.prefix}`} className="command-palette__filter-pill">
                    <span className="command-palette__filter-pill-text">{filter.prefix}:{String(filter.value)}</span>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      icon="mdi mdi-close"
                      className="command-palette__filter-pill-remove"
                      onClick={() => handleRemoveFilter(idx)}
                      aria-label={`Remove ${filter.label} filter`}
                    />
                  </span>
                )
              ))}
            </div>
          )}
          {isLoading && <span className="command-palette__spinner" aria-label="Searching" />}
          <kbd className="command-palette__shortcut">Esc</kbd>
        </div>

        {/* Class suggestion popup when typing class: filter */}
        {isTypingClass && classPopupPosition && (
          <SuggestionPopup
            isOpen={true}
            query={classQuery}
            type="class"
            position={classPopupPosition}
            onSelect={(node) => handleClassSelect(node)}
            onClose={() => {
              // Remove the class: filter text when closing
              const beforeFilter = query.replace(/\S+:\S*$/, '').trim();
              setQuery(beforeFilter);
            }}
            onCreate={handleClassCreate}
          />
        )}

        {/* Hierarchical path preview — hidden when date is detected */}
        {pathInfo && !isTypingClass && !parsedDate && (
          <div className="command-palette__path-preview">
            <span className="command-palette__path-label">Will create:</span>
            <span className="command-palette__path-segments">
              {pathInfo.segments.map((segment, index) => (
                <span key={index}>
                  {index > 0 && <span className="command-palette__path-separator"><ChevronRightIcon size="xs" /></span>}
                  <span className={segment.exists ? 'command-palette__path-segment--existing' : 'command-palette__path-segment--new'}>
                    {segment.name}
                    {segment.exists && <span className="command-palette__path-indicator" title="Page exists"><CheckIcon size="xs" /></span>}
                  </span>
                </span>
              ))}
            </span>
          </div>
        )}

        <div className="command-palette__results">
          {isTypingClass ? (
            <div className="command-palette__hint">
              Type to search classes, press Enter to select
            </div>
          ) : (
            <>
              {query && groupedItems && allItems.length === 0 && !isLoading && !isTypingFilter && (
                <div className="command-palette__empty">No results found</div>
              )}

              {/* Boolean option dropdown */}
              {booleanOptionItems.length > 0 && (
                <div className="command-palette__section">
                  <div className="command-palette__section-header">Select Value</div>
                  {booleanOptionItems.map((item) => {
                    const globalIndex = indexMap.get(item)!;
                    return (
                      <button
                        key={item.label}
                        className={`command-palette__result ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                      >
                        <div className="command-palette__result-row">
                          <span className="command-palette__result-icon">
                            <Icon path={"mdi mdi-filter"} size={0.7} />
                          </span>
                          <span className="command-palette__result-content">
                            <span className="command-palette__result-name">{item.label}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Filter prefix suggestions */}
              {filterPrefixItems.length > 0 && (
                <div className="command-palette__section">
                  <div className="command-palette__section-header">Filters</div>
                  {filterPrefixItems.map((item) => {
                    const globalIndex = indexMap.get(item)!;
                    return (
                      <button
                        key={item.filterPrefix?.prefix}
                        className={`command-palette__result ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                      >
                        <div className="command-palette__result-row">
                          <span className="command-palette__result-icon">
                            <Icon path={"mdi mdi-filter"} size={0.7} />
                          </span>
                          <span className="command-palette__result-content">
                            <span className="command-palette__result-name">{item.filterPrefix?.prefix}:</span>
                            <span className="command-palette__result-description">{item.filterPrefix?.description}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {!query && appliedFilters.length === 0 && (
                <>
                  {browseRecentAccessed.length > 0 && (
                    <div className="command-palette__section">
                      <div className="command-palette__section-header">Recently Accessed</div>
                      {browseRecentAccessed.map((item) => {
                        const globalIndex = indexMap.get(item)!;
                        return (
                          <ResultItem
                            key={item.result?.node?.id}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}
                            pageClassId={pageClassId}
                          />
                        );
                      })}
                    </div>
                  )}
                  {browseRecentCreated.length > 0 && (
                    <div className="command-palette__section">
                      <div className="command-palette__section-header">Recently Created</div>
                      {browseRecentCreated.map((item) => {
                        const globalIndex = indexMap.get(item)!;
                        return (
                          <ResultItem
                            key={item.result?.node?.id}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}
                            pageClassId={pageClassId}
                          />
                        );
                      })}
                    </div>
                  )}
                  {browseRandom.length > 0 && (
                    <div className="command-palette__section">
                      <div className="command-palette__section-header command-palette__section-header--with-action">
                        <span>Random Pages</span>
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          icon="mdi mdi-refresh"
                          className="command-palette__refresh-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            refreshRandomPages();
                          }}
                          aria-label="Refresh random pages"
                          title="Refresh random pages"
                        />
                      </div>
                      {browseRandom.map((item) => {
                        const globalIndex = indexMap.get(item)!;
                        return (
                          <ResultItem
                            key={item.result?.node?.id}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}
                            pageClassId={pageClassId}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* Commands section */}
              {commandItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Commands</div>
              {commandItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                return (
                  <button
                    key={item.commandId}
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <div className="command-palette__result-row">
                      <span className="command-palette__result-icon">
                        {item.commandIcon === 'import' ? (
                          <ImportIcon size="sm" />
                        ) : item.commandIcon === 'maintenance' ? (
                          <Icon path={"mdi mdi-database-refresh"} size={0.7} />
                        ) : item.commandIcon === 'focus' ? (
                          <Icon path={"mdi mdi-brain"} size={0.7} />
                        ) : item.commandIcon === 'uuid' ? (
                          <Icon path={"mdi mdi-fingerprint"} size={0.7} />
                        ) : item.commandIcon === 'merge' ? (
                          <Icon path={"mdi mdi-merge"} size={0.7} />
                        ) : item.commandIcon === 'random' ? (
                          <Icon path={"mdi mdi-shuffle"} size={0.7} />
                        ) : item.commandIcon === 'minimap' ? (
                          <Icon path={"mdi mdi-map"} size={0.7} />
                        ) : item.commandIcon === 'graph' ? (
                          <Icon path={"mdi mdi-graph-outline"} size={0.7} />
                        ) : item.commandIcon === 'expand' ? (
                          <Icon path={"mdi mdi-arrow-expand-horizontal"} size={0.7} />
                        ) : item.commandIcon === 'presentation' ? (
                          <Icon path={"mdi mdi-presentation-play"} size={0.7} />
                        ) : item.commandIcon === 'share' ? (
                          <Icon path={"mdi mdi-share-variant-outline"} size={0.7} />
                        ) : item.commandIcon === 'lock' ? (
                          <Icon path={"mdi mdi-lock-outline"} size={0.7} />
                        ) : item.commandIcon === 'sync' ? (
                          <Icon path={"mdi mdi-sync"} size={0.7} />
                        ) : (
                          <Icon path={"mdi mdi-export"} size={0.7} />
                        )}
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
                      {item.commandDevOnly && (
                        <span className="command-palette__result-dev-badge">DEV</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

              {/* Date suggestion section */}
              {dateItems.length > 0 && (
                <div className="command-palette__section">
                  <div className="command-palette__section-header">Date Pages</div>
                  {dateItems.map((item) => {
                    const globalIndex = indexMap.get(item)!;
                    return (
                      <button
                        key="date-page"
                        className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                      >
                        <div className="command-palette__result-row">
                          <span className="command-palette__result-icon">
                            <CalendarIcon size="sm" />
                          </span>
                          <span className="command-palette__result-content">
                            <span className="command-palette__result-name">{item.label}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Pages section — hidden when date is detected */}
              {pageItems.length > 0 && !parsedDate && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Pages
              </div>
              {pageItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'show-more') {
                  return (
                    <button
                      key="show-more-pages"
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more pages</span>
                    </button>
                  );
                }
                if (item.type === 'add-page') {
                  return (
                    <button
                      key="add-page"
                      className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <div className="command-palette__result-row">
                        <span className="command-palette__result-icon">
                          <AddIcon size="sm" />
                        </span>
                        <span className="command-palette__result-content">
                          <span className="command-palette__result-name">{item.label}</span>
                        </span>
                      </div>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.node?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    allNodes={searchResults}
                    allClasses={allClasses}
                    pageClassId={pageClassId}
                    searchTerm={debouncedSearchTerm}
                  />
                );
              })}
            </div>
          )}

          {/* Blocks section */}
          {blockItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Blocks
              </div>
              {blockItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'show-more') {
                  return (
                    <button
                      key="show-more-blocks"
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more blocks</span>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.node?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    allNodes={searchResults}
                    allClasses={allClasses}
                    pageClassId={pageClassId}
                    searchTerm={debouncedSearchTerm}
                  />
                );
              })}
            </div>
          )}

          {/* Properties section */}
          {propertyItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Properties
              </div>
              {propertyItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'show-more') {
                  return (
                    <button
                      key="show-more-properties"
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more properties</span>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.property?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    searchTerm={debouncedSearchTerm}
                  />
                );
              })}
            </div>
          )}

          {/* Quick Add section */}
          {quickAddItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Quick Add</div>
              {quickAddItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                return (
                  <button
                    key="quick-add"
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <div className="command-palette__result-row">
                      <span className="command-palette__result-icon">
                        <AddIcon size="sm" />
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
                      <kbd className="command-palette__item-shortcut">⌘↵</kbd>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

            </>
          )}
        </div>

        <div className="command-palette__footer">
          <span className="command-palette__footer-hint">
            <kbd>↑</kbd><kbd>↓</kbd> to navigate
          </span>
          <span className="command-palette__footer-hint">
            <kbd>↵</kbd> to select
          </span>
          <span className="command-palette__footer-hint">
            <kbd>Ctrl</kbd>+<kbd>↵</kbd> open all results
          </span>
          <span className="command-palette__footer-hint">
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>

      {/* Duplicate page modal - shown when trying to create a page with an existing name */}
      <DuplicatePageModal
        isOpen={duplicateModal.isOpen}
        onClose={() => setDuplicateModal(prev => ({ ...prev, isOpen: false }))}
        pageName={duplicateModal.pageName}
        conflictingClasses={duplicateModal.conflictingClasses}
        originalClasses={duplicateModal.originalClasses}
        parentId={duplicateModal.parentId}
        onSuccess={(node) => {
          onClose();
          openNode(node.id);
        }}
      />

    </div>
    </>
  );
}
