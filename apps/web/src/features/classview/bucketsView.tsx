/**
 * BucketsView — the bucketed tasks surface (TaskBuckets) as a REGISTERED
 * collection view (the view-registry seam): the tasks hub offers it as its
 * default mode, so the hub shows EXACTLY ONE surface — the Buckets list when
 * that mode is selected, the chosen view otherwise (the register's
 * either/or ruling; the retired `prepend` stacked the buckets over every
 * mode, list + table at once). The view rides the collection's item set, so
 * the hub's transient filter narrows the buckets like every other mode.
 * Registration is a module-load side effect — HubView imports this module
 * for it (the collection barrel's self-registration precedent).
 */

import type { NodeCollectionProps } from "../collection/types.js";
import { registerView } from "../collection/registry.js";

import { TaskBuckets } from "./TaskBuckets.js";

function BucketsView(props: NodeCollectionProps) {
  return (
    <TaskBuckets
      client={props.client}
      ids={props.items?.map((item) => item.node.id) ?? []}
      onOpenNode={(nodeId) => props.onNodeClick?.(nodeId)}
    />
  );
}

registerView({
  id: "buckets",
  label: "Buckets",
  icon: "mdi-format-list-checks",
  component: BucketsView,
  capabilities: {},
});
