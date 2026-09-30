/**
 * ClassView — the class projection (SCHEMA.md view resolution f(node_type):
 * `class` → Class View): page chrome (editable name via TitleEditor, minimal
 * icon text input + preset color swatches) PLUS the class panels:
 *
 * - Extends: the m2m parent classes as chips (link to their Class Views,
 *   removable) plus an add-parent picker over the workspace's classes.
 *   Writes go through `class.setExtends` (replace semantics); the store's
 *   CycleError surfaces as a transient banner.
 * - Property bindings: EDITABLE — bound property schemas in sequence order
 *   (registry rows authored by class.property.set; the designed system seeds
 *   fill unbound schemas). Per-binding default/required/readonly/
 *   hideWhenEmpty editors patch via class.property.set (missing fields keep
 *   their values), remove writes class.property.unset, and an add-binding
 *   picker binds existing property schemas (class.property.set).
 * - Description shelf: the class node's own content, read-only for M1.
 * - Classed nodes: lazy per the section contract — no member query until the
 *   section first expands. Members link to their page (blocks resolve to
 *   their containing page); each row's × unassigns the member from THIS
 *   class (class.unassign).
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings, displayNameFromClient } from "./dateDisplay.js";
import { Icon } from "./Icon.js";
import { InlineTokens } from "./InlineTokens.js";
import { Section } from "./Section.js";
import { TitleEditor } from "./TitleEditor.js";
import { OutlinerContext, useOutlinerValue } from "./outliner-context.js";

/** Preset class-color swatches (the design system's accent scale). */
const CLASS_COLORS = ["#b42318", "#b54708", "#067647", "#175cd3", "#6941c6", "#c11574", "#475467"];

/** Curated icon set for the class icon picker (mdi names, sprite-served). */
const CLASS_ICONS = [
  "mdiAccount", "mdiAccountGroup", "mdiArchive", "mdiBook", "BookOpenVariant",
  "mdiBookmark", "mdiBriefcase", "mdiCalendar", "mdiCalendarClock", "mdiCardText",
  "mdiCheckboxMarkedCircleOutline", "mdiClipboardText", "mdiClockOutline", "mdiCog",
  "mdiEmail", "mdiFileDocument", "mdiFlag", "mdiFolder", "mdiFormatListBulleted",
  "mdiFormatListChecks", "mdiHeart", "mdiHome", "mdiImage", "mdiLabel", "mdiLightbulb",
  "mdiLink", "mdiMapMarker", "mdiMicroscope", "mdiMovie", "mdiMusicNote", "mdiNotebook",
  "mdiPackage", "mdiPhone", "mdiPound", "mdiPresentation", "mdiScriptText", "mdiShape",
  "mdiStar", "mdiTag", "mdiTestTube", "mdiTooth", "mdiTrayArrowDown", "mdiWeb",
].map((name) => (name.startsWith("mdi") ? name : `mdi${name}`));

/** Icon button + popup grid: picks the class icon (or clears it). */
function ClassIconButton({
  client,
  classId,
  icon,
}: {
  client: WorkspaceClient | WorkerClient;
  classId: string;
  icon: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered =
    query.trim() === ""
      ? CLASS_ICONS
      : CLASS_ICONS.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <span className="nt-class-iconpicker">
      <button
        type="button"
        className="nt-class-iconbtn"
        title="Class icon"
        aria-label="Class icon"
        onClick={() => setOpen((value) => !value)}
      >
        {icon !== null && icon !== "" ? (
          <Icon path={icon} size={1.4} />
        ) : (
          <Icon path="mdi-dots-grid" size={1.2} />
        )}
      </button>
      {open && (
        <span className="nt-class-iconpop" role="dialog" aria-label="Choose class icon">
          <input
            autoFocus
            value={query}
            placeholder="Search icons…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="nt-class-icons">
            {filtered.map((name) => (
              <button
                key={name}
                type="button"
                className={name === icon ? "nt-class-iconopt nt-class-iconopt-active" : "nt-class-iconopt"}
                title={name}
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  void client.updateObject(classId, { icon: name });
                }}
              >
                <Icon path={name} size={1} />
              </button>
            ))}
          </span>
          <button
            type="button"
            className="nt-class-iconclear"
            onClick={() => {
              setOpen(false);
              void client.updateObject(classId, { icon: "" });
            }}
          >
            No icon
          </button>
        </span>
      )}
    </span>
  );
}

