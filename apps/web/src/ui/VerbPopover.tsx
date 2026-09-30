/**
 * VerbPopover — the typed-link gesture on a selection: a free-string verb
 * ("cites", "contradicts") plus an optional locator. Rendered by
 * BlockTextEditor next to the FloatingToolbar; its inputs take focus (the
 * editor's blur handler treats focus-within as "stay in edit mode").
 * Enter submits, Esc cancels. Fixed-positioned at the selection anchor.
 */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

interface VerbPopoverProps {
  top: number;
  left: number;
  onSubmit: (verb: string, locator: string) => void;
  onCancel: () => void;
}

export function VerbPopover({ top, left, onSubmit, onCancel }: VerbPopoverProps) {
  const [verb, setVerb] = useState("");
  const [locator, setLocator] = useState("");
  const verbRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    verbRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = verb.trim();
    if (trimmed === "") return;
    onSubmit(trimmed, locator.trim());
  };

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form className="nt-verb-popover" style={{ top, left }} onSubmit={submit} onKeyDown={keyDown}>
      <label className="nt-verb-field">
        Verb
        <input
          ref={verbRef}
          value={verb}
          onChange={(event) => setVerb(event.target.value)}
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
