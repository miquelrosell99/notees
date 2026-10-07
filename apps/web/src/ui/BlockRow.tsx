/**
 * BlockRow — one block: bullet dot (a chevron toggle when the block has
 * children) + inline token content + nested children (recursive, indented).
 * Two display modes on the content div:
 *
 * - read mode: InlineTokens (marks/chips render read-only per SCHEMA.md).
 * - edit mode: a click swaps in BlockTextEditor (contentEditable prose
 *   editing, the outliner keyboard contract).
 *
 * A collapsed block (session-local display state from OutlinerContext) hides
 * its entire subtree — the children container is not rendered. The chevron
 * toggles collapse without entering edit mode (stopPropagation). In prose
 * view (`ignoreCollapse`) collapse state is ignored instead: every subtree
 * renders and no chevron mounts — the session set is left untouched, so
 * switching back to outline restores the hidden subtrees.
 *
 * Drag-and-drop: each row is sortable within its sibling group (dnd-kit,
 * vertical strategy) via the bullet/chevron grip handle — only inside a
 * workspace editing surface (the drag scope PageView provides; outside it
 * the grip stays inert). Drops resolve to `object.move` through the intent
 * model in block-dnd.ts; the drop indicator arrives through DropLineContext,
 * proximity-snapped to the nearest valid location of the drag session.
 * While its row drags, the source stays in place and renders muted (the
 * drag-source class) — the floating DragOverlay chip is the only preview,
 * so the layout never shifts under the pointer.
 *
 * Edit mode is also entered in response to a focus request from the
 * outliner gestures (Enter creates a sibling, Backspace-delete hands the
 * caret to the previous block). Data comes from the WorkspaceClient read
 * API; the client itself arrives through OutlinerContext.
 *
 * variant="title" is the page-header projection: the page node itself as a
 * bullet-less, chrome-less row (see the prop doc below) — the shared token
 * rendering and the full block editor, minus the outline chrome.
 */

import { useContext, useEffect, useMemo, useState, type MouseEvent } from "react";

