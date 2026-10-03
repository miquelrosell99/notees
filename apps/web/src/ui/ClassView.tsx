/**
 * ClassView — the class projection (SCHEMA.md render cascade, first branch):
 * a class page IS a page (`.plans/design/05-class-view-redesign.md`): the
 * standard PageView chrome and the class's child blocks as the editable
 * body, composed with class-relevant sections:
 *
 * - corner: ExtendsRow — the class's PARENT classes as pills (class-only
 *   picker; class.setExtends replace semantics, loud cycle failure).
 * - header actions: the class color dot (ColorButton picker; §34.43 grammar);
 *   the curated ClassIconButton replaces the page icon picker.
 * - sections: ClassedNodesSection (the instances table — the class page's
 *   centerpiece), PropertyDefinitionsSection (the schema editor),
 *   TemplatesSection (assigned template cards).
 * - system sections: ExtendedBySection + the standard SystemSections
 *   (child pages, linked/unlinked references).
 *
 * What went away with the redesign: the Description panel (title-is-content
 * — the title IS the content), the Extends/Extended-by admin panels, the
 * always-visible color swatch strip, and the read-only Blocks section (the
 * body is the editable page tree now).
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { PageView } from "./PageView.js";
import { ColorButton } from "./components/ui/ColorButton.js";
import { ClassedNodesSection } from "./components/classview/ClassedNodesSection.js";
import { ClassIconButton } from "./components/classview/ClassIconButton.js";
import { ExtendedBySection } from "./components/classview/ExtendedBySection.js";
import { ExtendsRow } from "./components/classview/ExtendsRow.js";
import { PropertyDefinitionsSection } from "./components/classview/PropertyDefinitionsSection.js";
import { SystemSections } from "./components/SystemSections.js";
import { TemplatesSection } from "./components/classview/TemplatesSection.js";

export function ClassView({
  client,
  classId,
  onOpenClass,
  onOpenPage,
}: {
  client: WorkspaceClient | WorkerClient;
  classId: string;
  /** Class navigation (extends pills, extended-by rows). */
  onOpenClass?: ((classId: string) => void) | undefined;
  /** Member/template navigation (members resolve to their containing page). */
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  /** The setClassExtends failure (extends cycles fail loud in the store). */
  const [extendsError, setExtendsError] = useState<string | null>(null);
  useEffect(() => {
    if (extendsError === null) return;
    const timer = setTimeout(() => setExtendsError(null), 4000);
    return () => clearTimeout(timer);
  }, [extendsError]);

  const node = client.getNode(classId);
  if (node === undefined || !node.isClass) {
    return <div className="nt-page-missing">Class not found.</div>;
  }

  return (
    <PageView
      client={client}
      pageId={classId}
      onOpenPage={onOpenPage}
      forClass
      rootClassName="nt-class"
      corner={
        <ExtendsRow
          client={client}
          classId={classId}
          onOpenClass={onOpenClass}
          onError={setExtendsError}
        />
      }
      iconButton={<ClassIconButton client={client} classId={classId} icon={node.icon} />}
      headerActions={
        <ColorButton
          color={node.color ?? "var(--color-surface-container-highest)"}
          size="sm"
          showPicker
          showNoneOption
          title="Class color"
          aria-label="Class color"
          onColorChange={(color) => void client.updateObject(classId, { color })}
        />
      }
      notice={
        extendsError !== null ? (
          <div role="alert" className="nt-dnd-error">
            {extendsError}
          </div>
        ) : null
      }
      sections={
        <>
          <ClassedNodesSection key="classed-nodes" client={client} classId={classId} onOpenPage={onOpenPage} />
          <PropertyDefinitionsSection key="property-definitions" client={client} classId={classId} />
          <TemplatesSection key="templates" client={client} classId={classId} onOpenPage={onOpenPage} />
        </>
      }
      systemSections={
        <>
          <ExtendedBySection key="extended-by" client={client} classId={classId} onOpenClass={onOpenClass} />
          <SystemSections client={client} pageId={classId} onOpenPage={onOpenPage} />
        </>
      }
    />
  );
}
