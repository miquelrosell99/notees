/**
 * PropertyIconButton tests: a select property bound with a
 * bullet/inline display position rides the block row as an icon button —
 * the current option's MDI icon tinted with its color (the at-a-glance state
 * read), or a subdued hollow circle when unset. Clicking opens the options
 * popover (checkmark on the selected; multi toggles; a None clear row when
 * not required). Writes go through setProperty/unsetProperty; the disabled
 * projection renders the icon without the popover. jsdom over the
 * in-process WorkspaceClient, mounted through PageView (the block-metadata
 * mounting style).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { PropertyIconButton } from "../src/ui/components/PropertyIconButton.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

const STATUS_OPTIONS = [
  { id: "opt-doing", label: "Doing", icon: "mdiCircleHalfFull", color: "orange" },
  { id: "opt-done", label: "Done", icon: "mdiCheckCircle", color: "green" },
  { id: "opt-plain", label: "Plain" },
];

/** A page with one block whose class binds "status" (select) at the given
 *  display position (display is property-level — set on the schema). */
async function seedStatusBlock(display: "bullet" | "inline" | "panel") {
  const client = await seedClient();
  const schemaId = await client.createPropertySchema({
    name: "status",
    type: "select",
    options: STATUS_OPTIONS,
  });
  const classId = await client.createClass("Taskish");
  await client.setClassProperty(classId, schemaId, { sequence: 0 });
  if (display !== "panel") {
    await client.updatePropertySchema(schemaId, { display });
  }
  const pageId = await client.createObject({ presentAsMain: true, name: "Tasks" });
  const blockId = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "a task" }],
  });
  await client.assignClass(blockId, classId);
  return { client, schemaId, classId, pageId, blockId };
}

function authoredValues(client: WorkspaceClient, blockId: string, schemaId: string): unknown[] {
  return client
    .getEffectiveProperties(blockId)
    .filter((row) => row.propertySchemaId === schemaId && row.source === "authored")
    .sort((a, b) => a.idx - b.idx)
    .map((row) => row.value);
}

