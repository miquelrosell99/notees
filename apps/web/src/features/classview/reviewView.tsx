/**
 * ReviewView — the unreviewed-days queue (TaskReview) as a REGISTERED
 * collection view (the bucketsView precedent): the tasks hub's switcher
 * offers Review alongside Buckets and the shared modes, and the queue rides
 * the collection's item set, so the hub's transient filter narrows it like
 * every other mode. Registration is a module-load side effect — HubView
 * imports this module for it.
 */

import type { NodeCollectionProps } from "../collection/types.js";
import { registerView } from "../collection/registry.js";

import { TaskReview } from "./TaskReview.js";

function ReviewView(props: NodeCollectionProps) {
  return (
    <TaskReview
      client={props.client}
      ids={props.items?.map((item) => item.node.id) ?? []}
      onOpenNode={(nodeId) => props.onNodeClick?.(nodeId)}
    />
  );
}

registerView({
  id: "review",
  label: "Review",
  icon: "mdi-calendar-alert",
  component: ReviewView,
  capabilities: {},
});
