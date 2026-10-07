/**
 * LinkEditModal — modal for editing inline NODE links.
 *
 * Owner ruling: the modal is for node links ONLY. It edits two node-ish
 * kinds (node / block) plus the verb kind: the target section hosts ONE kit
 * SelectTrigger whose anchored NodeSelector dropdown (portaled below the
 * trigger) picks the target — click opens the dropdown, a pick replaces the
 * selection in place (Page = pages, Block = blocks) — and the Display Label
 * field sets an optional per-link `displayText` override (empty = resolve
 * the target's name). Verb mode edits a typed_link mark: the verb field
 * live-matches the workspace's property schemas (an exact name hit saves
 * bound to the existing schema; an unknown name offers "Create property
 * '…' and bind") plus the optional locator. External links are NOT edited
 * here: they navigate in read mode, are authored directly by the slash
 * "Add URL" command (which composes the external_link token at the caret),
 * and carry labels through markdown [label](url) / raw-URL pasting. When
 * the mention's target id resolves to no node, the target section offers
 * the "create page with this id" heal (the caller-id create path — the
 * mention heals in place, no retarget write). Enter inside the modal saves
 * (capture phase, so it beats button activation); the anchored picker owns
 * Enter/Escape for its rows. Esc/backdrop close ride the kit Modal's
 * overlay stack.
 *
 * The shell composes the kit primitives (Modal for the backdrop/card/
 * header/footer + Esc handling, SelectionButton for the mode toggle,
 * Button for every action) — all chrome comes from components/ui/, and
 * LinkEditModal.css carries only the namespaced `link-edit-modal__*`
 * field styles.
 *
 * LinkEditModalHost (below) renders the modal at the page level and exposes
 * an opener through context: the block editor's node-link context menu and
 * typed-link verb flow land here.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { uuidv7 } from "uuidv7";

import { rendersAsInlineBlock } from "@notees/domain";

import { withCandidateSpans } from "@/editor/capture.js";
import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameFromClient } from "../dateDisplay.js";
import { NodeSelector } from "../components/pickers/NodeSelector.js";
import { Button, Modal, SelectTrigger, SelectionButton } from "../components/ui/index.js";
import { notificationStore } from "../components/ui/notificationStore.js";
import "./LinkEditModal.css";

export type LinkMode = "node" | "block" | "verb";

export interface LinkEditResult {
  /** Link mode — node, block, or verb. */
  mode: LinkMode;
  /**
   * Node/block modes: the newly picked target id — null when the user did
   * not pick (a label-only edit of the current link).
   */
  nodeId?: string | null;
  /**
   * Verb mode (PG1): the mark's new verb — a free string or the bound
   * `{ propertySchemaId }` shape the create-and-bind row produces.
   */
  verb?: string | { propertySchemaId: string } | undefined;
  /** Verb mode: the mark's locator (empty string clears it). */
  locator?: string | undefined;
  /** Custom label (null to clear). */
  label: string | null;
}

const LINK_MODE_OPTIONS = [
  { value: "node", icon: "mdi-link-variant", label: "Page" },
  { value: "block", icon: "mdi-text-box", label: "Block" },
];

/** Minimal schema shape the verb row matches against (PG1). */
interface VerbSchemaOption {
  id: string;
  name: string;
}

interface LinkEditModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Workspace client driving the anchored target picker. */
  client: WorkspaceClient | WorkerClient;
  /** Current link target (node/block modes) — pre-fills the destination line. */
  currentNodeId?: string | null | undefined;
  /** Node id the picker must not offer (the block being edited). */
  excludeNodeId?: string | undefined;
  /** Current custom label (from the AST token's text). */
  currentLabel?: string | null;
  /** Verb mode (PG1): the mark's current verb (schema name for bound verbs). */
  currentVerb?: string | undefined;
  /** Verb mode (PG1): the mark's current locator. */
  currentLocator?: string | undefined;
  /** Modal title — defaults to "Edit Link". */
  title?: string;
  /** Override the initial link mode (default: node). */
  initialMode?: LinkMode;
  /** Called when saving changes. */
  onSave: (result: LinkEditResult) => void;
  /** Called when closing without saving. */
  onClose: () => void;
}

