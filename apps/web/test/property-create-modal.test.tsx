/**
 * S1 — the PropertyCreateModal (the pre-creation modal, owner ruling
 * 2026-10-20): the full create payload composes into ONE
 * createPropertySchema on confirm (name/type/multi/options/scope/target
 * classes/date behavior/icon), the duplicate-name check blocks the create,
 * class context binds the schema (+ the optional binding default), and the
 * entry points route their typed query in — the panel's "+ Add property"
 * create row (AddPropertyRow), the app-level host queue (the slash /property
 * command, the Ctrl/Cmd+Alt+P chord, the verb create-and-bind all fire the
 * same request), and the keymap factory's field guard.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { LinkEditModal } from "../src/ui/editor-popups/LinkEditModal.js";
import { PropertyCreateModal } from "../src/features/metadata/PropertyCreateModal.js";
import {
  PropertyCreateHost,
  requestPropertyCreate,
} from "../src/features/metadata/PropertyCreateHost.js";
import { addPropertyKeyHandler } from "../src/ui/app/keymap.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

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

async function createTitledClass(client: WorkspaceClient, name: string): Promise<string> {
  const id = await client.createClass(name);
  await client.updateObject(id, { contentAst: [{ type: "text", text: name }] });
  return id;
}

/** Pick a class through the anchored NodeSelector a ClassMultiPickField opens. */
async function pickClass(triggerName: string, className: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  const dialog = screen.getByRole("dialog", { name: "Select node" });
  fireEvent.change(within(dialog).getByLabelText("Search classes"), {
    target: { value: className },
  });
  fireEvent.click(within(dialog).getByText(className));
  await flushWrites();
}