export function ClassView({
  client,
  classId,
  onOpenClass,
  onOpenPage,
}: {
  client: WorkspaceClient | WorkerClient;
  classId: string;
  /** Class navigation (extends chips, class list entries). */
  onOpenClass?: ((classId: string) => void) | undefined;
  /** Member navigation: a member's page (blocks resolve to containing page). */
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const outliner = useOutlinerValue(client, classId, {
    // f(node_type) navigation for query result lists: a class opens the Class
    // View, anything else the Page View.
    openNode: (id) => {
      const target = client.getNode(id);
      if (target !== undefined && target.nodeType === "class") onOpenClass?.(id);
      else onOpenPage?.(id);
    },
  });
  const [extendsError, setExtendsError] = useState<string | null>(null);
  useEffect(() => {
    if (extendsError === null) return;
    const timer = setTimeout(() => setExtendsError(null), 4000);
    return () => clearTimeout(timer);
  }, [extendsError]);

  const node = client.getNode(classId);
  if (node === undefined || node.nodeType !== "class") {
    return <div className="nt-page-missing">Class not found.</div>;
  }

  const parents = client.getClassParents(classId);
  const bindings = client.getClassBindings(classId);
  const boundSchemaIds = new Set(bindings.map((b) => b.propertySchemaId));
  const schemaCandidates = client.listPropertySchemas().filter((s) => !boundSchemaIds.has(s.id));
  const candidates = client
    .listClasses()
    .filter((candidate) => candidate.id !== classId && !parents.includes(candidate.id));

  /** Replace the extends set; the store fails loud on cycles. */
  const replaceExtends = async (nextParentIds: string[]) => {
    try {
      await client.setClassExtends(classId, nextParentIds);
    } catch (err) {
      setExtendsError(err instanceof Error ? err.message : "Failed to update extends");
    }
  };

  /** A member opens its page; a block member resolves to its containing page. */
  const openMember = (member: ClientNode) => {
    if (member.nodeType === "page") {
      onOpenPage?.(member.id);
      return;
    }
    const seen = new Set<string>([member.id]);
    let current = client.getNode(member.parentId ?? "");
    while (current !== undefined && current.nodeType !== "page" && !seen.has(current.id)) {
      seen.add(current.id);
      current = current.parentId !== null ? client.getNode(current.parentId) : undefined;
    }
    onOpenPage?.(current !== undefined && current.nodeType === "page" ? current.id : member.id);
  };

  return (
    <OutlinerContext.Provider value={outliner}>
      <div className="nt-page nt-class">
        <header className="nt-page-header">
          <div className="nt-class-title">
            <ClassIconButton client={client} classId={classId} icon={node.icon} />
            <TitleEditor page={node} />
          </div>
          <div className="nt-page-toolbar">
            <div className="nt-class-colors" role="group" aria-label="Class color">
              {CLASS_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={
                    node.color === color ? "nt-class-swatch nt-class-swatch-active" : "nt-class-swatch"
                  }
                  style={{ background: color }}
                  aria-label={`Set color ${color}`}
                  onClick={() => void client.updateObject(classId, { color })}
                />
              ))}
            </div>
          </div>
        </header>

        {extendsError !== null && (
          <div role="alert" className="nt-dnd-error">
            {extendsError}
          </div>
        )}

        <section className="nt-class-panel">
          <h2 className="nt-class-panel-title">Extends</h2>
          {parents.length === 0 ? (
            <span className="nt-class-empty">No parent classes.</span>
          ) : (
            <ul className="nt-class-chips">
              {parents.map((parentId) => {
                const parent = client.getNode(parentId);
                const label = parent !== undefined ? (displayNameForSettings(parent) ?? parentId) : parentId;
                return (
                  <li key={parentId} className="nt-class-chip">
                    <button
                      type="button"
                      className="nt-class-chip-link"
                      onClick={() => onOpenClass?.(parentId)}
                    >
                      {label}
                    </button>
                    <button
                      type="button"
                      className="nt-class-chip-remove"
                      aria-label={`Remove parent ${label}`}
                      onClick={() => void replaceExtends(parents.filter((id) => id !== parentId))}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {candidates.length > 0 && (
            <select
              className="nt-class-add-parent"
              aria-label="Add parent class"
              value=""
              onChange={(event) => {
                const parentId = event.target.value;
                if (parentId !== "") void replaceExtends([...parents, parentId]);
              }}
            >
              <option value="" disabled>
                Add parent class…
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {displayNameForSettings(candidate) ?? candidate.id}
                </option>
              ))}
            </select>
          )}
        </section>

        <section className="nt-class-panel">
          <h2 className="nt-class-panel-title">Property bindings</h2>
          {bindings.length === 0 ? (
            <span className="nt-class-empty">No property bindings.</span>
          ) : (
            <ul className="nt-class-bindings">
              {bindings.map((binding) => (
                <li key={binding.propertySchemaId} className="nt-class-binding">
                  <input
                    key={`seq:${binding.propertySchemaId}:${binding.sequence}`}
                    type="number"
                    className="nt-class-binding-seq"
                    defaultValue={binding.sequence}
                    aria-label={`Sequence for ${binding.name}`}
                    onBlur={(event) => {
                      const next = Number.parseInt(event.target.value, 10);
                      if (Number.isFinite(next) && next !== binding.sequence) {
                        void client.setClassProperty(classId, binding.propertySchemaId, {
                          sequence: next,
                        });
                      }
                    }}
                  />
                  <span className="nt-class-binding-name">{binding.name}</span>
                  <span className="nt-class-binding-type">
                    {binding.type}
                    {binding.multi ? " · multi" : ""}
                  </span>
                  {binding.targetClassFilter !== null && (
                    <span className="nt-class-binding-target">→ {binding.targetClassFilter.join(", ")}</span>
                  )}
                  <input
                    key={`def:${binding.propertySchemaId}:${binding.defaultValue ?? ""}`}
                    type="text"
                    className="nt-class-binding-default"
                    placeholder="default"
                    defaultValue={binding.defaultValue ?? ""}
                    aria-label={`Default for ${binding.name}`}
                    onBlur={(event) => {
                      const value = event.target.value;
                      if (value !== (binding.defaultValue ?? "")) {
                        void client.setClassProperty(classId, binding.propertySchemaId, {
                          defaultValue: value,
                        });
                      }
                    }}
                  />
                  {(
                    [
                      ["required", "Required", binding.required],
                      ["readonly", "Readonly", binding.readonly],
                      ["hideWhenEmpty", "Hide when empty", binding.hideWhenEmpty],
                    ] as const
                  ).map(([field, label, current]) => (
                    <label key={field} className="nt-class-binding-flag">
                      <input
                        type="checkbox"
                        checked={current === true}
                        aria-label={`${label} for ${binding.name}`}
                        onChange={(event) => {
                          void client.setClassProperty(classId, binding.propertySchemaId, {
                            [field]: event.target.checked,
                          });
                        }}
                      />
                      {label}
                    </label>
                  ))}
                  {(binding.type === "date" || binding.type === "date_range") && (
                    <label className="nt-class-binding-flag">
                      Precision
                      <select
                        className="nt-class-binding-precision"
                        aria-label={`Date precision for ${binding.name}`}
                        value={binding.datePrecision ?? "day"}
                        onChange={(event) => {
                          void client.updatePropertySchema(binding.propertySchemaId, {
                            datePrecision: event.target.value as "year" | "month" | "day",
                          });
                        }}
                      >
                        <option value="day">day</option>
                        <option value="month">month</option>
                        <option value="year">year</option>
                      </select>
                    </label>
                  )}
                  {binding.type === "object" && (
                    <label className="nt-class-binding-flag">
                      <input
                        type="checkbox"
                        checked={binding.dateQualified === true}
                        aria-label={`Date qualified for ${binding.name}`}
                        onChange={(event) => {
                          void client.updatePropertySchema(binding.propertySchemaId, {
                            dateQualified: event.target.checked,
                          });
                        }}
                      />
                      Date qualified
                    </label>
                  )}
                  <button
                    type="button"
                    className="nt-class-binding-remove"
                    aria-label={`Remove binding ${binding.name}`}
                    onClick={() =>
                      void client.unsetClassProperty(classId, binding.propertySchemaId)
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {schemaCandidates.length > 0 && (
            <select
              className="nt-class-add-binding"
              aria-label="Add property binding"
              value=""
              onChange={(event) => {
                const propertySchemaId = event.target.value;
                if (propertySchemaId !== "") {
                  void client.setClassProperty(classId, propertySchemaId, {
                    sequence: bindings.length,
                  });
                }
              }}
            >
              <option value="" disabled>
                Add property binding…
              </option>
              {schemaCandidates.map((schema) => (
                <option key={schema.id} value={schema.id}>
                  {schema.name}
                </option>
              ))}
            </select>
          )}
        </section>

        <section className="nt-class-panel">
          <h2 className="nt-class-panel-title">Description</h2>
          {node.contentAst.length === 0 ? (
            <span className="nt-class-empty">No description.</span>
          ) : (
            <div className="nt-class-description-body">
              <InlineTokens tokens={node.contentAst} resolveName={(id) => displayNameFromClient(client, id)} />
            </div>
          )}
        </section>

        <div className="nt-page-sections">
          <Section
            client={client}
            title="Classed nodes"
            load={() => client.getClassMembers(classId)}
            emptyText="No classed nodes."
            renderResults={(members) => (
              <ul className="nt-section-list">
                {members.map((member) => {
                  const label = displayNameForSettings(member) ?? member.id;
                  return (
                    <li key={member.id} className="nt-class-member">
                      <button type="button" className="nt-section-item" onClick={() => openMember(member)}>
                        <span className="nt-bullet" aria-hidden="true">
                          •
                        </span>
                        <span>{label}</span>
                      </button>
                      <button
                        type="button"
                        className="nt-class-member-remove"
                        aria-label={`Remove ${label} from ${node.name ?? "this class"}`}
                        onClick={() => void client.unassignClass(member.id, classId)}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          />
        </div>
      </div>
    </OutlinerContext.Provider>
  );
}
