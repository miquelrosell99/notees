/**
 * TemplateGallery + apply-to-existing tests (§34.25 T3/T4):
 *
 * - Gallery smoke: the modal lists every template-class node (flat, the
 *   ONE-class surface), the search filters, keyboard Enter on the highlight
 *   creates-with-template (the register's keyboard create-with-template) and
 *   opens the fresh page, and the "New template" row authors a classed page.
 * - Apply-to-existing (TemplatesSection, the D1 amendment path): the card's
 *   apply affordance grafts the template onto a picked node and writes
 *   generatedFrom; a node already generated from the template is skipped
 *   (the A4 merge marker).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { TemplatesSection } from "../src/ui/components/classview/TemplatesSection.js";
import { TemplateGalleryModal } from "../src/ui/templates/TemplateGalleryModal.js";
import { ensureTemplateProperty } from "../src/ui/components/templateFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000c1";
const ACTOR = "0192a000-0000-7000-8000-0000000000c2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  window.localStorage.clear();
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

/** A template page with one child block, classed `template`. */
async function createTemplate(client: WorkspaceClient, name: string, childText = "Recurring agenda") {
  const templateId = await client.createObject({
    presentAsMain: true,
    name,
    classIds: [SYSTEM_CLASS_UUIDS.template],
  });
  await client.createObject({ parentId: templateId, contentAst: [{ type: "text", text: childText }] });
  return templateId;
}

describe("TemplateGalleryModal (§34.25 T3)", () => {
  it("lists all templates flat; search filters; Enter uses the highlighted template (keyboard create-with-template)", async () => {
    const client = await seedClient();
    await createTemplate(client, "Meeting template");
    await createTemplate(client, "Reading template");
    const onOpenPage = vi.fn();
    render(<TemplateGalleryModal isOpen onClose={() => {}} client={client} onOpenPage={onOpenPage} />);

    const list = await screen.findByRole("listbox", { name: "Templates" });
    expect(within(list).getByText("Meeting template")).toBeInTheDocument();
    expect(within(list).getByText("Reading template")).toBeInTheDocument();

    // Search narrows the list.
    const search = screen.getByRole("textbox", { name: "Search templates" });
    fireEvent.change(search, { target: { value: "read" } });
    expect(within(list).queryByText("Meeting template")).toBeNull();
    expect(within(list).getByText("Reading template")).toBeInTheDocument();

    // Keyboard create-with-template: Enter uses the highlighted row and
    // opens the fresh page.
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    const createdId = onOpenPage.mock.calls[0]![0] as string;
    const created = client.getNode(createdId)!;
    expect(created.contentAst).toEqual([{ type: "text", text: "Reading template" }]);
    expect(created.classIds).not.toContain(SYSTEM_CLASS_UUIDS.template);
    const generatedFrom = client
      .getEffectiveProperties(createdId)
      .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.generatedFrom);
    expect(generatedFrom?.value).toMatchObject({ nodeId: expect.stringMatching(/.+/) });
  });

  it("the row click opens the template; 'Use template' instantiates; 'New template' authors a classed page", async () => {
    const client = await seedClient();
    const templateId = await createTemplate(client, "Base template");
    const onOpenPage = vi.fn();
    render(<TemplateGalleryModal isOpen onClose={() => {}} client={client} onOpenPage={onOpenPage} />);

    const list = await screen.findByRole("listbox", { name: "Templates" });
    // Row click = Open (templates are ordinary pages).
    fireEvent.click(within(list).getByText("Base template"));
    expect(onOpenPage).toHaveBeenCalledWith(templateId);

    // Use template = create-with-template.
    fireEvent.click(within(list).getByRole("button", { name: "Use template" }));
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(2));
    const createdId = onOpenPage.mock.calls[1]![0] as string;
    expect(createdId).not.toBe(templateId);
    expect(client.getChildren(createdId)).toHaveLength(1);

    // New template authors a classed page and opens it.
    fireEvent.click(screen.getByRole("button", { name: "＋ New template" }));
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(3));
    const newId = onOpenPage.mock.calls[2]![0] as string;
    expect(client.getNode(newId)!.classIds).toContain(SYSTEM_CLASS_UUIDS.template);
  });
});