export function LinkEditModal({
  isOpen,
  client,
  currentNodeId,
  excludeNodeId,
  currentLabel,
  currentVerb,
  currentLocator,
  title = "Edit Link",
  initialMode = "node",
  onSave,
  onClose,
}: LinkEditModalProps) {
  const [linkMode, setLinkMode] = useState<LinkMode>(initialMode);
  const [label, setLabel] = useState(currentLabel ?? "");
  /** Verb mode (PG1): the mark's verb + optional locator. */
  const [verb, setVerb] = useState("");
  const [verbLocator, setVerbLocator] = useState("");
  const [verbPending, setVerbPending] = useState(false);
  const [verbError, setVerbError] = useState<string | null>(null);
  /** Newly picked destination (node/block modes); null = keep the current target. */
  const [pickedNode, setPickedNode] = useState<ClientNode | null>(null);
  /** The anchored target picker dropdown (node/block modes). */
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const targetTriggerRef = useRef<HTMLDivElement>(null);
  const verbInputRef = useRef<HTMLInputElement>(null);

  /**
   * Broken-link heal: the mention's target id resolves to no node —
   * offer creating the page AT that id (the caller-id create path), so the
   * mention heals in place instead of being retargeted.
   */
  const brokenTargetId =
    currentNodeId != null &&
    currentNodeId !== "" &&
    client.getNode(currentNodeId) === undefined
      ? currentNodeId
      : null;
  const createBrokenTarget = () => {
    if (brokenTargetId === null) return;
    void client
      .createObject({ id: brokenTargetId, presentAsMain: true })
      .catch((error: unknown) => {
        console.warn("[link-edit] create-with-uuid failed:", error);
        notificationStore.error("Couldn't create the page", "The id may already be taken.");
      });
    // The modal closes; the mention token keeps its targetNodeId and now
    // resolves — no retarget write needed.
    onClose();
  };

  useEffect(() => {
    if (isOpen) {
      setLinkMode(initialMode);
      setLabel(currentLabel ?? "");
      setPickedNode(null);
      setTargetPickerOpen(false);
      setVerb(currentVerb ?? "");
      setVerbLocator(currentLocator ?? "");
      setVerbPending(false);
      setVerbError(null);
    }
  }, [isOpen, currentLabel, initialMode, currentVerb, currentLocator]);

  useEffect(() => {
    if (isOpen && linkMode === "verb") {
      verbInputRef.current?.focus();
    }
  }, [isOpen, linkMode]);

  // PG1 schema-at-capture: live-match the verb field against the workspace's
  // property schemas — an exact (case-insensitive) name hit binds to the
  // existing schema; a miss offers "Create property '…' and bind" (the same
  // row shape as the broken-link create flow below).
  const verbTrimmed = verb.trim();
  const verbMatch =
    verbTrimmed === ""
      ? null
      : (client
          .listPropertySchemas()
          .find((schema) => schema.name.toLowerCase() === verbTrimmed.toLowerCase()) ?? null);

  const runCreateAndBind = () => {
    if (verbTrimmed === "" || verbMatch !== null || verbPending) return;
    setVerbError(null);
    setVerbPending(true);
    void client
      .createPropertySchema({
        name: verbTrimmed,
        type: "object",
        multi: true,
        targetClassFilter: [],
      })
      .then((schemaId) => {
        onSave({ mode: "verb", verb: { propertySchemaId: schemaId }, locator: verbLocator.trim(), label: null });
        onClose();
      })
      .catch((error: unknown) => {
        setVerbError(error instanceof Error ? error.message : String(error));
        setVerbPending(false);
      });
  };

  const handleSave = useCallback(() => {
    if (linkMode === "verb") {
      if (verbTrimmed === "") {
        onClose();
        return;
      }
      // An exact schema-name hit binds (the note under the field promises
      // it); a miss saves the free-text verb (the create-and-bind row is the
      // explicit bound path for new names).
      onSave({
        mode: "verb",
        verb: verbMatch !== null ? { propertySchemaId: verbMatch.id } : verbTrimmed,
        locator: verbLocator.trim(),
        label: null,
      });
      return;
    }
    const trimmedLabel = label.trim();
    onSave({ mode: linkMode, nodeId: pickedNode?.id ?? null, label: trimmedLabel || null });
  }, [linkMode, label, pickedNode, verbTrimmed, verbLocator, verbMatch, onSave, onClose]);

  // Escape + backdrop dismissal ride the kit Modal (the overlay stack).
  // Enter anywhere inside the modal = save (capture phase to beat button
  // activation).
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement;
      if (!target.closest(".link-edit-modal")) return;
      // The anchored node picker owns Enter (pick row) and Escape (close) —
      // it portals to the body, outside the modal subtree, but the guard
      // stays for either mounting; the broken-link heal row and the verb
      // create-and-bind row's buttons activate normally (click), they must
      // not fall into the save path.
      if (target.closest(".node-selector") || target.closest(".link-edit-modal__broken") || target.closest(".link-edit-modal__verb-bind")) return;

      e.preventDefault();
      e.stopPropagation();
      handleSave();
    };

    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [isOpen, handleSave]);

  if (!isOpen) return null;

  const footer = (
    <div className="link-edit-modal__footer">
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" onClick={handleSave}>
        Save
      </Button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      className="link-edit-modal"
      footer={footer}
    >
      <div className="link-edit-modal__body" data-editor-companion>
        {/* Mode toggle — verb targets arrive from the typed-link mark
            editor and stay in verb mode (no mode switch). */}
        {linkMode !== "verb" && (
          <div className="link-edit-modal__section link-edit-modal__mode-section">
            <SelectionButton
              options={LINK_MODE_OPTIONS}
              value={linkMode}
              onChange={(mode) => setLinkMode(mode as LinkMode)}
              orientation="horizontal"
              size="sm"
            />
          </div>
        )}

            {/* Verb section (PG1): edit a typed-link mark's verb with the
                same schema binding + create-and-bind row as the capture
                popover. */}
            {linkMode === "verb" ? (
              <div className="link-edit-modal__section">
                <label className="link-edit-modal__label" htmlFor="link-verb-input">
                  Verb
                </label>
                <input
                  id="link-verb-input"
                  ref={verbInputRef}
                  type="text"
                  className="link-edit-modal__input"
                  placeholder="cites, contradicts…"
                  aria-label="Verb"
                  value={verb}
                  onChange={(e) => {
                    setVerb(e.target.value);
                    setVerbError(null);
                  }}
                  autoComplete="off"
                />
                <label className="link-edit-modal__label" htmlFor="link-verb-locator-input">
                  Locator (optional)
                </label>
                <input
                  id="link-verb-locator-input"
                  type="text"
                  className="link-edit-modal__input"
                  placeholder="p. 12"
                  aria-label="Locator"
                  value={verbLocator}
                  onChange={(e) => setVerbLocator(e.target.value)}
                  autoComplete="off"
                />
                {(verbMatch !== null || verbTrimmed !== "") && (
                  <div className="link-edit-modal__verb-bind">
                    {verbMatch !== null ? (
                      <span className="link-edit-modal__verb-bind-note">
                        Saves bound to the "{verbMatch.name}" property.
                      </span>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={verbPending}
                        onClick={runCreateAndBind}
                      >
                        {verbPending
                          ? `Creating property "${verbTrimmed}"…`
                          : `Create property "${verbTrimmed}" and bind`}
                      </Button>
                    )}
                  </div>
                )}
                {verbError !== null && (
                  <div className="link-edit-modal__verb-bind-error" role="alert">
                    {verbError}
                  </div>
                )}
                <span className="link-edit-modal__hint">
                  Save keeps a free-text verb unless the property bind row is used.
                </span>
              </div>
            ) : (
            <>
            {/* Link target section */}
            <div className="link-edit-modal__section">
              <label className="link-edit-modal__label">
                {linkMode === "node" ? "Page" : "Block"}
              </label>
                <>
                  {/* ONE target control: the kit SelectTrigger shows the
                      current selection; clicking it anchors the picker
                      dropdown (portaled), and a pick replaces the selection
                      in place. */}
                  <div className="link-edit-modal__target" ref={targetTriggerRef}>
                    <SelectTrigger
                      isOpen={targetPickerOpen}
                      onClick={() => setTargetPickerOpen((open) => !open)}
                      ariaLabel={linkMode === "block" ? "Block target" : "Page target"}
                    >
                      <span
                        className={
                          pickedNode === null &&
                          (currentNodeId === null || currentNodeId === undefined)
                            ? "select-trigger__placeholder"
                            : undefined
                        }
                      >
                        {pickedNode !== null
                          ? displayNameFromClient(client, pickedNode.id) ?? pickedNode.id
                          : currentNodeId !== null && currentNodeId !== undefined
                            ? (displayNameFromClient(client, currentNodeId) ?? currentNodeId)
                            : "No target selected"}
                      </span>
                    </SelectTrigger>
                  </div>
                  {brokenTargetId !== null && (
                    <div className="link-edit-modal__broken">
                      <span className="link-edit-modal__broken-text">
                        This page doesn't exist yet.
                      </span>
                      <Button variant="primary" size="sm" onClick={createBrokenTarget}>
                        Create page with this id
                      </Button>
                    </div>
                  )}
                  {targetPickerOpen && targetTriggerRef.current !== null && (
                    <NodeSelector
                      client={client}
                      anchorEl={targetTriggerRef.current}
                      searchMode={linkMode === "block" ? "all" : "pages"}
                      canAdd={(node) => linkMode !== "block" || rendersAsInlineBlock(node)}
                      excludeNodeId={excludeNodeId}
                      searchPlaceholder={
                        linkMode === "block" ? "Search blocks…" : "Search pages…"
                      }
                      onClose={() => setTargetPickerOpen(false)}
                      onAdd={(node) => {
                        setPickedNode(node);
                        setTargetPickerOpen(false);
                      }}
                    />
                  )}
                </>
            </div>

            {/* Custom label section */}
            <div className="link-edit-modal__section">
              <label className="link-edit-modal__label" htmlFor="link-label-input">
                Display Label
              </label>
              <input
                id="link-label-input"
                type="text"
                className="link-edit-modal__input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                autoComplete="off"
              />
              <span className="link-edit-modal__hint">
                Leave empty to use the node name
              </span>
            </div>
            </>
            )}
      </div>
    </Modal>
  );
}

