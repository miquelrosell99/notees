/**
 * VerbPopover — the typed-link gesture on a selection: a free-string verb
 * ("cites", "contradicts") plus an optional locator. Rendered by
 * BlockTextEditor next to the FloatingToolbar; its inputs take focus (the
 * editor's blur handler treats focus-within as "stay in edit mode").
 * Enter submits, Esc cancels. Fixed-positioned at the selection anchor.
 *
 * PG1 schema-at-capture (§34.32): the popover live-matches the typed verb
 * against the workspace's property schemas and offers the bound-verb path —
 * a row under the fields:
 *  - the verb matches an EXISTING property schema → "Bind to property …"
 *    writes the mark with `verb: { propertySchemaId }` (the designed
 *    bound-verb shape; the plain "Link" submit stays free-string);
 *  - the verb matches NOTHING → "Create property '…' and bind" runs the
 *    create-and-bind flow (propertySchema.create typed object/multi with an
 *    empty targetClassFilter, then the same bound mark) through the caller's
 *    async onCreateAndBind.
 */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { usePopupDismissal } from "./components/ui/usePopupDismissal.js";

/** Minimal schema shape the capture row matches against. */
export interface VerbSchemaOption {
  id: string;
  name: string;
}

interface VerbPopoverProps {
  top: number;
  left: number;
  /** Property schemas live-matched against the typed verb (PG1). */
  schemas?: readonly VerbSchemaOption[] | undefined;
  /** Bind the mark to an existing property schema (PG1). */
  onBind?: ((schemaId: string, verb: string, locator: string) => void) | undefined;
  /**
   * Create-and-bind (PG1): the caller authors the property schema (typed
   * object, multi, empty targetClassFilter) and then binds the mark. May
   * return a promise — the row shows a pending state and surfaces a failure.
   */
  onCreateAndBind?: ((verb: string, locator: string) => void | Promise<void>) | undefined;
  onSubmit: (verb: string | { propertySchemaId: string }, locator: string) => void;
  onCancel: () => void;
}

export function VerbPopover({ top, left, schemas, onBind, onCreateAndBind, onSubmit, onCancel }: VerbPopoverProps) {
  const [verb, setVerb] = useState("");
  const [locator, setLocator] = useState("");
  const [pending, setPending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const verbRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Dismissal (§34.67): pointer-down outside the popover cancels it. Escape
  // stays with the form's own keydown (the hook skips in-popup keystrokes).
  usePopupDismissal({
    popupRef: formRef,
    isOpen: true,
    onClose: onCancel,
    closeOnEscape: false,
  });

  useEffect(() => {
    verbRef.current?.focus();
  }, []);

  const trimmed = verb.trim();
  const locatorTrimmed = locator.trim();
  const match =
    trimmed === ""
      ? null
      : (schemas?.find((schema) => schema.name.toLowerCase() === trimmed.toLowerCase()) ?? null);
  const bindAvailable = onBind !== undefined && match !== null;
  const createAvailable = onCreateAndBind !== undefined && trimmed !== "" && match === null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed === "" || pending) return;
    onSubmit(trimmed, locatorTrimmed);
  };

  const createAndBind = () => {
    if (onCreateAndBind === undefined || trimmed === "" || pending) return;
    setCreateError(null);
    setPending(true);
    try {
      const result = onCreateAndBind(trimmed, locatorTrimmed);
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((error: unknown) => {
          setCreateError(error instanceof Error ? error.message : String(error));
          setPending(false);
        });
      } else {
        setPending(false);
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
      setPending(false);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form ref={formRef} className="nt-verb-popover" style={{ top, left }} onSubmit={submit} onKeyDown={keyDown}>
      <label className="nt-verb-field">
        Verb
        <input
          ref={verbRef}
          value={verb}
          onChange={(event) => {
            setVerb(event.target.value);
            setCreateError(null);
          }}
          placeholder="cites, contradicts…"
          aria-label="Verb"
        />
      </label>
      <label className="nt-verb-field">
        Locator (optional)
        <input
          value={locator}
          onChange={(event) => setLocator(event.target.value)}
          placeholder="p. 12"
          aria-label="Locator"
        />
      </label>
      {(bindAvailable || createAvailable) && (
        <div className="nt-verb-bind-row">
          {bindAvailable && match !== null && (
            <button
              type="button"
              className="nt-verb-bind"
              disabled={pending}
              onClick={() => onBind!(match.id, trimmed, locatorTrimmed)}
            >
              Bind to property "{match.name}"
            </button>
          )}
          {createAvailable && (
            <button
              type="button"
              className="nt-verb-bind"
              disabled={pending}
              onClick={createAndBind}
            >
              {pending ? `Creating property "${trimmed}"…` : `Create property "${trimmed}" and bind`}
            </button>
          )}
        </div>
      )}
      {createError !== null && (
        <div className="nt-verb-bind-error" role="alert">
          {createError}
        </div>
      )}
      <div className="nt-verb-actions">
        <button type="submit" className="nt-verb-apply">
          Link
        </button>
        <button type="button" className="nt-verb-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