describe("TemplatesSection apply-to-existing (§34.25 T4, D1 amendment)", () => {
  async function setupClassWithTemplate() {
    const client = await seedClient();
    const classId = await client.createClass("meeting");
    const templateId = await createTemplate(client, "Sync template");
    await ensureTemplateProperty(client);
    await client.setProperty(classId, SYSTEM_PROPERTY_UUIDS.hasTemplate, { nodeId: templateId }, 0);
    return { client, classId, templateId };
  }

  it("the card's apply affordance grafts the template onto a picked node and writes generatedFrom", async () => {
    const { client, classId, templateId } = await setupClassWithTemplate();
    const targetId = await client.createObject({ presentAsMain: true, name: "Existing notes" });
    const onOpenPage = vi.fn();
    const { container } = render(
      <TemplatesSection client={client} classId={classId} onOpenPage={onOpenPage} />,
    );

    // The section renders collapsed-once-bound; expand it.
    fireEvent.click(screen.getByRole("button", { name: /Templates/ }));
    const applyButton = await screen.findByRole("button", { name: "Apply template Sync template to a node" });
    fireEvent.click(applyButton);

    // The node picker opens over all nodes; pick the existing one.
    const picker = await screen.findByRole("dialog", { name: "Select node" });
    fireEvent.change(within(picker).getByRole("textbox"), { target: { value: "Existing" } });
    fireEvent.click(await within(picker).findByText("Existing notes"));

    await waitFor(() => {
      const generatedFrom = client
        .getEffectiveProperties(targetId)
        .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.generatedFrom);
      expect(generatedFrom?.source).toBe("authored");
      expect(generatedFrom?.value).toEqual({ nodeId: templateId });
    });
    // The graft landed: the template's child block was cloned beneath the node.
    expect(client.getChildren(targetId).map((child) => child.contentAst)).toEqual([
      [{ type: "text", text: "Recurring agenda" }],
    ]);
    expect(container.textContent).toContain("Sync template");
  });

  it("a node already generated from the template is skipped (the A4 merge marker)", async () => {
    const { client, classId, templateId } = await setupClassWithTemplate();
    const targetId = await client.createObject({ presentAsMain: true, name: "Existing notes" });
    render(<TemplatesSection client={client} classId={classId} onOpenPage={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Templates/ }));

    // First apply: three writes (update + child create + generatedFrom).
    const apply = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Apply template Sync template to a node" }));
      const picker = await screen.findByRole("dialog", { name: "Select node" });
      fireEvent.change(within(picker).getByRole("textbox"), { target: { value: "Existing" } });
      fireEvent.click(await within(picker).findByText("Existing notes"));
      await waitFor(() => {
        expect(
          client
            .getEffectiveProperties(targetId)
            .some((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.generatedFrom),
        ).toBe(true);
      });
    };
    await apply();
    const childCountAfterFirst = client.getChildren(targetId).length;

    // Second apply: skipped — no duplicated children, no second generatedFrom row.
    await apply();
    expect(client.getChildren(targetId)).toHaveLength(childCountAfterFirst);
    const generatedRows = client
      .getEffectiveProperties(targetId)
      .filter((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.generatedFrom);
    expect(generatedRows).toHaveLength(1);
    expect(client.getNode(targetId)!.contentAst).toEqual([
      { type: "text", text: "Existing notes" },
    ] as ContentAst);
  });

  it("Browse gallery opens the gallery modal from the class page", async () => {
    const { client, classId } = await setupClassWithTemplate();
    await createTemplate(client, "Gallery-visible template");
    render(<TemplatesSection client={client} classId={classId} onOpenPage={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Templates/ }));

    fireEvent.click(screen.getByRole("button", { name: "Browse gallery" }));
    const gallery = await screen.findByRole("listbox", { name: "Templates" });
    expect(within(gallery).getByText("Gallery-visible template")).toBeInTheDocument();
  });
});
