/**
 * UI primitives kit — render smoke tests.
 *
 * Exercises each ported primitive through real renders: markup/class
 * fidelity (the legacy class contract), open/close interactions, and the
 * portal behavior the components rely on.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { Badge } from "../src/components/ui/fleet/Badge.js";
import { Button } from "../src/components/ui/fleet/Button.js";
import { ConfirmationModal } from "../src/components/ui/fleet/ConfirmationModal.js";
import { ContextMenu } from "../src/components/ui/fleet/ContextMenu.js";
import { Dropdown } from "../src/components/ui/fleet/Dropdown.js";
import { EmptyState } from "../src/components/ui/fleet/EmptyState.js";
import { Modal } from "../src/components/ui/fleet/Modal.js";
import { NotificationToast } from "../src/components/ui/fleet/NotificationToast.js";

describe("Button", () => {
  it("renders text with variant and size classes", () => {
    render(
      <Button variant="primary" size="lg">
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    // The catalog contract: the `btn` marker hook + token utilities.
    expect(button).toHaveClass("btn", "bg-primary", "border-primary", "h-button-lg", "rounded-button");
    expect(button.querySelector(".btn__text")).toHaveTextContent("Save");
  });

  it("marks icon+text buttons with the icon + text spans", () => {
    render(<Button icon="mdi mdi-cog">Settings</Button>);
    const button = screen.getByRole("button", { name: /settings/i });
    expect(button.querySelector(".btn__icon")).not.toBeNull();
    expect(button.querySelector(".btn__text")).toHaveTextContent("Settings");
  });

  it("renders icon-only with the icon-only hook; the spinner waits out the 300ms rule", () => {
    vi.useFakeTimers();
    try {
      render(<Button icon="mdi mdi-cog" aria-label="Settings" loading />);
      const button = screen.getByRole("button", { name: "Settings" });
      expect(button).toHaveClass("btn--icon-only");
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
      // The loading-timing rule: nothing for <300ms, spinner after.
      expect(button.querySelector(".spinner")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(button.querySelector(".spinner")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onClick when activated", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("SearchField", () => {
  it("the sm variant rides the picker row grid, not the roomier md padding", () => {
    const process_ = process as unknown as { getBuiltinModule(name: "node:fs"): typeof import("node:fs") };
    const css = process_.getBuiltinModule("node:fs").readFileSync(
      `${process.cwd()}/src/components/ui/fleet/SearchField.css`,
      "utf8",
    );
    const sm = /\.search-field\.search-field--sm \{[^}]*\}/.exec(css);
    expect(sm).not.toBeNull();
    expect(sm![0]).toContain("padding-left: var(--spacing-2)");
    expect(sm![0]).toContain("padding-right: var(--spacing-2)");

    // The 20px glyph rides the same 24px icon lane as the result rows.
    const iconLane = /\.search-field\.search-field--sm \.search-field__icon \{[^}]*\}/.exec(css);
    expect(iconLane).not.toBeNull();
    expect(iconLane![0]).toContain("width: var(--icon-size-md)");

    // Anchored pickers already give the field an 8px panel margin; adding the
    // sm field's own inline padding would indent the placeholder a second
    // time relative to the result-row labels.
    const pickerCss = process_.getBuiltinModule("node:fs").readFileSync(
      `${process.cwd()}/src/features/pickers/NodeSelector.css`,
      "utf8",
    );
    const pickerField =
      /\.node-selector__picker \.node-selector__search-field\.search-field--sm \{[^}]*\}/.exec(
        pickerCss,
      );
    expect(pickerField).not.toBeNull();
    expect(pickerField![0]).toContain("padding-left: 0");
  });
});

describe("Badge", () => {
  it("renders the variant/size class contract", () => {
    render(<Badge variant="warning" size="md">3</Badge>);
    const badge = screen.getByText("3");
    expect(badge).toHaveClass("badge", "badge--warning", "badge--md");
  });
});

describe("EmptyState", () => {
  it("renders title, description and the CTA button", () => {
    const onAction = vi.fn();
    render(
      <EmptyState
        title="Nothing here"
        description="Items will appear once created."
        actionLabel="Create one"
        onAction={onAction}
      />,
    );
    expect(screen.getByRole("status")).toHaveClass("empty-state");
    expect(screen.getByRole("heading", { name: "Nothing here" })).toHaveClass("empty-state__title");
    fireEvent.click(screen.getByRole("button", { name: "Create one" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe("Dropdown", () => {
  it("opens the portal menu and selects an option", () => {
    const onChange = vi.fn();
    render(
      <Dropdown
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        value={null}
        onChange={onChange}
        placeholder="Pick…"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /pick/i }));
    const menu = document.body.querySelector(".dropdown-menu--portal");
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass("card", "dropdown-menu");

    // The combobox composition renders options as listbox options (the
    // a11y upgrade from the old <button> rows).
    fireEvent.click(screen.getByRole("option", { name: /beta/i }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(document.body.querySelector(".dropdown-menu--portal")).toBeNull();
  });

  it("shows the empty state when no options match the search", () => {
    render(<Dropdown options={[{ value: "a", label: "Alpha" }]} searchable emptyContent="Nothing found" />);
    fireEvent.click(screen.getByRole("button", { name: /select/i }));
    // cmdk renders the search field as the combobox input (named from the
    // command's hidden label).
    fireEvent.change(screen.getByRole("combobox", { name: /search options/i }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("Nothing found")).toHaveClass("dropdown-empty");
  });
});

describe("Modal", () => {
  it("renders into a portal with header, content and footer", () => {
    render(
      <Modal isOpen onClose={() => {}} title="Settings" footer={<button type="button">Done</button>}>
        <p>Body text</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    // The dialog chrome (modal, modal--md) + the token surface utilities the
    // old Card composition carried (elevation high, the 16px dialog radius —
    // owner ruling 2026-10-22).
    expect(dialog).toHaveClass("modal", "modal--md", "bg-surface", "rounded-dialog", "shadow-level3");
    expect(screen.getByRole("heading", { name: "Settings" })).toHaveClass("modal__title");
    expect(dialog.querySelector(".modal__content")).toHaveTextContent("Body text");
    expect(dialog.querySelector(".modal__footer")).not.toBeNull();
  });

  it("closes on backdrop pointer-down but not on content click", async () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose}>
        <p>inside</p>
      </Modal>,
    );
    // Radix registers its document pointerdown listener on a macrotask
    // (setTimeout 0) after mount.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const backdrop = document.body.querySelector(".modal-backdrop") as HTMLElement;
    // Radix dismisses on pointer-down outside the content (the overlay).
    fireEvent.pointerDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(<Modal isOpen={false} onClose={() => {}}>x</Modal>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConfirmationModal", () => {
  it("confirms via the primary action and cancels via the cancel button", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmationModal
        isOpen
        title="Delete it?"
        message="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("confirmation-modal");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // Flush the async handleConfirm continuation.
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses the danger-solid variant class for danger confirmations", () => {
    render(
      <ConfirmationModal
        isOpen
        title="Delete it?"
        message="m"
        variant="danger"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveClass("confirmation-modal--danger");
    // The danger-solid register as token utilities (the catalog contract).
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveClass(
      "bg-error",
      "border-error",
      "text-on-error",
    );
  });
});

describe("ContextMenu", () => {
  it("renders items in a portal menu and fires the clicked action", () => {
    const onClose = vi.fn();
    const onRename = vi.fn();
    render(
      <ContextMenu
        position={{ x: 40, y: 40 }}
        onClose={onClose}
        items={[
          { id: "rename", label: "Rename", icon: "mdi-pencil", onClick: onRename },
          { id: "sep", label: "", separator: true },
          { id: "del", label: "Delete", danger: true },
        ]}
      />,
    );
    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass("context-menu", "card");
    const rename = screen.getByRole("menuitem", { name: /rename/i });
    expect(rename).toHaveClass("context-menu-item");
    fireEvent.click(rename);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(menu.querySelector(".separator")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toHaveClass("danger");
  });
});

describe("NotificationToast", () => {
  it("renders toasts with type classes and dismisses on request", () => {
    const onDismiss = vi.fn();
    render(
      <NotificationToast
        notifications={[
          { id: "t1", type: "success", title: "Saved", message: "All good", dismissible: true },
          { id: "t2", type: "error", title: "Failed" },
        ]}
        onDismiss={onDismiss}
      />,
    );
    const container = document.body.querySelector(".notification-toast-container");
    expect(container).not.toBeNull();
    expect(screen.getByText("Saved").closest(".notification-toast")).toHaveClass(
      "notification-toast--success",
    );
    expect(screen.getByText("Failed").closest(".notification-toast")).toHaveClass(
      "notification-toast--error",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith("t1");
  });

  it("keeps a removed toast mounted briefly so the exit transition can play", () => {
    const { rerender } = render(
      <NotificationToast notifications={[{ id: "t1", type: "info", title: "Hey" }]} onDismiss={() => {}} />,
    );
    rerender(<NotificationToast notifications={[]} onDismiss={() => {}} />);
    const exiting = document.body.querySelector(".notification-toast--exiting");
    expect(exiting).not.toBeNull();
  });
});