describe("PropertyIconButton", () => {
  it("renders the current option's icon with the PropertyName: OptionLabel tooltip", async () => {
    const { client, schemaId, pageId, blockId } = await seedStatusBlock("bullet");
    await client.setProperty(blockId, schemaId, "opt-doing", 0);

    render(<PageView client={client} pageId={pageId} />);
    const button = screen.getByRole("button", { name: "status: Doing" });
    expect(button.dataset.propertySchemaId).toBe(schemaId);
    // The button is a sibling after the grip, inside the bullet group.
    const row = button.closest(".nt-block-row")!;
    expect(button.closest(".nt-block-bullet-props")).not.toBeNull();
    expect(row.querySelector(":scope > .nt-block-grip")).not.toBeNull();
    expect(row.querySelector(":scope > .nt-block-content")).not.toBeNull();
  });

  it("opens the picker listing every option with a checkmark on the selected", async () => {
    const { client, schemaId, pageId, blockId } = await seedStatusBlock("bullet");
    await client.setProperty(blockId, schemaId, "opt-doing", 0);

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "status: Doing" }));

    const menu = screen.getByRole("menu", { name: "status" });
    const doing = within(menu).getByRole("menuitem", { name: "Doing" });
    expect(doing.querySelector(".nt-propicon-option__check")).not.toBeNull();
    // The other options render without a check.
    expect(within(menu).getByRole("menuitem", { name: "Done" }).querySelector(".nt-propicon-option__check")).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Plain" })).not.toBeNull();
    // Value set + not required → the None clear row.
    expect(within(menu).getByRole("menuitem", { name: "None" })).not.toBeNull();
  });

  it("single-select click writes the value, closes the picker, retints the tooltip", async () => {
    const { client, schemaId, pageId, blockId } = await seedStatusBlock("bullet");
    await client.setProperty(blockId, schemaId, "opt-doing", 0);

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "status: Doing" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "status" })).getByRole("menuitem", { name: "Done" }));
    await flushWrites();

    expect(authoredValues(client, blockId, schemaId)).toEqual(["opt-done"]);
    expect(screen.queryByRole("menu", { name: "status" })).toBeNull();
    expect(screen.getByRole("button", { name: "status: Done" })).not.toBeNull();
  });

  it("None clears the value", async () => {
    const { client, schemaId, pageId, blockId } = await seedStatusBlock("bullet");
    await client.setProperty(blockId, schemaId, "opt-doing", 0);

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "status: Doing" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "status" })).getByRole("menuitem", { name: "None" }));
    await flushWrites();

    expect(authoredValues(client, blockId, schemaId)).toEqual([]);
    expect(screen.getByRole("button", { name: "status: none" })).not.toBeNull();
  });

  it("unset renders the subdued hollow circle, no None row, and can set a fresh value", async () => {
    const { client, schemaId, pageId, blockId } = await seedStatusBlock("bullet");

    render(<PageView client={client} pageId={pageId} />);
    const button = screen.getByRole("button", { name: "status: none" });
    expect(button.className).toContain("nt-propicon--unset");

    fireEvent.click(button);
    const menu = screen.getByRole("menu", { name: "status" });
    // Nothing set → no clear row, but every option is pickable.
    expect(within(menu).queryByRole("menuitem", { name: "None" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Done" }));
    await flushWrites();

    expect(authoredValues(client, blockId, schemaId)).toEqual(["opt-done"]);
  });

  it("multi_select toggles each selected option", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "tags",
      type: "multi_select",
      multi: true,
      options: [
        { id: "opt-a", label: "Alpha", icon: "mdiAlphaACircle", color: "sky" },
        { id: "opt-b", label: "Beta" },
        { id: "opt-c", label: "Gamma", color: "pink" },
      ],
    });
    const classId = await client.createClass("Tagged");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    await client.updatePropertySchema(schemaId, { display: "bullet" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Tags" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "tagged" }],
    });
    await client.assignClass(blockId, classId);
    // multi_select values are option-id arrays per idx (the store shape).
    await client.setProperty(blockId, schemaId, ["opt-a", "opt-b"], 0);

    render(<PageView client={client} pageId={pageId} />);
    // The tooltip names the FIRST selected option.
    fireEvent.click(screen.getByRole("button", { name: "tags: Alpha" }));
    let menu = screen.getByRole("menu", { name: "tags" });
    expect(
      within(menu).getByRole("menuitem", { name: "Alpha" }).querySelector(".nt-propicon-option__check"),
    ).not.toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "Beta" }).querySelector(".nt-propicon-option__check"),
    ).not.toBeNull();

    // Toggle Beta off — the popover stays open for further toggles.
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Beta" }));
    await flushWrites();
    expect(authoredValues(client, blockId, schemaId)).toEqual([["opt-a"]]);
    menu = screen.getByRole("menu", { name: "tags" });

    // Add Gamma — merged into the carrying row's array.
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Gamma" }));
    await flushWrites();
    expect(authoredValues(client, blockId, schemaId)).toEqual([["opt-a", "opt-c"]]);
  });

  it("disabled renders the icon statically and never opens the popover", async () => {
    const { client, schemaId, pageId, blockId } = await seedStatusBlock("bullet");
    await client.setProperty(blockId, schemaId, "opt-doing", 0);
    const rows = client.getEffectiveProperties(blockId);
    const options = client.listPropertySchemas().find((s) => s.id === schemaId)!.options!;

    const { container } = render(
      <PropertyIconButton
        client={client}
        nodeId={blockId}
        propertySchemaId={schemaId}
        label="status"
        options={options}
        rows={rows}
        multi={false}
        required={false}
        disabled
      />,
    );
    const staticEl = container.querySelector(".nt-propicon--static");
    expect(staticEl).not.toBeNull();
    expect(staticEl!.getAttribute("title")).toBe("status: Doing");
    fireEvent.click(staticEl!);
    expect(container.querySelector(".nt-propicon-popover")).toBeNull();
  });
});