export default LinkEditModal;

// ─── Host + opener context ──────────────────────────────────────────

/**
 * A request to edit a link token on a block — node links only (owner
 * ruling): external links are never edited here.
 *
 * - `node` — a mention token: retarget it and/or set an optional custom
 *   label (`displayText`). `tokenIndex` identifies the token.
 * - `verb` — a typed_link mark (PG1): edit the verb (free string or
 *   schema-bound via the create-and-bind row) and the optional locator. The
 *   marked word (`text`) is untouched.
 */
export type LinkEditTarget =
  | {
      kind: "node";
      blockId: string;
      /** Index of the mention token inside contentAst. */
      tokenIndex: number;
      insertAt: null;
      /** Current target — pre-fills the destination line. */
      initialNodeId: string;
      initialLabel: string;
    }
  | {
      kind: "verb";
      blockId: string;
      /** Index of the typed_link token inside contentAst. */
      tokenIndex: number;
      insertAt: null;
      /** Current verb (schema name when the mark is bound). */
      initialVerb: string;
      /** Current locator ("" when absent). */
      initialLocator: string;
    };

export type LinkEditModalOpener = (target: LinkEditTarget) => void;

const LinkEditModalContext = createContext<LinkEditModalOpener>(() => {});

/** Opens the page-level LinkEditModal (no-op without a host). */
export function useLinkEditModalOpener(): LinkEditModalOpener {
  return useContext(LinkEditModalContext);
}

