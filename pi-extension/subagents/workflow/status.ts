import type { WorkflowRunMetadata, NodeStatus } from "./types.ts";

/** Stable widget key kept separate from legacy subagent status state. */
export const WORKFLOW_STATUS_WIDGET_KEY = "workflow-status";

export interface WorkflowStatusSnapshot {
  readonly metadata: WorkflowRunMetadata;
  readonly nodes?: Readonly<Record<string, NodeStatus>>;
}

/** Pure, bounded status text suitable for a widget, tool result, or command. */
export function formatWorkflowStatus(snapshot: WorkflowStatusSnapshot, width = 96): string {
  const meta = snapshot.metadata;
  const nodes = snapshot.nodes ?? {};
  const values = Object.values(nodes);
  const counts = (name: NodeStatus) => values.filter((value) => value === name).length;
  const total = values.length;
  const done = counts("succeeded");
  const running = counts("running") + counts("retrying");
  const failed = counts("failed") + counts("blocked");
  const label = `workflow ${meta.workflowId}  run ${meta.runId.slice(0, 8)}  ${meta.status}`;
  const progress = total ? `  nodes ${done}/${total} done${running ? `, ${running} active` : ""}${failed ? `, ${failed} failed` : ""}` : "";
  const limit = Math.max(0, Number.isFinite(width) ? Math.floor(width) : 96);
  return `${label}${progress}`.slice(0, limit);
}

export function workflowStatusDetails(snapshot: WorkflowStatusSnapshot) {
  const values = Object.values(snapshot.nodes ?? {}); const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return { workflowId: snapshot.metadata.workflowId, runId: snapshot.metadata.runId, status: snapshot.metadata.status, nodeCounts: { total: values.length, ...counts } };
}
