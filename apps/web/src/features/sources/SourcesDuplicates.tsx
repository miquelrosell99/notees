/**
 * SourcesDuplicates — the Sources hub's Duplicates mode (task 13): the
 * middle cell's alternative to the items table. Renders task 12's
 * groupSourceDuplicates clusters as grouped lists over the hub's loaded
 * row projection (the SAME filtered set the table shows — the type facet
 * and the search box narrow the grouping input), each group carrying a
 * header that names the match basis (the shared identifier, or the fuzzy
 * title match), the member rows reading the row projection's cells
 * (title, authors, year, citekey, DOI), and ONE Merge button per group
 * opening the MergeDuplicatesModal.
 *
 * The pane owns the modal state; a successful merge re-reads through the
 * hub's subscription loop — the merged group disappears on refresh. The
 * honest "No duplicates" empty state rides the kit EmptyState.
 */

import { useMemo, useState } from "react";

import type { AnyClient } from "../../ui/app/clients.js";
import { Icon } from "../../ui/Icon.js";
import { Button, EmptyState, Spinner } from "../../components/ui/kit/index.js";
import { groupSourceDuplicates, type SourceDuplicateGroup } from "./duplicates.js";
import type { SourceRow } from "./sourcesQuery.js";
import { MergeDuplicatesModal } from "../modals/MergeDuplicatesModal.js";
import "./SourcesDuplicates.css";

/**
 * The group's match basis, named for the header: the shared identifier
 * when EVERY member carries the same normalized DOI / ISBN / citekey
 * (the duplicates.ts normalization idiom), else the fuzzy title match.
 */
function basisOf(members: SourceRow[]): { label: string; detail: string | null } {
  const shared = (
    read: (row: SourceRow) => string,
    normalize: (value: string) => string,
  ): string | null => {
    const values = members.map((member) => normalize(read(member)));
    if (values.some((value) => value === "")) return null;
    return new Set(values).size === 1 ? values[0]! : null;
  };
  const doi = shared((row) => row.doi, (value) => value.trim().toLowerCase());
  if (doi !== null) return { label: "Matching DOI", detail: doi };
  const isbn = shared(
    (row) => row.isbn,
    (value) => value.trim().replace(/[^0-9x]/gi, "").toUpperCase(),
  );
  if (isbn !== null) return { label: "Matching ISBN", detail: isbn };
  const citekey = shared((row) => row.citekey, (value) => value.trim().toLowerCase());
  if (citekey !== null) return { label: "Matching citekey", detail: citekey };
  return { label: "Similar title", detail: null };
}

export function SourcesDuplicates({
  client,
  rows,
  loading,
}: {
  client: AnyClient;
  /** The hub's filtered display rows (null = the first read is in flight). */
  rows: SourceRow[] | null;
  /** The first library read is in flight (the spinner state). */
  loading: boolean;
}) {
  const [mergeGroup, setMergeGroup] = useState<SourceDuplicateGroup | null>(null);
  const groups = useMemo(() => (rows === null ? null : groupSourceDuplicates(rows)), [rows]);

  if (loading || groups === null) {
    return (
      <div className="nt-sources-hub__table nt-sources-dup" role="region" aria-label="Source duplicates">
        <Spinner />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="nt-sources-hub__table nt-sources-dup" role="region" aria-label="Source duplicates">
        <EmptyState
          icon={<Icon path="mdi-content-duplicate" size={2} />}
          title="No duplicates"
          description="No two sources share a DOI, ISBN, citekey, or a similar title."
        />
      </div>
    );
  }

  return (
    <div className="nt-sources-hub__table nt-sources-dup" role="region" aria-label="Source duplicates">
      <ul className="nt-sources-dup__list">
        {groups.map((group) => {
          const basis = basisOf(group.members);
          return (
            <li key={group.members[0]!.id} className="nt-sources-dup__group">
              <div className="nt-sources-dup__group-head">
                <h3 className="nt-sources-dup__group-title">
                  {basis.label}
                  {basis.detail !== null && (
                    <span className="nt-sources-dup__group-detail">{basis.detail}</span>
                  )}
                </h3>
                <span className="nt-sources-dup__group-count">
                  {group.members.length} {group.members.length === 1 ? "source" : "sources"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMergeGroup(group)}
                  aria-label={`Merge ${basis.label} group`}
                >
                  Merge
                </Button>
              </div>
              <ul className="nt-sources-dup__members">
                {group.members.map((member) => (
                  <li key={member.id} className="nt-sources-dup__member">
                    <span className="nt-sources-dup__member-title">{member.title}</span>
                    <span className="nt-sources-dup__member-authors">{member.authorsText}</span>
                    <span className="nt-sources-dup__member-year">{member.year ?? ""}</span>
                    <span className="nt-sources-dup__member-citekey">{member.citekey}</span>
                    <span className="nt-sources-dup__member-doi">{member.doi}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>

      {mergeGroup !== null && (
        <MergeDuplicatesModal
          isOpen
          client={client}
          group={mergeGroup}
          onClose={() => setMergeGroup(null)}
          onMerged={() => setMergeGroup(null)}
        />
      )}
    </div>
  );
}
