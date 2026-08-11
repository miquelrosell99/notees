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
import { FilterPrefixPopup } from './FilterPrefixPopup';
import { SuggestionPopup, NodeRef } from '@/features/content';
import { DuplicatePageModal } from '@/features/layout/components/Modals';
import { Button } from '@/components/ui/Button';
import { Icon, AddIcon, CalendarIcon, CheckIcon, ChevronRightIcon } from '@/components/ui/icons';
import { useCommandRegistry } from '@/stores/commandRegistry';
import { useId } from 'react';

import type { CommandPaletteProps } from './CommandPalette.types';

export type { CommandPaletteProps } from './CommandPalette.types';

export function CommandPalette(props: CommandPaletteProps) {
  const {
    query,
    setQuery,
    appliedFilters,
    duplicateModal,
    setDuplicateModal,
    inputRef,
    containerRef,
    isTypingClass,
    isTypingFilter,
    isTypingColon,
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
    handleFilterPrefixSelect,
    handleFilterPrefixClose,
    handleClassCreate,
    handleBackdropClick,
    groupedItems,
    allClasses,
    allPages,
    searchResults,
    openNode,
    refreshRandomPages,
  } = useCommandPalette(props);

  const { onClose } = props;
  const getCommand = useCommandRegistry((s) => s.getCommand);

  const resolveCommandIcon = (commandId?: string): string => {
    if (!commandId) return 'mdi mdi-chevron-right';
    return getCommand(commandId)?.icon ?? 'mdi mdi-chevron-right';
  };

  const isDevCommand = (commandId?: string): boolean => {
    if (!commandId) return false;
    return getCommand(commandId)?.devOnly ?? false;
  };

  const baseId = useId();
  const resultListId = `${baseId}-results`;
  const getResultId = (index: number) => `${baseId}-result-${index}`;
  const isResultsExpanded = allItems.length > 0 || isTypingClass || isTypingColon;

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
    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click; Esc hint shown */}
    <div
      className={`command-palette__backdrop${isOpen ? '' : ' command-palette__backdrop--hidden'}`}
      onClick={handleBackdropClick}
    >
      <div ref={containerRef} className="command-palette">
        <div className="command-palette__input-container">
          <input
            ref={inputRef}
            type="text"
            className="command-palette__input"
            role="combobox"
            aria-label="Search commands and nodes"
            aria-expanded={isResultsExpanded}
            aria-controls={resultListId}
            aria-activedescendant={selectedIndex >= 0 ? getResultId(selectedIndex) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={appliedFilters.length > 0 ? "Search with active filters..." : "Search pages, blocks, properties... (type : to browse filters)"}
          />
          {/* Filter pills — classes + boolean filters */}
          {appliedFilters.length > 0 && (
            <div className="command-palette__class-pills">
              {appliedFilters.map((filter, idx) => (
                filter.type === 'class' ? (
                  <NodeRef
                    key={`class-${filter.classNode.uuid}`}
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
        {isTypingClass && (
          <SuggestionPopup
            isOpen={true}
            query={classQuery}
            type="class"
            anchorRef={inputRef}
            onSelect={(node) => handleClassSelect(node)}
            onClose={() => {
              // Remove the class: filter text when closing
              const beforeFilter = query.replace(/\S+:\S*$/, '').trim();
              setQuery(beforeFilter);
            }}
            onCreate={handleClassCreate}
          />
        )}

        {/* Filter prefix popup when typing a standalone colon */}
        {isTypingColon && (
          <FilterPrefixPopup
            anchorRef={inputRef}
            onSelect={handleFilterPrefixSelect}
            onClose={handleFilterPrefixClose}
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

        <div id={resultListId} className="command-palette__results" role="listbox" aria-label="Command palette results">
          {isTypingClass ? (
            <div className="command-palette__hint">
              Type to search classes, press Enter to select
            </div>
          ) : isTypingColon ? (
            <div className="command-palette__hint">
              Select a filter from the popup above
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
                        id={getResultId(globalIndex)}
                        role="option"
                        aria-selected={selectedIndex === globalIndex}
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
                        id={getResultId(globalIndex)}
                        role="option"
                        aria-selected={selectedIndex === globalIndex}
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
                            key={item.result?.node?.uuid}
                            id={getResultId(globalIndex)}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}

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
                            key={item.result?.node?.uuid}
                            id={getResultId(globalIndex)}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}

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
                            key={item.result?.node?.uuid}
                            id={getResultId(globalIndex)}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}

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
                    id={getResultId(globalIndex)}
                    role="option"
                    aria-selected={selectedIndex === globalIndex}
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <div className="command-palette__result-row">
                      <span className="command-palette__result-icon">
                        <Icon path={resolveCommandIcon(item.commandId)} size={0.7} />
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
                      {isDevCommand(item.commandId) && (
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
                        id={getResultId(globalIndex)}
                        role="option"
                        aria-selected={selectedIndex === globalIndex}
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

              {/* Pages section — regular results hidden when date is detected, but
                   the exact-name "Create page" option is still shown. */}
              {pageItems.length > 0 && (!parsedDate || pageItems.some(item => item.type === 'add-page')) && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                {parsedDate ? 'Exact Name' : 'Pages'}
              </div>
              {pageItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'show-more') {
                  if (parsedDate) return null;
                  return (
                    <button
                      key="show-more-pages"
                      id={getResultId(globalIndex)}
                      role="option"
                      aria-selected={selectedIndex === globalIndex}
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
                      id={getResultId(globalIndex)}
                      role="option"
                      aria-selected={selectedIndex === globalIndex}
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
                if (parsedDate) return null;
                return (
                  <ResultItem
                    key={item.result?.node?.uuid}
                    id={getResultId(globalIndex)}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    allNodes={searchResults}
                    allClasses={allClasses}
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
                      id={getResultId(globalIndex)}
                      role="option"
                      aria-selected={selectedIndex === globalIndex}
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more blocks</span>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.node?.uuid}
                    id={getResultId(globalIndex)}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    allNodes={searchResults}
                    allClasses={allClasses}
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
                      id={getResultId(globalIndex)}
                      role="option"
                      aria-selected={selectedIndex === globalIndex}
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more properties</span>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.property?.uuid}
                    id={getResultId(globalIndex)}
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
                    id={getResultId(globalIndex)}
                    role="option"
                    aria-selected={selectedIndex === globalIndex}
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
        parentUuid={duplicateModal.parentUuid}
        onSuccess={(node) => {
          onClose();
          openNode(node.uuid);
        }}
      />

    </div>
    </>
  );
}