describe("PropertyIconButton boolean mode", () => {
  /** A page with one block whose class binds a boolean at the bullet. */
  async function seedFlagBlock() {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "flag", type: "boolean" });
    const classId = await client.createClass("Flagged");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    await client.updatePropertySchema(schemaId, { display: "bullet" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Flags" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "flagged" }],
    });
    await client.assignClass(blockId, classId);
    return { client, schemaId, pageId, blockId };
  }

  it("true renders the owner-specified check-circle tinted green, with the picker check on True", async () => {
    const { client, schemaId, pageId, blockId } = await seedFlagBlock();
    await client.setProperty(blockId, schemaId, true, 0);

    render(<PageView client={client} pageId={pageId} />);
    const button = screen.getByRole("button", { name: "flag: True" });
    expect(button.querySelector("svg")!.style.color).toContain("--color-preset-green");

    fireEvent.click(button);
    const menu = screen.getByRole("menu", { name: "flag" });
    const trueRow = within(menu).getByRole("menuitem", { name: "True" });
    expect(trueRow.querySelector(".nt-propicon-option__check")).not.toBeNull();
    // False: hollow circle tinted gray, unchecked.
    const falseRow = within(menu).getByRole("menuitem", { name: "False" });
    expect(falseRow.querySelector(".nt-propicon-option__check")).toBeNull();
    expect(falseRow.querySelector("svg")!.style.color).toContain("--color-preset-gray");
    // Value set + not required → the None clear row.
    expect(within(menu).getByRole("menuitem", { name: "None" })).not.toBeNull();
  });

  it("picking False writes the JSON boolean at idx 0 and closes the picker", async () => {
    const { client, schemaId, pageId, blockId } = await seedFlagBlock();
    await client.setProperty(blockId, schemaId, true, 0);

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "flag: True" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "flag" })).getByRole("menuitem", { name: "False" }));
    await flushWrites();

    const rows = client
      .getEffectiveProperties(blockId)
      .filter((row) => row.propertySchemaId === schemaId);
    expect(rows).toEqual([expect.objectContaining({ value: false, source: "authored", idx: 0 })]);
    expect(screen.queryByRole("menu", { name: "flag" })).toBeNull();
    expect(screen.getByRole("button", { name: "flag: False" })).not.toBeNull();
  });

  it("None clears the value", async () => {
    const { client, schemaId, pageId, blockId } = await seedFlagBlock();
    await client.setProperty(blockId, schemaId, true, 0);

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "flag: True" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "flag" })).getByRole("menuitem", { name: "None" }));
    await flushWrites();

    const rows = client
      .getEffectiveProperties(blockId)
      .filter((row) => row.propertySchemaId === schemaId && row.source === "authored");
    expect(rows).toEqual([]);
    expect(screen.getByRole("button", { name: "flag: none" })).not.toBeNull();
  });

  it("unset renders the subdued hollow affordance and sets true from the picker", async () => {
    const { client, schemaId, pageId, blockId } = await seedFlagBlock();

    render(<PageView client={client} pageId={pageId} />);
    const button = screen.getByRole("button", { name: "flag: none" });
    expect(button.className).toContain("nt-propicon--unset");

    fireEvent.click(button);
    const menu = screen.getByRole("menu", { name: "flag" });
    expect(within(menu).queryByRole("menuitem", { name: "None" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "True" }));
    await flushWrites();

    const rows = client
      .getEffectiveProperties(blockId)
      .filter((row) => row.propertySchemaId === schemaId);
    expect(rows).toEqual([expect.objectContaining({ value: true, source: "authored", idx: 0 })]);
  });
});
