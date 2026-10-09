/**
 * CommentsSection — the Comments section of the page chrome's context
 * column: the original model restored onto
 * the op-log graph. Comments are DIRECT CHILDREN classed `comment` (the
 * seeded system class — the original UUID, packages/domain/src/seeds.ts); a reply
 * is a comment whose parent is the comment; a comment's children nest in the
 * thread (any child blocks nest — the original recursion over comment.children). The
 * main body never renders comment-classed rows: childQuery cuts them at
 * every level, so this section is their only surface.
 *
 * The section chrome is NodeViewSection ("Comments" + the direct-child
 * count), ALWAYS rendered (owner 2026-10-09) — an empty thread shows the
 * section with its icon-only quick-add riding the header's trailing action
 * (the shared section-action slot), and starts expanded so the composer is
 * one click away; the quick-add/reply composer pair creates a
 * child block classed comment through the ordinary write path (createObject
 * with the class + the text as initial content — title-is-content), and each
 * row carries the original action pair: Reply (the nested composer) and delete
 * (object.delete). A row click opens the comment node. Lazy per the section
 * contract: the thread resolution rides useSectionData (no read runs until
 * the first expand; a client notification re-derives while expanded; the
 * eager count that rides the header is the cheap direct-child read).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { useSectionData } from "./useSectionData.js";
import "./CommentsSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** One comment node plus its nested children (the thread tree). */
export interface CommentThread {
  node: ClientNode;
  children: CommentThread[];
}

/** True when the node carries the seeded system comment class. */
function isComment(node: ClientNode): boolean {
  return node.classIds.includes(SYSTEM_CLASS_UUIDS.comment);
}

/** The direct comment children of a node (the original getCommentNodes read). */
export function commentChildrenOf(client: AnyClient, nodeId: string): ClientNode[] {
  return client.getChildren(nodeId).filter(isComment);
}

/** A comment + its children, recursively (any child blocks nest). */
function threadOf(client: AnyClient, node: ClientNode): CommentThread {
  return {
    node,
    children: client.getChildren(node.id).map((child) => threadOf(client, child)),
  };
}

/**
 * The quick-add/reply composer (the original pair): a plain input — Enter submits,
 * Escape (or an untouched blur) cancels. Submit creates a child block classed
 * comment parented at `parentId` (the page for a top-level comment, the
 * comment for a reply) with the text as its initial content; the client
 * notification re-derives the section while expanded, so the row appears
 * without any local list surgery.
 */
function CommentComposer({
  client,
  parentId,
  placeholder,
  onClose,
}: {
  client: AnyClient;
  parentId: string;
  placeholder: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    void client.createObject({
      parentId,
      classIds: [SYSTEM_CLASS_UUIDS.comment],
      name: trimmed,
    });
    setText("");
    onClose();
  };

  return (
    <div className="nt-comments__composer">
      <input
        ref={inputRef}
        type="text"
        className="nt-comments__input"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            setText("");
            onClose();
          }
        }}
        onBlur={() => {
          // An untouched blur cancels; a submitted composer already closed.
          if (text.trim() === "") onClose();
        }}
      />
      <button
        type="button"
        className="nt-icon-btn"
        aria-label="Send comment"
        title="Send comment"
        disabled={text.trim() === ""}
        onMouseDown={(event) => event.preventDefault() /* keep the input focused */}
        onClick={submit}
      >
        <Icon path="mdi-send" size={0.8} />
      </button>
    </div>
  );
}

/**
 * One comment row: its text (title-is-content — the display name IS the
 * content), the Reply toggle (the nested composer), and the delete action
 * (the original pair). Children nest as a sub-list — any child blocks, not only
 * comment-classed ones (the original recursion). The row click opens the comment
 * node.
 */
function CommentRow({
  client,
  thread,
  onOpenNode,
}: {
  client: AnyClient;
  thread: CommentThread;
  onOpenNode: ((nodeId: string) => void) | undefined;
}) {
  const [replying, setReplying] = useState(false);
  const label = displayNameFromClient(client, thread.node.id) ?? thread.node.id;

  return (
    <li className="nt-comments__item">
      <div className="nt-comments__row">
        <button
          type="button"
          className="nt-comments__text"
          title={label}
          onClick={() => onOpenNode?.(thread.node.id)}
        >
          {label}
        </button>
        <span className="nt-comments__actions">
          <button
            type="button"
            className="nt-comments__action"
            aria-label={replying ? `Cancel reply to ${label}` : `Reply to ${label}`}
            title={replying ? "Cancel reply" : "Reply"}
            onClick={() => setReplying((open) => !open)}
          >
            <Icon path="mdi-reply-outline" size={0.75} />
          </button>
          <button
            type="button"
            className="nt-comments__action"
            aria-label={`Delete comment ${label}`}
            title="Delete comment"
            onClick={() => void client.deleteObject(thread.node.id)}
          >
            <Icon path="mdi-delete-outline" size={0.75} />
          </button>
        </span>
      </div>
      {replying && (
        <CommentComposer
          client={client}
          parentId={thread.node.id}
          placeholder="Reply…"
          onClose={() => setReplying(false)}
        />
      )}
      {thread.children.length > 0 && (
        <ul className="nt-comments__list nt-comments__list--nested">
          {thread.children.map((child) => (
            <CommentRow key={child.node.id} client={client} thread={child} onOpenNode={onOpenNode} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CommentsSection({
  client,
  nodeId,
  onOpenNode,
}: {
  client: AnyClient;
  nodeId: string;
  /** Row click / navigation funnel (the page's onOpenPage). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  /** Eager count riding the header: the direct comment children (cheap read). */
  const count = commentChildrenOf(client, nodeId).length;

  /**
   * Expanded state: an empty thread starts EXPANDED (the quick-add must be
   * visible without a prior expand — owner 2026-10-09); a thread with
   * comments keeps the section norm (collapsed until the first expand).
   */
  const [expanded, setExpanded] = useState(count === 0);
  const [composing, setComposing] = useState(false);

  /** Lazy per the section contract: threads resolve on the first expand. */
  const readThreads = useCallback(
    () => commentChildrenOf(client, nodeId).map((node) => threadOf(client, node)),
    [client, nodeId],
  );
  const { rows } = useSectionData<CommentThread[]>({
    client,
    active: expanded,
    read: readThreads,
  });

  return (
    <NodeViewSection
      title="Comments"
      icon={<Icon path="mdi-comment-outline" size={0.9} />}
      count={count}
      className="nt-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
      action={{
        icon: "mdi-comment-plus-outline",
        label: "Add comment",
        onClick: () => {
          // The composer renders in the section body: expand (a collapsed
          // thread would hide the input) and open it.
          setExpanded(true);
          setComposing(true);
        },
      }}
    >
      <div className="nt-comments">
        {composing && (
          <CommentComposer
            client={client}
            parentId={nodeId}
            placeholder="Add a comment…"
            onClose={() => setComposing(false)}
          />
        )}
        {rows !== null &&
          (rows.length === 0 ? (
            <div className="nt-section-empty">No comments.</div>
          ) : (
            <ul className="nt-comments__list">
              {rows.map((thread) => (
                <CommentRow key={thread.node.id} client={client} thread={thread} onOpenNode={onOpenNode} />
              ))}
            </ul>
          ))}
      </div>
    </NodeViewSection>
  );
}
