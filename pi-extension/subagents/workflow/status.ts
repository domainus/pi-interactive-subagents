import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { WorkflowRunMetadata, NodeStatus } from "./types.ts";

/** Stable widget key kept separate from legacy subagent status state. */
export const WORKFLOW_STATUS_WIDGET_KEY = "workflow-status";

export interface WorkflowStatusSnapshot {
  readonly metadata: WorkflowRunMetadata;
  readonly nodes?: Readonly<Record<string, NodeStatus>>;
}

export interface WorkflowNodeCounts {
  readonly total: number;
  readonly pending?: number;
  readonly running?: number;
  readonly retrying?: number;
  readonly succeeded?: number;
  readonly failed?: number;
  readonly blocked?: number;
  readonly cancelled?: number;
}

export function workflowIsActive(snapshot: WorkflowStatusSnapshot | undefined): boolean {
  const status = snapshot?.metadata.status;
  return status === "running" || status === "cancelling" || status === "recovered";
}

export function workflowNodeCounts(snapshot: WorkflowStatusSnapshot): WorkflowNodeCounts {
  const values = Object.values(snapshot.nodes ?? {});
  const counts: Record<string, number> = { total: values.length };
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts as unknown as WorkflowNodeCounts;
}

export function formatWorkflowElapsed(startTime: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function workflowElapsed(snapshot: WorkflowStatusSnapshot, now = Date.now()): string {
  const started = snapshot.metadata.startedAt;
  if (typeof started !== "number" || !Number.isFinite(started)) return "--:--";
  return formatWorkflowElapsed(started, now);
}

/** Pure, bounded status text suitable for a widget, tool result, or command. */
export function formatWorkflowStatus(snapshot: WorkflowStatusSnapshot, width = 96): string {
  const meta = snapshot.metadata;
  const counts = workflowNodeCounts(snapshot);
  const done = counts.succeeded ?? 0;
  const running = (counts.running ?? 0) + (counts.retrying ?? 0);
  const failed = (counts.failed ?? 0) + (counts.blocked ?? 0);
  const label = `workflow ${meta.workflowId}  run ${meta.runId.slice(0, 8)}  ${meta.status}`;
  const progress = counts.total ? `  nodes ${done}/${counts.total} done${running ? `, ${running} active` : ""}${failed ? `, ${failed} failed` : ""}` : "";
  const limit = Math.max(0, Number.isFinite(width) ? Math.floor(width) : 96);
  // This surface is intentionally unstyled, so avoid truncateToWidth's reset/ellipsis
  // escape sequences: callers historically also treat this as plain bounded text.
  return `${label}${progress}`.slice(0, limit);
}

export function workflowStatusDetails(snapshot: WorkflowStatusSnapshot) {
  // Keep the original aggregate contract stable; richer presentation metadata is
  // added by the UI message/tool layer where it is useful.
  return {
    workflowId: snapshot.metadata.workflowId,
    runId: snapshot.metadata.runId,
    status: snapshot.metadata.status,
    nodeCounts: workflowNodeCounts(snapshot),
    ...(snapshot.metadata.topology ? { topology: { nodeCount: snapshot.metadata.topology.nodeCount, edgeCount: snapshot.metadata.topology.edgeCount, maxDepth: snapshot.metadata.topology.maxDepth, topologyDigest: snapshot.metadata.topology.topologyDigest } } : {}),
    ...(snapshot.metadata.pause ? { pause: { reason: snapshot.metadata.pause.reason, resetAt: snapshot.metadata.pause.resetAt, retryAfterMs: snapshot.metadata.pause.retryAfterMs, hintDigest: snapshot.metadata.pause.hintDigest } } : {}),
  };
}

/** Shared by legacy and workflow widgets so bordered surfaces use identical width accounting. */
const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";
export function workflowBorderLine(left: string, right: string, width: number, accent?: (text: string) => string): string {
  if (width <= 0) return "";
  const edge = accent ?? ((text: string) => `${ACCENT}${text}${RST}`);
  if (width === 1) return edge("│");
  const contentWidth = Math.max(0, width - 2);
  const rightSafe = truncateToWidth(right, contentWidth);
  const rightVis = visibleWidth(rightSafe);
  const leftSafe = truncateToWidth(left, Math.max(0, contentWidth - rightVis));
  const pad = Math.max(0, contentWidth - visibleWidth(leftSafe) - rightVis);
  return edge(`│${leftSafe}${" ".repeat(pad)}${rightSafe}│`);
}
export function workflowBorderTop(title: string, info: string, width: number, accent?: (text: string) => string): string {
  if (width <= 0) return "";
  const edge = accent ?? ((text: string) => `${ACCENT}${text}${RST}`);
  if (width === 1) return edge("╭");
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = Math.max(0, inner - visibleWidth(titlePart) - visibleWidth(infoPart));
  const content = truncateToWidth(`${titlePart}${"─".repeat(fill)}${infoPart}`, inner).padEnd(inner, "─");
  return edge(`╭${content}╮`);
}
export function workflowBorderBottom(width: number, accent?: (text: string) => string): string {
  if (width <= 0) return "";
  const edge = accent ?? ((text: string) => `${ACCENT}${text}${RST}`);
  if (width === 1) return edge("╰");
  return edge(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

/** A stable, visually distinct icon for every node lifecycle state. */
export function workflowNodeStatusIcon(status: NodeStatus): string {
  switch (status) {
    case "pending": return "○";
    case "running": return "●";
    case "retrying": return "↻";
    case "succeeded": return "✓";
    case "failed": return "✗";
    case "blocked": return "⊘";
    case "cancelled": return "■";
  }
}

/**
 * Return bounded, display-only node rows. This deliberately includes only the
 * node identity and lifecycle state; results, prompts, paths, and credentials
 * never cross this presentation boundary.
 */
const NODE_ACTION_PRIORITY: Readonly<Record<NodeStatus, number>> = Object.freeze({ failed: 0, blocked: 1, retrying: 2, running: 3, pending: 4, succeeded: 5, cancelled: 6 });

export function workflowNodeRows(snapshot: WorkflowStatusSnapshot, maxNodes = 32): ReadonlyArray<{ nodeId: string; status: NodeStatus; icon: string }> {
  const limit = Math.max(0, Math.min(128, Math.floor(Number.isFinite(maxNodes) ? maxNodes : 32)));
  return Object.entries(snapshot.nodes ?? {})
    .sort(([a, aStatus], [b, bStatus]) => NODE_ACTION_PRIORITY[aStatus] - NODE_ACTION_PRIORITY[bStatus] || a.localeCompare(b))
    .slice(0, limit)
    .map(([nodeId, status]) => ({ nodeId, status, icon: workflowNodeStatusIcon(status) }));
}

export function workflowWidgetRight(snapshot: WorkflowStatusSnapshot): string {
  const counts = workflowNodeCounts(snapshot);
  const total = counts.total;
  const done = counts.succeeded ?? 0;
  const failed = (counts.failed ?? 0) + (counts.blocked ?? 0);
  const icon = snapshot.metadata.status === "completed" ? "✓" : snapshot.metadata.status === "failed" || failed ? "✗" : snapshot.metadata.status === "cancelling" ? "…" : "•";
  const summary = total ? `${done}/${total}` : snapshot.metadata.status;
  return `${icon} ${summary} · ${snapshot.metadata.status}`;
}
