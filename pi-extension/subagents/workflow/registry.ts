import type { WorkflowRunMetadata } from "./types.ts";

export interface WorkflowRegistryEntry {
  readonly runId: string;
  readonly owner: symbol;
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  readonly metadata: WorkflowRunMetadata;
}

const KEY = Symbol.for("pi.workflow-host.registry.v1");
type Registry = Map<string, WorkflowRegistryEntry>;
const runKey = (sessionId: string, workflowId: string): string => `${sessionId}\0${workflowId}`;
function registry(): Registry {
  const global = globalThis as typeof globalThis & { [KEY]?: Registry };
  return global[KEY] ?? (global[KEY] = new Map());
}

/** Claim before any run metadata transition, worktree creation, or launch. */
export function claimWorkflowRun(entry: WorkflowRegistryEntry): void {
  const key = runKey(entry.metadata.sessionId, entry.metadata.workflowId);
  if (registry().has(key)) throw new Error("workflow is already running in this session");
  registry().set(key, entry);
}
export function getWorkflowRun(sessionId: string, workflowId: string): WorkflowRegistryEntry | undefined {
  return registry().get(runKey(sessionId, workflowId));
}
export function releaseWorkflowRun(sessionId: string, workflowId: string, runId?: string): void {
  const key = runKey(sessionId, workflowId); const current = registry().get(key);
  if (current && (!runId || current.runId === runId)) registry().delete(key);
}
export function listWorkflowRuns(sessionId?: string): readonly WorkflowRegistryEntry[] {
  return [...registry().values()].filter((entry) => sessionId === undefined || entry.metadata.sessionId === sessionId);
}
export async function shutdownWorkflowRuns(owner: symbol): Promise<void> {
  const owned = [...registry().values()].filter((entry) => entry.owner === owner);
  for (const entry of owned) entry.controller.abort();
  await Promise.allSettled(owned.map((entry) => entry.promise));
}
