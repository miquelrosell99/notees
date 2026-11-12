/**
 * Create-with-template picker tests (the TemplatePickerModal component
 * level): the modal titles itself "New <class>", lists the Blank row plus
 * one row per bound template in input order, and confirms immediately —
 * onPick(null) for the blank register, onPick(templateId) for a template
 * (the caller then creates the object and instantiates through the clone
 * engine; the gallery and apply-to-existing suites cover that write).
 *
 * (The picker's former only driver — the Calendar day view's Tasks New
 * affordance — retired 2026-10-24 with the day view's sections; the
 * calendar's Day zoom is the agenda now, and the tasks hub never carried a
 * create flow. The picker component remains the shared register for any
 * classed create surface that offers templates.)
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { ClientNode } from "../src/core/workspace-client/index.js";
import { TemplatePickerModal } from "../src/features/templates/TemplatePickerModal.js";

beforeAll(async () => {
  await initSqlJs();
  // jsdom lacks ResizeObserver; the Modal composes fleet chrome that
  // observes layout.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A template node stand-in: the picker only reads the display name. */
function templateNode(id: string, name: string): ClientNode {
  return {
    id,
    contentAst: [{ type: "text", text: name }],
  } as unknown as ClientNode;
}

describe("TemplatePickerModal (create-with-template picker)", () => {
  it("titles itself 'New <class>' and lists Blank plus one row per template, in order", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <TemplatePickerModal
        isOpen
        onClose={onClose}
        classLabel="task"
        templates={[templateNode("t-1", "Sync template"), templateNode("t-2", "Weekly review")]}
        onPick={onPick}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("New task");
    const options = within(dialog).getByRole("group", { name: "Template options" });
    const buttons = options.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.textContent).toContain("Blank task");
    expect(buttons[1]!.textContent).toContain("Sync template");
    expect(buttons[2]!.textContent).toContain("Weekly review");
  });

  it("picking Blank confirms null; picking a template confirms its id", () => {
    const onPick = vi.fn();
    render(
      <TemplatePickerModal
        isOpen
        onClose={() => {}}
        classLabel="gathering"
        templates={[templateNode("t-1", "Sync template")]}
        onPick={onPick}
      />,
    );

    const options = screen.getByRole("group", { name: "Template options" });
    fireEvent.click(within(options).getByRole("button", { name: "Blank gathering" }));
    expect(onPick).toHaveBeenLastCalledWith(null);

    fireEvent.click(within(options).getByRole("button", { name: "Sync template" }));
    expect(onPick).toHaveBeenLastCalledWith("t-1");
  });

  it("an untitled template reads the honest placeholder; Cancel closes", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <TemplatePickerModal
        isOpen
        onClose={onClose}
        classLabel="meeting"
        // No content at all: the Untitled register (title-is-content).
        templates={[{ id: "t-x", contentAst: [] } as unknown as ClientNode]}
        onPick={onPick}
      />,
    );

    const options = screen.getByRole("group", { name: "Template options" });
    expect(within(options).getByRole("button", { name: "Untitled template" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});