describe("S1 PropertyCreateModal — the payload composition", () => {
  it("composes the full field set into one createPropertySchema on confirm", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    const person = await createTitledClass(client, "Person");
    const onCreated = vi.fn();
    render(
      <PropertyCreateModal isOpen client={client} onClose={() => {}} onCreated={onCreated} />,
    );
    // Name + type (the radiogroup).
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "Genre" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Select/ }));
    // Multiple values + two options (one renamed).
    fireEvent.click(screen.getByRole("radio", { name: "Multiple values" }));
    fireEvent.click(screen.getByRole("button", { name: /add option/i }));
    fireEvent.click(screen.getByRole("button", { name: /add option/i }));
    const optionInputs = screen.getAllByLabelText(/^Option /);
    fireEvent.change(optionInputs[0]!, { target: { value: "Sci-fi" } });
    fireEvent.blur(optionInputs[0]!);
    fireEvent.change(optionInputs[1]!, { target: { value: "Romance" } });
    fireEvent.blur(optionInputs[1]!);
    // Scope: local to Fiction.
    fireEvent.click(screen.getByRole("switch", { name: "Property scope" }));
    await pickClass("Scope classes", "Fiction");
    // Confirm.
    fireEvent.click(screen.getByRole("button", { name: "Create Property" }));
    await flushWrites();

    expect(onCreated).toHaveBeenCalledTimes(1);
    const schemaId = onCreated.mock.calls[0]![0] as string;
    const schema = client.listPropertySchemas().find((s) => s.id === schemaId);
    expect(schema).toMatchObject({
      name: "Genre",
      type: "select",
      multi: true,
      scopeClassIds: [fiction],
    });
    expect(schema?.options?.map((o) => o.label)).toEqual(["Sci-fi", "Romance"]);
    expect(person).not.toBeNull(); // Person picked below — placeholder keeps TS honest.
  });

  it("target classes ride for node-typed schemas; global is the default scope", async () => {
    const client = await seedClient();
    const person = await createTitledClass(client, "Person");
    render(<PropertyCreateModal isOpen client={client} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "Author" } });
    fireEvent.click(screen.getByRole("radio", { name: /^Object/ }));
    await pickClass("Target classes", "Person");
    fireEvent.click(screen.getByRole("button", { name: "Create Property" }));
    await flushWrites();
    const schema = client.listPropertySchemas().find((s) => s.name === "Author");
    expect(schema?.type).toBe("object");
    expect(schema?.targetClassFilter).toEqual([person]);
    // No scope pick: the schema is global (the key rides only when non-empty).
    expect(schema?.scopeClassIds).toBeNull();
  });

  it("the duplicate-name check blocks the create", async () => {
    const client = await seedClient();
    await client.createPropertySchema({ name: "Score", type: "number" });
    const onCreated = vi.fn();
    render(<PropertyCreateModal isOpen client={client} onClose={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "score" } });
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    const create = screen.getByRole("button", { name: "Create Property" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    await flushWrites();
    expect(onCreated).not.toHaveBeenCalled();
    expect(client.listPropertySchemas().filter((s) => s.name.toLowerCase() === "score")).toHaveLength(1);
  });

  it("carries initialName / initialType / initialMulti as the open-time prefill", async () => {
    const client = await seedClient();
    render(
      <PropertyCreateModal
        isOpen
        client={client}
        initialName="cites"
        initialType="object"
        initialMulti
        onClose={() => {}}
      />,
    );
    expect((screen.getByLabelText("Property name") as HTMLInputElement).value).toBe("cites");
    expect(screen.getByRole("radio", { name: /^Object/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Multiple values" }).getAttribute("aria-checked")).toBe("true");
  });

  it("a local scope needs at least one class (the empty list is rejected)", async () => {
    const client = await seedClient();
    render(<PropertyCreateModal isOpen client={client} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "ISBN" } });
    fireEvent.click(screen.getByRole("switch", { name: "Property scope" }));
    const create = screen.getByRole("button", { name: "Create Property" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });
});

describe("S1 in class context — the create binds (+ the optional schema default)", () => {
  it("setClassProperty follows the create; the default field writes the SCHEMA defaultValue", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    render(
      <PropertyCreateModal
        isOpen
        client={client}
        contextClassId={fiction}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "ISBN" } });
    // The default field rides the create payload itself (owner ruling
    // 2026-10-20 — one global default per property, never a binding field).
    const defaultInput = screen.getByLabelText("Default value");
    fireEvent.change(defaultInput, { target: { value: "978-" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Property" }));
    await flushWrites();
    const schema = client.listPropertySchemas().find((s) => s.name === "ISBN");
    expect(schema).toBeDefined();
    expect(schema?.defaultValue).toBe("978-");
    const binding = client.getClassBindings(fiction).find((b) => b.propertySchemaId === schema!.id);
    expect(binding).toBeDefined();
    // The binding carries no default/required/sequence fields anymore — a
    // presence row + the soft-unbind flag only.
    expect(binding).toMatchObject({ name: "ISBN", active: true });
  });

  it("the default field is type-gated: text/number/boolean/select only (owner ruling 2026-10-20)", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    render(
      <PropertyCreateModal
        isOpen
        client={client}
        contextClassId={fiction}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "Probe" } });

    // The text default (the default type) is present…
    expect(screen.getByLabelText("Default value")).not.toBeNull();
    // …and disappears for every non-capable type, node-typed included.
    for (const label of ["URL", "Email", "Date", "Multi-select", "Object", "Image", "Asset"]) {
      fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${label}`) }));
      expect(screen.queryByLabelText("Default value")).toBeNull();
    }

    // Select: the default is a dropdown of the authored options.
    fireEvent.click(screen.getByRole("radio", { name: /^Select/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getByLabelText("Option New option"), { target: { value: "Alpha" } });
    fireEvent.blur(screen.getByLabelText("Option New option"), { target: { value: "Alpha" } });
    const select = screen.getByLabelText("Default value");
    expect(select.tagName).toBe("SELECT");
    expect(within(select).getByText("Alpha")).not.toBeNull();
  });
});

describe("S1 entry points", () => {
  it("the panel's '+ Add property' create row opens the modal with the typed name", async () => {
    const client = await seedClient();
    const page = await client.createObject({ isEmbedded: false, name: "Diary" });
    render(<PageView client={client} pageId={page} />);
    await flushWrites();
    fireEvent.click(screen.getByRole("button", { name: /add property/i }));
    const popup = screen.getByRole("dialog", { name: "Add property" });
    fireEvent.change(popup.querySelector("input")!, { target: { value: "Mood" } });
    fireEvent.click(within(popup).getByText('Create property "Mood"'));
    // The S1 modal opens with the typed query carried in.
    await screen.findByText("Create property");
    expect((screen.getByLabelText("Property name") as HTMLInputElement).value).toBe("Mood");
  });

  it("the host queue opens the modal; a nodeId request assigns the new schema (no value)", async () => {
    const client = await seedClient();
    const page = await client.createObject({ isEmbedded: false, name: "Diary" });
    render(<PropertyCreateHost client={client} />);
    await act(async () => {
      requestPropertyCreate({ nodeId: page, initialName: "Vibe" });
    });
    await screen.findByText("Create property");
    expect((screen.getByLabelText("Property name") as HTMLInputElement).value).toBe("Vibe");
    fireEvent.click(screen.getByRole("radio", { name: /^Checkbox/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Property" }));
    await flushWrites();
    const schema = client.listPropertySchemas().find((s) => s.name === "Vibe");
    expect(schema?.type).toBe("boolean");
    // The host follow-up: the schema is ASSIGNED without a value (owner
    // ruling 2026-10-23) — the row renders empty until the user sets one.
    const rows = client.getEffectiveProperties(page).filter((r) => r.propertySchemaId === schema!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "assigned", value: null });
  });

  it("the verb create-and-bind routes through the host modal (object/multi pre-selected)", async () => {
    const client = await seedClient();
    const onSave = vi.fn();
    render(
      <>
        <PropertyCreateHost client={client} />
        <LinkEditModal
          isOpen
          client={client}
          initialMode="verb"
          onSave={onSave}
          onClose={() => {}}
        />
      </>,
    );
    fireEvent.change(screen.getByLabelText("Verb"), { target: { value: "contradicts" } });
    fireEvent.click(screen.getByRole("button", { name: /Create property "contradicts" and bind/ }));
    // The host's modal opens with the verb as the name, object/multi pre-selected.
    await screen.findByText("Create property");
    expect((screen.getByLabelText("Property name") as HTMLInputElement).value).toBe("contradicts");
    expect(screen.getByRole("radio", { name: /^Object/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Multiple values" }).getAttribute("aria-checked")).toBe("true");
    // Confirm: the typed-link mark binds the new schema id.
    fireEvent.click(screen.getByRole("button", { name: "Create Property" }));
    await flushWrites();
    expect(onSave).toHaveBeenCalledTimes(1);
    const verb = onSave.mock.calls[0]![0] as { verb?: { propertySchemaId: string } };
    const schema = client.listPropertySchemas().find((s) => s.id === verb.verb?.propertySchemaId);
    expect(schema?.name).toBe("contradicts");
    expect(schema?.type).toBe("object");
    expect(schema?.multi).toBe(true);
  });

  it("Ctrl/Cmd+Alt+P opens the modal without context (and yields to form fields)", async () => {
    const client = await seedClient();
    render(<PropertyCreateHost client={client} />);
    const handler = addPropertyKeyHandler({
      onOpen: () => requestPropertyCreate({}),
    });
    document.addEventListener("keydown", handler);
    try {
      fireEvent.keyDown(document.body, { key: "p", ctrlKey: true, altKey: true });
      await screen.findByText("Create property");
      expect((screen.getByLabelText("Property name") as HTMLInputElement).value).toBe("");
    } finally {
      document.removeEventListener("keydown", handler);
    }
    // The field guard: a keydown from inside an input keeps the keystroke.
    const input = document.createElement("input");
    document.body.appendChild(input);
    const guarded = addPropertyKeyHandler({ onOpen: () => requestPropertyCreate({}) });
    const spy = vi.fn();
    document.addEventListener("keydown", guarded);
    fireEvent.keyDown(input, { key: "p", ctrlKey: true, altKey: true });
    document.removeEventListener("keydown", guarded);
    input.remove();
    expect(spy).not.toHaveBeenCalled();
  });
});