/**
 * Rewrite the mention token a modal save produced. A picked node retargets
 * the link (fresh `linkId` — the analytics join key follows the destination);
 * a null nodeId keeps the target and applies the label change only. A set
 * label becomes `displayText` (and the captured surface text); a cleared
 * label resolves the target's current display name instead.
 */
function writeNodeLink(
  client: WorkspaceClient | WorkerClient,
  target: LinkEditTarget & { kind: "node" },
  nodeId: string | null,
  label: string | null,
): void {
  const node = client.getNode(target.blockId);
  if (node === undefined) return;
  const existing = node.contentAst[target.tokenIndex];
  if (
    typeof existing !== "object" ||
    existing === null ||
    (existing as { type?: unknown }).type !== "mention"
  ) {
    return;
  }
  const current = existing as {
    targetNodeId: string;
    text: string;
    displayText?: string;
    linkId?: string;
  };
  const targetNodeId = nodeId ?? current.targetNodeId;
  const text =
    label !== null && label !== ""
      ? label
      : (displayNameFromClient(client, targetNodeId) ?? current.text);
  const token: Record<string, unknown> = { type: "mention", targetNodeId, text };
  if (label !== null && label !== "") token.displayText = label;
  if (nodeId === null) {
    if (current.linkId !== undefined) token.linkId = current.linkId;
  } else {
    token.linkId = uuidv7();
  }
  if (JSON.stringify(token) !== JSON.stringify({ ...current, displayText: current.displayText })) {
    const next = withCandidateSpans(
      node.contentAst.map((t, i) => (i === target.tokenIndex ? token : t)),
    ) as typeof node.contentAst;
    void client.updateObject(target.blockId, { contentAst: next });
  }
}

