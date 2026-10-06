/**
 * LinkEditModal — modal for editing inline link pills.
 *
 * Ported from the archived editor chrome, which edited three link kinds
 * (node / block / URL) through a shared NodeSelector. Both node-ish kinds
 * are wired here: the target section hosts the NodeSelector picker (Page =
 * pages, Block = blocks) and the Display Label field sets an optional
 * per-link `displayText` override (empty = resolve the target's name). URL
 * mode authors external_link tokens. Verb mode edits a
 * typed_link mark: the verb field live-matches the workspace's property
 * schemas (an exact name hit saves bound to the existing schema; an unknown
 * name offers "Create property '…' and bind") plus the optional locator.
 * When the mention's target id resolves to no node, the target section
 * offers the "create page with this id" heal (the caller-id create
 * path — the mention heals in place, no retarget write). Enter inside the
 * modal saves (capture phase, so it beats button activation) — except
 * inside the embedded node picker, which owns Enter/Escape for its rows;
 * Esc/backdrop close.
 *
 * The modal shell keeps the archived DOM (`.modal-backdrop` > card >
 * `.modal` > `.modal__header` / `.modal__content` / `.modal__footer`); the
 * shell chrome this app shell does not ship is supplied scoped in
 * LinkEditModal.css.
 *
 * LinkEditModalHost (below) renders the modal at the page level and exposes
 * an opener through context: the slash-command flow (BlockTextEditor),
 * read-mode clicks on external-link chips (PageView), and the block
 * editor's node-link context menu all land here.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { uuidv7 } from "uuidv7";

import { rendersAsInlineBlock } from "@notees/domain";

import { spliceTokens } from "@/editor/edit-apply.js";
import { withCandidateSpans } from "@/editor/capture.js";
import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { NodeSelector } from "../components/pickers/NodeSelector.js";
import { notificationStore } from "../components/ui/notificationStore.js";
import "./LinkEditModal.css";

export type LinkMode = "node" | "block" | "url" | "verb";

export interface LinkEditResult {
  /** Link mode — node, block, URL, or verb. */
  mode: LinkMode;
  /** URL string (url mode only). */
  url?: string;
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
  { value: "node" as const, icon: "mdi-link-variant", label: "Page" },
  { value: "block" as const, icon: "mdi-text-box", label: "Block" },
  { value: "url" as const, icon: "mdi-web", label: "URL" },
];

/** Minimal schema shape the verb row matches against (PG1). */
interface VerbSchemaOption {
  id: string;
  name: string;
}

interface LinkEditModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Workspace client driving the embedded node picker. */
  client: WorkspaceClient | WorkerClient;
  /** Current URL (for URL pills). */
  currentUrl?: string | undefined;
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
  /** Override the initial link mode (default: url). */
  initialMode?: LinkMode;
  /** Called when saving changes. */
  onSave: (result: LinkEditResult) => void;
  /** Called when closing without saving. */
  onClose: () => void;
}

