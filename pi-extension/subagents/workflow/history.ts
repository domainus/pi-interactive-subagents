import type { WorkflowRunMetadata, WorkflowState } from "./types.ts";
import { enumerateWorkflowRunMetadata, type WorkflowStorage } from "./storage.ts";

export interface WorkflowHistoryEntry {
  readonly workflowId: string; readonly runId: string; readonly revision?: number; readonly template: string; readonly status: string;
  readonly startedAt?: number; readonly updatedAt?: number; readonly finishedAt?: number; readonly durationMs?: number;
  readonly workflowIntegrity: string; readonly topology?: WorkflowRunMetadata["topology"];
  readonly pause?: { readonly reason: string; readonly resetAt?: number; readonly retryAfterMs?: number; readonly callbackId?: string; readonly hintDigest: string };
  readonly nodeCounts: Readonly<Record<string, number>>;
  readonly artifactCounts: Readonly<{ results: number; attempts: number; gates: number; worktrees: number; telemetry: number; provenance: number }>;
  readonly artifactBytes?: number; readonly telemetryDigest?: string;
}
export interface WorkflowHistoryQuery { readonly limit?: number; readonly cursor?: string; readonly status?: string; }
export interface WorkflowHistoryList { readonly entries: readonly { readonly workflowId: string; readonly runId: string; readonly status: string; readonly updatedAt?: number; readonly revision?: number; readonly workflowIntegrity: string; readonly topologyDigest?: string }[]; readonly nextCursor?: string; readonly diagnostics?: readonly string[]; }

const countNodes = (state: WorkflowState | undefined): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = { total: Object.keys(state?.nodes ?? {}).length };
  for (const status of Object.values(state?.nodes ?? {})) counts[status] = (counts[status] ?? 0) + 1;
  return Object.freeze(counts);
};
export function workflowHistoryEntry(metadata: WorkflowRunMetadata, state?: WorkflowState, artifactBytes?: number, telemetryDigest?: string): WorkflowHistoryEntry {
  if (!metadata || typeof metadata.workflowId !== "string") throw new Error("workflow history metadata is invalid");
  if (artifactBytes !== undefined && (!Number.isSafeInteger(artifactBytes) || artifactBytes < 0 || artifactBytes > 5_242_880)) throw new Error("workflow history artifact size exceeds bound");
  if (telemetryDigest !== undefined && !/^[a-f0-9]{64}$/.test(telemetryDigest)) throw new Error("workflow history telemetry digest is invalid");
  const durationMs = metadata.startedAt !== undefined && metadata.finishedAt !== undefined ? Math.max(0, metadata.finishedAt - metadata.startedAt) : undefined;
  const attempts = Object.values(state?.attempts ?? {}).reduce((n, list) => n + list.length, 0);
  const gates = Object.values(state?.gates ?? {}).reduce((n, list) => n + list.length, 0);
  const pause = metadata.pause ? { reason: metadata.pause.reason, ...(metadata.pause.resetAt !== undefined ? { resetAt: metadata.pause.resetAt } : {}), ...(metadata.pause.retryAfterMs !== undefined ? { retryAfterMs: metadata.pause.retryAfterMs } : {}), ...(metadata.pause.callbackId !== undefined ? { callbackId: metadata.pause.callbackId } : {}), hintDigest: metadata.pause.hintDigest } : undefined;
  return Object.freeze({ workflowId: metadata.workflowId, runId: metadata.runId, ...(metadata.revision !== undefined ? { revision: metadata.revision } : {}), template: metadata.template, status: metadata.status, ...(metadata.startedAt !== undefined ? { startedAt: metadata.startedAt } : {}), ...(metadata.updatedAt !== undefined ? { updatedAt: metadata.updatedAt } : {}), ...(metadata.finishedAt !== undefined ? { finishedAt: metadata.finishedAt } : {}), ...(durationMs !== undefined ? { durationMs } : {}), workflowIntegrity: metadata.workflowIntegrity, ...(metadata.topology ? { topology: metadata.topology } : {}), ...(pause ? { pause } : {}), nodeCounts: countNodes(state), artifactCounts: { results: Object.keys(state?.results ?? {}).length, attempts, gates, worktrees: Object.keys(state?.worktrees ?? {}).length, telemetry: state?.telemetry?.length ?? 0, provenance: state?.provenance?.length ?? 0 }, ...(artifactBytes !== undefined ? { artifactBytes } : {}), ...(telemetryDigest ? { telemetryDigest } : {}) });
}
export const createWorkflowHistoryEntry = workflowHistoryEntry;
export function workflowHistoryDetail(storage: WorkflowStorage, query: WorkflowHistoryQuery = {}): WorkflowHistoryEntry {
  const metadata = storage.loadWorkflowRunMetadata();
  if (query.status && query.status !== metadata.status) throw new Error("workflow does not match status filter");
  const state = metadata.status === "pending" ? undefined : storage.loadWorkflowState();
  return workflowHistoryEntry(metadata, state);
}
export const workflowDetail = workflowHistoryDetail;
export function workflowHistoryList(sessionDir: string, sessionId: string, query: WorkflowHistoryQuery = {}): WorkflowHistoryList {
  const result = enumerateWorkflowRunMetadata(sessionDir, sessionId, query);
  const entries = query.status ? result.entries.filter((entry) => entry.status === query.status) : result.entries;
  return Object.freeze({ entries: Object.freeze(entries), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) });
}
