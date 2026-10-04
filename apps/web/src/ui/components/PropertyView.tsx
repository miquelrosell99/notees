/**
 * PropertyView — a property schema's inspector surface (§34.32 PG12). v2
 * schemas are registry rows, not nodes, so the "property page" is this
 * modal: the schema's metadata (type, cardinality, scope, date behavior,
 * options, target classes), its bound classes, and the references section —
 * every node carrying an AUTHORED value for the schema (the population the
 * server exposes as GET /properties/:id/values; here a pure local read,
 * store.propertyValueCarriers, so the listing is exact offline).
 *
 * Entry point: the property settings modal's "Open property" button (the
 * property-label click in the metadata table opens the settings modal; the
 * modal hosts the path here).
 */

import { useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { NodeCollection } from "../views/index.js";
import type { TableColumn } from "../views/index.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { PropertyConvertModal } from "./PropertyConvertModal.js";
import "./PropertyView.css";

type AnyClient = WorkspaceClient | WorkerClient;

function ClassPill({
  client,
  classNode,
  onOpenPage,
}: {
  client: AnyClient;
  classNode: ClientNode;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const label = displayNameFromClient(client, classNode.id) ?? classNode.id;
  return (
    <span className="pill">
      {classNode.icon !== null && classNode.icon !== "" && (
        <span className="pill__left-icon">
          <Icon path={classNode.icon} size={0.7} />
        </span>
      )}
      <button
        type="button"
        className="pill__text"
        onClick={() => onOpenPage?.(classNode.id)}
      >
        {label}
      </button>
    </span>
  );
}

export function PropertyView({
  client,
  propertySchemaId,
  onClose,
  onOpenPage,
}: {
  client: AnyClient;
  propertySchemaId: string;
  onClose: () => void;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const schema = client.listPropertySchemas().find((s) => s.id === propertySchemaId);
  const [convertOpen, setConvertOpen] = useState(false);
  if (schema === undefined) return null;

  const boundClasses = client
    .listClasses()
    .filter((klass) =>
      client.getClassBindings(klass.id).some((b) => b.propertySchemaId === propertySchemaId),
    );
  const targetClassIds = schema.targetClassFilter ?? [];
  const references = client.getPropertyReferences(propertySchemaId);

  const referenceColumns: TableColumn[] = [
    { id: "name", kind: "name", label: "Name", sortable: true },
    {
      id: propertySchemaId,
      kind: "property",
      label: schema.name,
      propertySchemaId,
      sortable: true,
    },
  ];

  return (
    <Modal isOpen onClose={onClose} size="lg" showCloseButton={false} className="nt-property-view">
      <div className="modal__header">
        <h2 className="modal__title">{schema.name}</h2>
        <button
          type="button"
          aria-label="Close modal"
          className="btn btn--ghost btn--sm btn--icon-only modal__close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="modal__content">
        <p className="nt-property-view__type">
          {schema.type}
          {schema.multi ? " · multi" : ""} · {schema.scope}
        </p>
        {(schema.type === "date" || schema.type === "date_range") && (
          <p className="nt-property-view__meta">
            Precision: {schema.datePrecision ?? "day"}
            {schema.type === "date" && schema.dateQualified === true ? " · qualified (start/end allowed)" : ""}
          </p>
        )}
        {schema.type === "object" && schema.dateQualified === true && (
          <p className="nt-property-view__meta">Qualified — values may carry start/end dates.</p>
        )}
        {targetClassIds.length > 0 && (
          <div className="nt-property-view__row">
            <span className="section-label">Targets:</span>
            <span className="nt-property-view__pills">
              {targetClassIds.map((classId) => {
                const target = client.getNode(classId);
                return target !== undefined ? (
                  <ClassPill key={classId} client={client} classNode={target} onOpenPage={onOpenPage} />
                ) : (
                  <span key={classId} className="pill">
                    <span className="pill__text">{classId}</span>
                  </span>
                );
              })}
            </span>
          </div>
        )}
        {schema.options !== null && schema.options.length > 0 && (
          <div className="nt-property-view__row">
            <span className="section-label">Options:</span>
            <span className="nt-property-view__pills">
              {schema.options.map((option) => (
                <span key={option.id} className="pill">
                  <span className="pill__text">{option.label}</span>
                </span>
              ))}
            </span>
          </div>
        )}

        <NodeViewSection
          title="Bound classes"
          icon={<Icon path="mdi-shape-outline" size={0.9} />}
          count={boundClasses.length}
          defaultExpanded
        >
          {boundClasses.length === 0 ? (
            <p className="nt-property-view__meta">Not bound to any class (unbound authored values only).</p>
          ) : (
            <span className="nt-property-view__pills">
              {boundClasses.map((klass) => (
                <ClassPill key={klass.id} client={client} classNode={klass} onOpenPage={onOpenPage} />
              ))}
            </span>
          )}
        </NodeViewSection>

        <NodeViewSection
          title="References"
          icon={<Icon path="mdi-link-variant" size={0.9} />}
          count={references.length}
          defaultExpanded
        >
          <NodeCollection
            viewMode="table"
            client={client}
            items={references.map((node) => ({ node }))}
            tableColumns={referenceColumns}
            propertiesOf={(nodeId) =>
              client.getEffectiveProperties(nodeId).filter((p) => p.propertySchemaId === propertySchemaId)
            }
            readOnly
            onNodeClick={(id) => onOpenPage?.(id)}
            emptyTitle="No references yet"
            emptyHint="Nodes carrying an authored value for this property will list here."
          />
        </NodeViewSection>

        <div className="nt-property-view__actions">
          {/* PG3: the blessed delete+recreate conversion flow (same modal as
              the settings modal's entry point). */}
          <Button variant="ghost" size="sm" onClick={() => setConvertOpen(true)}>
            Convert…
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {convertOpen && (
        <PropertyConvertModal client={client} schema={schema} onClose={() => setConvertOpen(false)} />
      )}
    </Modal>
  );
}