/**
 * Rewrite the typed_link mark a modal save produced (PG1). The marked word
 * rides through untouched; the verb becomes the free string or the bound
 * `{ propertySchemaId }` shape, and the locator metadata updates (absent =
 * cleared). Other metadata (candidateSpans) survives.
 */
function writeVerbLink(
  client: WorkspaceClient | WorkerClient,
  target: LinkEditTarget & { kind: "verb" },
  verb: string | { propertySchemaId: string },
  locator: string,
): void {
  const node = client.getNode(target.blockId);
  if (node === undefined) return;
  const existing = node.contentAst[target.tokenIndex];
  if (
    typeof existing !== "object" ||
    existing === null ||
    (existing as { type?: unknown }).type !== "typed_link"
  ) {
    return;
  }
  const current = existing as {
    verb?: unknown;
    text?: unknown;
    metadata?: Record<string, unknown>;
  };
  if (typeof current.text !== "string") return;
  const metadata: Record<string, unknown> = { ...(current.metadata ?? {}) };
  if (locator !== "") metadata.locator = locator;
  else delete metadata.locator;
  const token: Record<string, unknown> = {
    type: "typed_link",
    verb,
    text: current.text,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  const next = node.contentAst.map((t, i) => (i === target.tokenIndex ? (token as typeof t) : t));
  void client.updateObject(target.blockId, { contentAst: next });
}

/** Renders the modal at the page level; children open it via context. */
export function LinkEditModalHost({
  client,
  children,
}: {
  client: WorkspaceClient | WorkerClient;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<LinkEditTarget | null>(null);

  const open = useCallback<LinkEditModalOpener>((t) => setTarget(t), []);
  const close = useCallback(() => setTarget(null), []);

  const handleSave = useCallback(
    (result: LinkEditResult) => {
      if (target === null) return;
      if (target.kind === "verb") {
        if (result.verb !== undefined) {
          writeVerbLink(client, target, result.verb, result.locator ?? "");
        }
      } else {
        writeNodeLink(client, target, result.nodeId ?? null, result.label);
      }
      setTarget(null);
    },
    [client, target],
  );

  return (
    <LinkEditModalContext.Provider value={open}>
      {children}
      {target !== null && (
        <LinkEditModal
          isOpen
          client={client}
          currentNodeId={target.kind === "node" ? target.initialNodeId : null}
          currentVerb={target.kind === "verb" ? target.initialVerb : undefined}
          currentLocator={target.kind === "verb" ? target.initialLocator : undefined}
          excludeNodeId={target.blockId}
          currentLabel={target.kind === "node" ? target.initialLabel : null}
          title={target.kind === "verb" ? "Edit Link Verb" : "Edit Link"}
          initialMode={
            target.kind === "verb"
              ? "verb"
              : (() => {
                  const targetNode = client.getNode(target.initialNodeId);
                  return targetNode !== undefined && rendersAsInlineBlock(targetNode)
                    ? "block"
                    : "node";
                })()
          }
          onSave={handleSave}
          onClose={close}
        />
      )}
    </LinkEditModalContext.Provider>
  );
}