/** Mode toggle — the archived SelectionButton's DOM (indicator + option buttons). */
function ModeSelectionButton({
  value,
  onChange,
}: {
  value: LinkMode;
  onChange: (mode: LinkMode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{ width?: number; transform?: string }>({});

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const options = container.querySelectorAll<HTMLElement>(".selection-button__option");
    const selectedIndex = LINK_MODE_OPTIONS.findIndex((opt) => opt.value === value);
    const selectedElement = options[selectedIndex];
    if (selectedElement) {
      setIndicatorStyle({
        width: selectedElement.offsetWidth,
        transform: `translateX(${selectedElement.offsetLeft - 4}px)`,
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="selection-button selection-button--horizontal selection-button--sm"
      role="radiogroup"
      aria-label="Link mode"
    >
      <div className="selection-button__indicator" style={indicatorStyle} />
      {LINK_MODE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`selection-button__option ${
            value === opt.value ? "selection-button__option--selected" : ""
          }`}
          title={opt.label}
          aria-label={opt.label}
          onClick={() => onChange(opt.value)}
        >
          <Icon path={opt.icon} size={0.7} />
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

export function LinkEditModal({
  isOpen,
  client,
  currentUrl,
  currentNodeId,
  excludeNodeId,
  currentLabel,
  currentVerb,
  currentLocator,
  title = "Edit Link",
  initialMode = "url",
  onSave,
  onClose,
}: LinkEditModalProps) {
  const [linkMode, setLinkMode] = useState<LinkMode>(initialMode);
  const [url, setUrl] = useState(currentUrl ?? "");
  const [label, setLabel] = useState(currentLabel ?? "");
  /** Verb mode (PG1): the mark's verb + optional locator. */
  const [verb, setVerb] = useState("");
  const [verbLocator, setVerbLocator] = useState("");
  const [verbPending, setVerbPending] = useState(false);
  const [verbError, setVerbError] = useState<string | null>(null);
  /** Newly picked destination (node/block modes); null = keep the current target. */
  const [pickedNode, setPickedNode] = useState<ClientNode | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const verbInputRef = useRef<HTMLInputElement>(null);

  /**
   * Broken-link heal: the mention's target id resolves to no node —
   * offer creating the page AT that id (the caller-id create path), so the
   * mention heals in place instead of being retargeted.
   */
  const brokenTargetId =
    linkMode !== "url" &&
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
      setUrl(currentUrl ?? "");
      setLabel(currentLabel ?? "");
      setPickedNode(null);
      setVerb(currentVerb ?? "");
      setVerbLocator(currentLocator ?? "");
      setVerbPending(false);
      setVerbError(null);
    }
  }, [isOpen, currentLabel, currentUrl, initialMode, currentVerb, currentLocator]);

  useEffect(() => {
    if (isOpen && linkMode === "url") {
      urlInputRef.current?.focus();
    }
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
    if (linkMode === "url") {
      onSave({
        mode: "url",
        url: url.trim(),
        label: trimmedLabel || null,
      });
    } else {
      onSave({ mode: linkMode, nodeId: pickedNode?.id ?? null, label: trimmedLabel || null });
    }
  }, [linkMode, url, label, pickedNode, verbTrimmed, verbLocator, verbMatch, onSave, onClose]);

  // Escape closes from anywhere while the modal is open (the archived modal
  // delegated this to the global overlay stack).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Enter anywhere inside the modal = save (capture phase to beat button
  // activation).
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement;
      if (!target.closest(".link-edit-modal")) return;
      // The embedded node picker owns Enter (pick row) and Escape (close);
      // the broken-link heal row and the verb create-and-bind row's buttons
      // activate normally (click), they must not fall into the save path.
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
      <button type="button" className="btn btn--ghost" onClick={onClose}>
        Cancel
      </button>
      <button type="button" className="btn btn--primary" onClick={handleSave}>
        Save
      </button>
    </div>
  );

  const modal = (
    // Backdrop click closes; the panel itself stops propagation.
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card card--elevation-high card--radius-xl modal modal--sm link-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <h2 id="modal-title" className="modal__title">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close modal"
            className="btn btn--ghost btn--sm btn--icon-only modal__close"
            onClick={onClose}
          >
            <Icon path="mdi-close" size={0.7} className="btn__icon btn__icon--left" />
          </button>
        </div>

        <div className="modal__content">
          <div className="link-edit-modal__body" data-editor-companion>
            {/* Mode toggle — verb targets arrive from the typed-link mark
                editor and stay in verb mode (no mode switch). */}
            {linkMode !== "verb" && (
              <div className="link-edit-modal__section link-edit-modal__mode-section">
                <ModeSelectionButton value={linkMode} onChange={setLinkMode} />
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
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={verbPending}
                        onClick={runCreateAndBind}
                      >
                        {verbPending
                          ? `Creating property "${verbTrimmed}"…`
                          : `Create property "${verbTrimmed}" and bind`}
                      </button>
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
                {linkMode === "node" ? "Page" : linkMode === "block" ? "Block" : "URL"}
              </label>
              {linkMode === "url" ? (
                <input
                  ref={urlInputRef}
                  type="text"
                  className="link-edit-modal__input"
                  placeholder="https://..."
                  aria-label="URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoComplete="off"
                />
              ) : (
                <>
                  <div className="link-edit-modal__target" aria-live="polite">
                    {pickedNode !== null
                      ? displayNameFromClient(client, pickedNode.id) ?? pickedNode.id
                      : currentNodeId !== null && currentNodeId !== undefined
                        ? (displayNameFromClient(client, currentNodeId) ?? currentNodeId)
                        : "No target selected"}
                  </div>
                  {brokenTargetId !== null && (
                    <div className="link-edit-modal__broken">
                      <span className="link-edit-modal__broken-text">
                        This page doesn't exist yet.
                      </span>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={createBrokenTarget}
                      >
                        Create page with this id
                      </button>
                    </div>
                  )}
                  <NodeSelector
                    client={client}
                    trigger="inline"
                    searchMode={linkMode === "block" ? "all" : "pages"}
                    canAdd={(node) => linkMode !== "block" || rendersAsInlineBlock(node)}
                    excludeNodeId={excludeNodeId}
                    searchPlaceholder={
                      linkMode === "block" ? "Search blocks…" : "Search pages…"
                    }
                    onAdd={(node) => setPickedNode(node)}
                  />
                </>
              )}
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
                {linkMode === "url" ? "Leave empty to use the URL" : "Leave empty to use the node name"}
              </span>
            </div>
            </>
            )}
          </div>
        </div>

        <div className="modal__footer">{footer}</div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

export default LinkEditModal;

// ─── Host + opener context ──────────────────────────────────────────

/**
 * A request to edit (or insert) a link token on a block.
 *
 * - `external` — an external_link token (URL mode).
 * - `node`     — a mention token: retarget it and/or set an optional custom
 *   label (`displayText`). `tokenIndex` identifies the token; `insertAt` is
 *   reserved for future insert flows.
 * - `verb`     — a typed_link mark (PG1): edit the verb (free string or
 *   schema-bound via the create-and-bind row) and the optional locator. The
 *   marked word (`text`) is untouched.
 */
export type LinkEditTarget =
  | {
      kind: "external";
      blockId: string;
      /** Index of the external_link token inside contentAst (edit flow). */
      tokenIndex: number | null;
      /** Prose offset for inserting a new token (slash flow). */
      insertAt: number | null;
      initialUrl: string;
      initialLabel: string;
    }
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

/** Write (or insert) the external_link token a modal save produced. */
function writeExternalLink(
  client: WorkspaceClient | WorkerClient,
  target: LinkEditTarget & { kind: "external" },
  url: string,
  label: string | null,
): void {
  const node = client.getNode(target.blockId);
  if (node === undefined) return;
  const text = label !== null && label !== "" ? label : url;
  const token = { type: "external_link" as const, href: url, text };
  const next =
    target.tokenIndex !== null
      ? node.contentAst.map((t, i) => (i === target.tokenIndex ? token : t))
      : target.insertAt !== null
        ? spliceTokens(node.contentAst, target.insertAt, target.insertAt, [token])
        : null;
  if (next !== null) void client.updateObject(target.blockId, { contentAst: next });
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
  openerRef,
}: {
  client: WorkspaceClient | WorkerClient;
  children: ReactNode;
  /**
   * Publishes the opener to an ancestor that cannot consume the context it
   * renders (PageView owns the click delegation but renders this host).
   */
  openerRef?: RefObject<LinkEditModalOpener | null>;
}) {
  const [target, setTarget] = useState<LinkEditTarget | null>(null);

  const open = useCallback<LinkEditModalOpener>((t) => setTarget(t), []);
  useEffect(() => {
    if (openerRef) openerRef.current = open;
  }, [openerRef, open]);
  const close = useCallback(() => setTarget(null), []);

  const handleSave = useCallback(
    (result: LinkEditResult) => {
      if (target === null) return;
      if (target.kind === "external") {
        // An empty URL is an honest no-op (no token written).
        if (result.url !== undefined && result.url.trim() !== "") {
          writeExternalLink(client, target, result.url.trim(), result.label);
        }
      } else if (target.kind === "verb") {
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
          currentUrl={target.kind === "external" ? target.initialUrl : undefined}
          currentNodeId={target.kind === "node" ? target.initialNodeId : null}
          currentVerb={target.kind === "verb" ? target.initialVerb : undefined}
          currentLocator={target.kind === "verb" ? target.initialLocator : undefined}
          excludeNodeId={target.blockId}
          currentLabel={target.kind === "external" || target.kind === "node" ? target.initialLabel : null}
          title={target.kind === "verb" ? "Edit Link Verb" : "Edit Link"}
          initialMode={
            target.kind === "external"
              ? "url"
              : target.kind === "verb"
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
