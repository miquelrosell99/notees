/**
 * UI primitives kit — render smoke tests.
 *
 * Exercises each ported primitive through real renders: markup/class
 * fidelity (the legacy class contract), open/close interactions, and the
 * portal behavior the components rely on.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { Badge } from "../src/ui/components/ui/Badge.js";
import { Button } from "../src/ui/components/ui/Button.js";
import { ConfirmationModal } from "../src/ui/components/ui/ConfirmationModal.js";
import { ContextMenu } from "../src/ui/components/ui/ContextMenu.js";
import { Dropdown } from "../src/ui/components/ui/Dropdown.js";
import { EmptyState } from "../src/ui/components/ui/EmptyState.js";
import { Modal } from "../src/ui/components/ui/Modal.js";
import { NotificationToast } from "../src/ui/components/ui/NotificationToast.js";

describe("Button", () => {
  it("renders text with variant and size classes", () => {
    render(
      <Button variant="primary" size="lg">
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveClass("btn", "btn--primary", "btn--lg");
    expect(button.querySelector(".btn__text")).toHaveTextContent("Save");
  });

  it("marks icon+text buttons with the icon-text class", () => {
    render(<Button icon="mdi mdi-cog">Settings</Button>);
    expect(screen.getByRole("button", { name: /settings/i })).toHaveClass("btn--icon-text");
  });

  it("renders icon-only with the icon-only class and spinner while loading", () => {
    render(<Button icon="mdi mdi-cog" aria-label="Settings" loading />);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button).toHaveClass("btn--icon-only", "btn--loading");
    expect(button).toBeDisabled();
    expect(button.querySelector(".spinner")).not.toBeNull();
  });

  it("calls onClick when activated", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
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

    fireEvent.click(screen.getByRole("button", { name: /beta/i }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(document.body.querySelector(".dropdown-menu--portal")).toBeNull();
  });

  it("shows the empty state when no options match the search", () => {
    render(<Dropdown options={[{ value: "a", label: "Alpha" }]} searchable emptyContent="Nothing found" />);
    fireEvent.click(screen.getByRole("button", { name: /select/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /search options/i }), {
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
    expect(dialog).toHaveClass("modal", "modal--md", "card");
    expect(screen.getByRole("heading", { name: "Settings" })).toHaveClass("modal__title");
    expect(dialog.querySelector(".modal__content")).toHaveTextContent("Body text");
    expect(dialog.querySelector(".modal__footer")).not.toBeNull();
  });

  it("closes on backdrop click but not on content click", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose}>
        <p>inside</p>
      </Modal>,
    );
    const backdrop = document.body.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.click(backdrop);
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
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveClass("btn--danger-solid");
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