import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { BlockTreeNode, EffectiveProperty, WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";

import { Icon } from "./Icon.js";
import { InlineTokens } from "./InlineTokens.js";
import { fullTitleFromClient } from "./dateDisplay.js";
import { AssetView } from "./AssetView.js";
import { BlockBacklinkPanel, BlockBacklinkToggle } from "./BlockBacklinks.js";
import { BlockTextEditor, type EditorCaret } from "./BlockTextEditor.js";
import { PropertiesSection, TagsRow } from "./components/MetadataSection.js";
import { PropertyIconButton } from "./components/PropertyIconButton.js";
import type { SelectionOption } from "./components/pickers/SelectionPropertyControl.js";
import { NodePills } from "./components/NodePills.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { openNodeLinkMenu } from "./components/NodeLinkContextMenu.js";
import { resolveAliasOpen } from "./components/aliasProperty.js";
import { nodeIcon } from "./iconFor.js";
import { EmbedView } from "./EmbedView.js";
import { EmbedCardView } from "./EmbedCardView.js";
import { QueryBlockView } from "./QueryBlockView.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { DropLineContext, WorkspaceDragScopeContext } from "./block-dnd.js";
import { useOutliner } from "./outliner-context.js";
import { Button } from "./components/ui/index.js";
import { InlineConfirmButton } from "./components/ui/InlineConfirmButton.js";
import { tableClassIdOf } from "./components/tableFamily.js";
import { addTableColumn, addTableRow, deleteTableColumn, deleteTableRow, tableColumnCount } from "./components/tableGrid.js";

/** Display positions (schema-level) a block row surfaces itself; the
 *  collapsed properties panel below omits them (no duplicated value read). */
const ROW_DISPLAY_POSITIONS = ["bullet", "inline"] as const;

interface BlockRowProps {
  tree: BlockTreeNode;
  client: WorkspaceClient | WorkerClient;
  resolveName?: ((nodeId: string) => string | null) | undefined;
  /**
   * Read-only projection: renders the same
   * row chrome but disables every mutation gesture — no drag, no edit on
   * click, no context menu; clicking the content opens the node instead.
   * Used by the Child pages tree and the Class View's "Extended by" list.
   */
  readOnly?: boolean | undefined;
  /**
   * Prose-view transform: collapse state is ignored — collapsed ids still
   * render their full subtree and no chevron mounts (nothing left to expand
   * or collapse). Threaded down the recursion by the view that sets it.
   */
  ignoreCollapse?: boolean | undefined;
  /**
   * Table-row projection: set by the table container's grid branch
   * on each of its row children. The row root becomes a CSS-subgrid row and
   * renders ONLY its cell children (each an ordinary editable block) — no
   * row chrome of its own.
   */
  tableRow?: boolean | undefined;
  /**
   * Title projection (the page header): the page node itself as a
   * bullet-less, chrome-less row — full editor powers on the page's own
   * content (inline tokens render and edit exactly as in body blocks), but
   * no grip/drag, no collapse, no property/backlink/tags chrome, no
   * children, and no row context menu (the header owns the right-click
   * page menu). The content wrapper carries `nt-title-content`, NOT
   * `nt-block-content`, so body-row selectors never match the header row.
   * Block-scale widget tokens (embeds, queries, whiteboards, assets) render
   * nothing here — they live in the body surface.
   */
  variant?: "block" | "title" | undefined;
}

export function BlockRow({ tree, client, resolveName, readOnly = false, ignoreCollapse = false, tableRow = false, variant = "block" }: BlockRowProps) {
  const [gripMenu, setGripMenu] = useState<{ x: number; y: number } | null>(null);
  const { node, children } = tree;
  const isTitle = variant === "title";
  const {
    client: outlinerClient,
    rootId,
    openNode,
    openInSidebar,
    focusRequest,
    acknowledgeFocus,
    collapsed,
    toggleCollapse,
    selectionEnabled,
    selection,
    selectionAnchor,
    setSelectionAnchor,
    replaceSelection,
    rangeBetween,
    toggleSelected,
    clearSelection,
    consumeDragClick,
    focusMode,
  } = useOutliner();
  const dropLine = useContext(DropLineContext);
  const [editing, setEditing] = useState(false);
  const [caret, setCaret] = useState<EditorCaret>("end");
  // Right-gutter backlink toggle (SCHEMA.md:117): the badge reads the
  // materialized count (cheap stored number, renders unconditionally at 0
  // hides the toggle); the linked-references query stays lazy until the
  // first expand.
  const backlinkCount = client.getBacklinkCount(node.id);
  const [backlinksExpanded, setBacklinksExpanded] = useState(false);
  const isCollapsed = !ignoreCollapse && collapsed.has(node.id);
  // Sortable within this row's sibling group; the bullet/chevron area is the
  // drag handle (whole-row drag would fight text editing). A small activation
  // distance keeps plain clicks untouched. The title row is never sortable
  // (and renders outside the body's drag scope) and rows outside a workspace
  // editing surface aren't either — the disabled flag keeps the hook inert,
  // the same pattern read-only projections use.
  const dragScope = useContext(WorkspaceDragScopeContext);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
    disabled: readOnly || isTitle || !dragScope,
  });

  useEffect(() => {
    if (focusRequest === null || focusRequest.id !== node.id) return;
    acknowledgeFocus();
    if (readOnly) return;
    setCaret(focusRequest.caret);
    setEditing(true);
  }, [focusRequest, node.id, acknowledgeFocus, readOnly]);

  const enterEdit = (event: MouseEvent<HTMLDivElement>) => {
    if (editing) return;
    // A trailing click right after a selection drag must not enter edit mode.
    if (consumeDragClick()) return;
    if (readOnly) {
      // Read-only projection: clicking the row opens the node.
      openNode(node.id);
      return;
    }
    // The title row never joins the block multi-selection (it lives outside
    // the selection surface); a click there always edits.
    if (!isTitle) {
      // Block multi-selection: shift+click extends the range from the
      // anchor, Ctrl/Cmd+click toggles one row — neither enters edit mode.
      if (selectionEnabled && event.shiftKey) {
        const anchor = selectionAnchor ?? node.id;
        setSelectionAnchor(anchor);
        replaceSelection(new Set(rangeBetween(anchor, node.id)), anchor);
        return;
      }
      if (selectionEnabled && (event.ctrlKey || event.metaKey)) {
        if (selectionAnchor === null) setSelectionAnchor(node.id);
        toggleSelected(node.id);
        return;
      }
      // A plain click with a live selection resets it, then edits as usual.
      if (selection.size > 0) clearSelection();
    }
    setCaret({ x: event.clientX, y: event.clientY });
    setEditing(true);
  };

  // effectiveClassIcons() is the narrow revision-cached read (stable reference
  // until the store actually changes), so keying on it keeps this memo valid
  // across class-icon changes without re-running on every row re-map; the
  // pre-fix [node, node.classIds] key re-ran a full listClasses query per row
  // per refresh. Chain-resolved (#1 follow-up): a class parent with the icon
  // now reaches the row.
  const classIcons = outlinerClient.effectiveClassIcons();
  const gripIcon = useMemo(() => nodeIcon(node, classIcons), [node, classIcons]);

  const dropClass =
    dropLine !== null && dropLine.targetId === node.id ? ` nt-drop-${dropLine.intent}` : "";
  const selectedClass = selection.has(node.id) ? " nt-block--selected" : "";
  // The dragged row stays in place (no drag transform) and reads muted; the
  // floating name chip is the only preview.
  const dragSourceClass = isDragging ? " nt-block--drag-source" : "";

  // A block carrying the table class renders its children (rows)
  // as a CSS grid instead of the outline list. The class says what-it-is
  // (the whiteboard pattern) — the same branch covers read-only projections.
  const isTableContainer = !tableRow && node.classIds.includes(tableClassIdOf(outlinerClient));

  // Table-row projection: the root is the subgrid row; only the cell blocks
  // render, each through the ordinary BlockRow path (a cell IS a block — the
  // existing editor machinery applies). All hooks ran above, so the early
  // return is safe.
  if (tableRow) {
    return (
      <div
        className={`nt-blocktable-row${dragSourceClass}`}
        ref={setNodeRef}
        data-block-id={node.id}
        style={{
          transform: isDragging ? undefined : CSS.Transform.toString(transform),
          transition: isDragging ? undefined : transition,
        }}
      >
        <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
          {children.map((child) => (
            <BlockRow
              key={child.node.id}
              tree={child}
              client={client}
              resolveName={resolveName}
              readOnly={readOnly}
              ignoreCollapse={ignoreCollapse}
            />
          ))}
        </SortableContext>
      </div>
    );
  }

  // Select-typed or boolean properties whose SCHEMA carries a
  // "bullet"/"inline" display position ride the block row as icon buttons
  // (the Logseq-DB "beginning of the block" behavior; the buttons and the
  // boolean glyphs are the design) — one button per property, in
  // binding-sequence order (the groups sort by sequence across both
  // sources). Valued properties group from the effective rows (row.display
  // is schema-sourced); a bound-but-empty binding still mounts the button —
  // the unset affordance is how a fresh task gets its status. The properties
  // panel below omits these positions so the value never reads twice. Reads
  // follow the PropertiesSection pattern: plain render reads over the
  // client, refreshed by the surrounding view's client.subscribe re-render.
  // The title row renders none of this chrome — skip the whole read.
  const bulletDisplayGroups: Array<{
    propertySchemaId: string;
    label: string;
    options: SelectionOption[];
    rows: EffectiveProperty[];
    multi: boolean;
    required: boolean;
    boolean: boolean;
    display: "bullet" | "inline";
    sequence: number;
  }> = [];
  const inlineDisplayGroups: Array<{
    propertySchemaId: string;
    label: string;
    options: SelectionOption[];
    rows: EffectiveProperty[];
    multi: boolean;
    required: boolean;
    boolean: boolean;
    display: "bullet" | "inline";
    sequence: number;
  }> = [];
  if (!isTitle) {
    const effectiveRows = client.getEffectiveProperties(node.id);
    const schemasById = new Map(
      client.listPropertySchemas().map((schema) => [schema.id, schema]),
    );
    const selectDisplayGroups: typeof bulletDisplayGroups = [];
    {
      const seenGroups = new Set<string>();
      for (const row of effectiveRows) {
        const display = row.display;
        if (display !== "bullet" && display !== "inline") continue;
        const type = row.schema?.type;
        if (type !== "select" && type !== "multi_select" && type !== "boolean") continue;
        if (seenGroups.has(row.propertySchemaId)) continue;
        seenGroups.add(row.propertySchemaId);
        const groupRows = effectiveRows.filter(
          (r) => r.propertySchemaId === row.propertySchemaId,
        );
        selectDisplayGroups.push({
          propertySchemaId: row.propertySchemaId,
          label: row.schema?.name ?? row.propertySchemaId,
          options: schemasById.get(row.propertySchemaId)?.options ?? [],
          rows: groupRows,
          multi: row.schema?.multi ?? type === "multi_select",
          required: groupRows.some((r) => r.required === true),
          boolean: type === "boolean",
          display,
          sequence: row.sequence ?? Number.MAX_SAFE_INTEGER,
        });
      }
      // Bound-but-empty bindings with a row display position: no effective row
      // exists yet (no value, no default), but the button is how the value
      // gets set — the panel's empty-bindings pass, same gate: the render
      // contracts are property-level — display/hide-when-empty read from the
      // schema row; options-bearing selects only, booleans synthesize their
      // own; hide-when-empty stays hidden).
      for (const classId of node.classIds) {
        for (const binding of client.getClassBindings(classId)) {
          if (binding.type !== "select" && binding.type !== "multi_select" && binding.type !== "boolean") continue;
          if (seenGroups.has(binding.propertySchemaId)) continue;
          const schemaRow = schemasById.get(binding.propertySchemaId);
          const display = schemaRow?.display ?? null;
          if (display !== "bullet" && display !== "inline") continue;
          if (schemaRow?.hideWhenEmpty === true) continue;
          const isBoolean = binding.type === "boolean";
          const options = schemaRow?.options ?? [];
          if (!isBoolean && options.length === 0) continue;
          seenGroups.add(binding.propertySchemaId);
          selectDisplayGroups.push({
            propertySchemaId: binding.propertySchemaId,
            label: binding.name,
            options,
            rows: [],
            multi: binding.multi,
            required: binding.required === true,
            boolean: isBoolean,
            display,
            sequence: binding.sequence,
          });
        }
      }
      selectDisplayGroups.sort((a, b) => a.sequence - b.sequence);
    }
    for (const group of selectDisplayGroups) {
      if (group.display === "bullet") bulletDisplayGroups.push(group);
      else inlineDisplayGroups.push(group);
    }
  }

  // The content read both display modes share: inline tokens read-only, or
  // the full block editor swapped in on click. The title projection
  // suppresses the block-scale widget renderers (embeds, queries,
  // whiteboards, assets) — those surfaces render in the body, never in the
  // header.
  const suppressWidget = isTitle ? () => null : undefined;
  const tokens = (
    <InlineTokens
      tokens={node.contentAst}
      resolveName={resolveName}
      resolveFullTitle={(id) => fullTitleFromClient(client, id)}
      resolveVerb={(schemaId) =>
        outlinerClient.listPropertySchemas().find((schema) => schema.id === schemaId)?.name ?? null
      }
      // Issue #7 — a mention whose target is an alias page opens the
      // MAIN page (the alias view stays reachable by opening the
      // alias as a node: search, child rows, deep links).
      onOpenNode={(targetId) => openNode(resolveAliasOpen(outlinerClient, targetId))}
      onMentionMenu={(info) => openNodeLinkMenu({ blockId: node.id, ...info })}
      resolveColor={(id) => {
        const target = outlinerClient.getNode(id);
        return target === undefined ? null : outlinerClient.effectiveNodeColor(target);
      }}
      renderEmbed={
        suppressWidget ??
        ((id, _token, index) => <EmbedView nodeId={id} hostId={node.id} tokenIndex={index} />)
      }
      renderEmbedCard={
        suppressWidget ??
        ((id, view, _token, index) => (
          <EmbedCardView nodeId={id} view={view} hostId={node.id} tokenIndex={index} />
        ))
      }
      renderQuery={
        suppressWidget ??
        ((token, index) => (
          <QueryBlockView
            client={outlinerClient}
            ownerId={node.id}
            tokenIndex={index}
            queryAst={(token as { queryAst?: unknown }).queryAst}
            view={(token as { view?: unknown }).view}
            rootId={rootId}
            onOpenNode={openNode}
          />
        ))
      }
      renderWhiteboard={
        suppressWidget ??
        ((_token, index) => (
          <WhiteboardCanvas
            client={outlinerClient}
            hostId={node.id}
            tokenIndex={index}
            embedded
          />
        ))
      }
      renderAsset={
        suppressWidget ??
        ((token, _index, fullBleed) => {
          const assetId = (token as { assetId?: unknown }).assetId;
          return typeof assetId === "string" ? (
            <AssetView client={client} assetId={assetId} fullBleed={fullBleed} />
          ) : null;
        })
      }
    />
  );

  // Title projection: the page header's editable title — bullet-less and
  // chrome-less by definition, only the content column renders. The
  // heading role keeps the page-title landmark; the wrapper class is
  // title-specific (NOT .nt-block-content) so body-row selectors never
  // match the header row. All hooks ran above, so the early return is safe.
  if (isTitle) {
    return (
      <div
        className="nt-block nt-block--title nt-page-title"
        role="heading"
        aria-level={1}
        data-block-id={node.id}
      >
        <div className="nt-block-row">
          <div className="nt-title-content" onClick={enterEdit}>
            {editing ? (
              <BlockTextEditor
                node={node}
                caret={caret}
                onExitEdit={() => setEditing(false)}
                variant="title"
              />
            ) : (
              tokens
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`nt-block${readOnly ? " nt-block--readonly" : ""}${editing ? " nt-block--editing" : ""}${dropClass}${selectedClass}${dragSourceClass}`}
      ref={setNodeRef}
      data-block-id={node.id}
      style={{
        transform: isDragging ? undefined : CSS.Transform.toString(transform),
        transition: isDragging ? undefined : transition,
      }}
    >
      <div className="nt-block-row">
        <span
          className="nt-block-grip"
          title="Drag to move"
          {...attributes}
          {...listeners}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (readOnly) return;
            setGripMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {children.length > 0 && !ignoreCollapse && (
            <button
              type="button"
              className="nt-block-chevron"
              aria-label={isCollapsed ? "Expand block" : "Collapse block"}
              aria-expanded={!isCollapsed}
              onClick={(event) => {
                // The chevron is a display toggle, not content editing.
                event.stopPropagation();
                toggleCollapse(node.id);
              }}
            >
              {isCollapsed ? "\u25B8" : "\u25BE"}
            </button>
          )}
          <span
            className={`nt-bullet${isCollapsed && children.length > 0 ? " nt-bullet--collapsed" : ""}`}
            title="Zoom in (Shift+click: open in sidebar)"
            onClick={(event) => {
              event.stopPropagation();
              // Shift+click peeks the block in the right sidebar; a plain
              // click zooms to the focused block view.
              if (event.shiftKey) {
                openInSidebar(node.id);
              } else {
                openNode(node.id);
              }
            }}
          >
            {children.length > 0 && <span className="nt-bullet-ring" aria-hidden="true" />}
            {!focusMode && gripIcon !== null ? (
              <span className="nt-bullet-icon">
                <Icon path={gripIcon} size={0.8} />
              </span>
            ) : (
              <span className="nt-bullet-dot" aria-hidden="true" />
            )}
          </span>
        </span>
        {/* The value-display buttons: the bullet group
            hugs the bullet element, the inline group hugs the content.
            Siblings of the grip and content — never inside .nt-block-content
            (the contentEditable DOM must stay untouched). In read-only
            projections the icons render but open nothing. Focus mode (#12)
            hides both groups — properties are exactly what it suppresses. */}
        {!focusMode && bulletDisplayGroups.length > 0 && (
          <span className="nt-block-bullet-props">
            {bulletDisplayGroups.map((group) => (
              <PropertyIconButton
                key={group.propertySchemaId}
                client={client}
                nodeId={node.id}
                propertySchemaId={group.propertySchemaId}
                label={group.label}
                options={group.options}
                rows={group.rows}
                multi={group.multi}
                required={group.required}
                boolean={group.boolean}
                disabled={readOnly}
              />
            ))}
          </span>
        )}
        {!focusMode && inlineDisplayGroups.length > 0 && (
          <span className="nt-block-inline-props">
            {inlineDisplayGroups.map((group) => (
              <PropertyIconButton
                key={group.propertySchemaId}
                client={client}
                nodeId={node.id}
                propertySchemaId={group.propertySchemaId}
                label={group.label}
                options={group.options}
                rows={group.rows}
                multi={group.multi}
                required={group.required}
                boolean={group.boolean}
                disabled={readOnly}
              />
            ))}
          </span>
        )}
        <div className="nt-block-content" onClick={enterEdit}>
          {editing ? (
            <BlockTextEditor node={node} caret={caret} onExitEdit={() => setEditing(false)} />
          ) : (
            tokens
          )}
        </div>
        {/* Right end of the row: the classes column (first pill + "+N"
            overflow popup, drag to reorder) and the backlink gutter toggle
            (SCHEMA.md:117 — the count badge rides the materialized
            node_stats number). The gutter is reference material, so it shows
            in read-only projections too. */}
        {!focusMode && (backlinkCount > 0 || !readOnly) && (
          <div className="nt-block-row-end">
            {!readOnly && (
              <div className="nt-block-classes">
                <NodePills
                  client={client}
                  nodeId={node.id}
                  classIds={node.classIds}
                  onOpenPage={openNode}
                  overflow
                  iconOnlyAdd
                />
              </div>
            )}
            {backlinkCount > 0 && !focusMode && (
              <BlockBacklinkToggle
                count={backlinkCount}
                expanded={backlinksExpanded}
                onToggle={() => setBacklinksExpanded((v) => !v)}
              />
            )}
          </div>
        )}
      </div>
      {/* Expanded block backlinks: the linked-references system query scoped
          to this block, lazy per the section contract (query on first
          toggle, cached until an invalidating notification). Hidden in
          focus mode (#12) with the gutter toggle. */}
      {backlinkCount > 0 && !focusMode && (
        <BlockBacklinkPanel nodeId={node.id} expanded={backlinksExpanded} client={client} />
      )}
      {/* Tags: dedicated row below the block row, only when set (assignment
          rides the `#` trigger). Focus mode (#12) hides them with the rest
          of the block metadata. */}
      {!readOnly && !focusMode && node.tagIds.length > 0 && (
        <div className="nt-block-tags">
          <TagsRow client={client} nodeId={node.id} tagIds={node.tagIds} onOpenPage={openNode} />
        </div>
      )}
      {/* Properties: the same collapsed "Properties N" section the page view
          uses; hidden entirely when the block carries no properties. Rows
          whose schema display rides the block row (bullet/inline)
          are omitted — the button above already surfaces the value. Focus
          mode (#12) hides the whole section. */}
      {!readOnly && !focusMode && (
        <PropertiesSection
          client={client}
          nodeId={node.id}
          onOpenPage={openNode}
          hideWhenEmpty
          omitDisplayPositions={ROW_DISPLAY_POSITIONS}
        />
      )}
      {/* Block-level metadata now lives around the row: classes ride the
          right-hand column, tags the dedicated row below, properties the
          collapsed "Properties N" section (all above). */}
      <NodeContextMenu
        state={gripMenu === null ? null : { ...gripMenu, node, isPage: false }}
        client={outlinerClient}
        onClose={() => setGripMenu(null)}
        onOpenNode={openNode}
      />
      {/* A table container's children are the grid rows. The
          column template comes from the FIRST row's cell count; ragged rows
          show blanks (fewer cells) or spill into implicit tracks (more).
          The + Row / + Column hover affordance rides the container (hidden
          in read-only projections). */}
      {isTableContainer ? (
        <>
          {!readOnly && (
            <div className="nt-blocktable-toolbar" role="toolbar" aria-label="Table">
              <Button
                size="xs"
                variant="ghost"
                icon="mdiTableRowPlusAfter"
                aria-label="Add row"
                onClick={() => {
                  void addTableRow(client, node.id, tableColumnCount(children));
                }}
              >
                Row
              </Button>
              <Button
                size="xs"
                variant="ghost"
                icon="mdiTableColumnPlusAfter"
                aria-label="Add column"
                onClick={() => {
                  void addTableColumn(client, children);
                }}
              >
                Column
              </Button>
              {/* − Row / − Column: the inline-confirm pattern (a delete is
                  destructive; the confirm/check row replaces the trigger).
                  The last row / right-most column are the targets — the
                  append gestures' mirror. */}
              <InlineConfirmButton
                size="sm"
                variant="ghost"
                title="Delete last row"
                confirmTitle="Confirm delete row"
                cancelTitle="Cancel"
                disabled={children.length === 0}
                onConfirm={() => {
                  const last = children[children.length - 1];
                  if (last !== undefined) void deleteTableRow(client, last);
                }}
              >
                − Row
              </InlineConfirmButton>
              <InlineConfirmButton
                size="sm"
                variant="ghost"
                title="Delete last column"
                confirmTitle="Confirm delete column"
                cancelTitle="Cancel"
                disabled={tableColumnCount(children) === 0}
                onConfirm={() => {
                  void deleteTableColumn(client, children, tableColumnCount(children) - 1);
                }}
              >
                − Column
              </InlineConfirmButton>
            </div>
          )}
          {children.length > 0 && !isCollapsed && (
            <div
              className="nt-blocktable"
              style={{
                gridTemplateColumns: `repeat(${tableColumnCount(children)}, minmax(0, 1fr))`,
              }}
            >
              <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
                {children.map((child) => (
                  <BlockRow
                    key={child.node.id}
                    tree={child}
                    client={client}
                    resolveName={resolveName}
                    readOnly={readOnly}
                    ignoreCollapse={ignoreCollapse}
                    tableRow
                  />
                ))}
              </SortableContext>
            </div>
          )}
        </>
      ) : (
      <>
        {children.length > 0 && !isCollapsed && (
          <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
            <div className="nt-block-children">
              {children.map((child) => (
                <BlockRow
                  key={child.node.id}
                  tree={child}
                  client={client}
                  resolveName={resolveName}
                  readOnly={readOnly}
                  ignoreCollapse={ignoreCollapse}
                />
              ))}
            </div>
          </SortableContext>
        )}
      </>
      )}
    </div>
  );
}
