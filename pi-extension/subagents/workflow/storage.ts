import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { validateTaskResult, validateWorkflowSpec, validateWorkflowState } from "./schema.ts";
import type { TaskResult, WorkflowSpec, WorkflowState, ValidationIssue } from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BYTES = 1_048_576;
export class WorkflowStorageError extends Error {
  readonly code: "invalid-path" | "missing" | "invalid-json" | "invalid-data" | "too-large" | "io";
  constructor(code: WorkflowStorageError["code"], message = "Workflow artifact unavailable") { super(message); this.name = "WorkflowStorageError"; this.code = code; }
}
function safeId(value: string, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || value.includes("..") || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new WorkflowStorageError("invalid-path");
  return value;
}
function safeSessionDir(value: string): string { if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new WorkflowStorageError("invalid-path"); return value; }
export interface WorkflowStorage {
  readonly rootDir: string;
  readonly saveWorkflowSpec: (spec: WorkflowSpec) => void;
  readonly loadWorkflowSpec: () => WorkflowSpec;
  readonly saveWorkflowState: (state: WorkflowState) => void;
  readonly loadWorkflowState: () => WorkflowState;
  readonly saveTaskResult: (result: TaskResult) => void;
  readonly loadTaskResult: (nodeId: string) => TaskResult;
  readonly recoverWorkflowState: () => { readonly ok: true; readonly value: WorkflowState } | { readonly ok: false; readonly error: WorkflowStorageError };
}
function encode(value: unknown): string {
  let text: string;
  try { text = JSON.stringify(value); } catch { throw new WorkflowStorageError("invalid-data"); }
  if (!text) throw new WorkflowStorageError("invalid-data");
  const content = `${text}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new WorkflowStorageError("too-large");
  return content;
}
function atomicJson(path: string, value: unknown): void {
  const content = encode(value); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`; let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path);
    try { const dirFd = openSync(dirname(path), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* directory fsync is platform dependent */ }
  } catch {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw new WorkflowStorageError("io");
  }
}
function readJson(path: string): unknown {
  let size: number;
  try { size = statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new WorkflowStorageError("missing"); throw new WorkflowStorageError("io"); }
  if (!Number.isFinite(size) || size < 0 || size > MAX_BYTES) throw new WorkflowStorageError("too-large");
  let text: string; try { text = readFileSync(path, "utf8"); } catch { throw new WorkflowStorageError("io"); }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new WorkflowStorageError("too-large");
  try { return JSON.parse(text); } catch { throw new WorkflowStorageError("invalid-json"); }
}
function invalid(_issues: readonly ValidationIssue[]): never { throw new WorkflowStorageError("invalid-data"); }
export function workflowArtifactRoot(sessionDir: string, sessionId: string, workflowId: string): string { return join(safeSessionDir(sessionDir), "artifacts", safeId(sessionId, "session ID"), "workflow", safeId(workflowId, "workflow ID")); }
export function createWorkflowStorage(sessionDir: string, sessionId: string, workflowId: string): WorkflowStorage {
  const rootDir = workflowArtifactRoot(sessionDir, sessionId, workflowId); const specPath = join(rootDir, "workflow.json"); const statePath = join(rootDir, "state.json"); const resultPath = (nodeId: string) => join(rootDir, `result-${safeId(nodeId, "node ID")}.json`);
  const loadWorkflowSpec = (): WorkflowSpec => { const result = validateWorkflowSpec(readJson(specPath)); return result.ok && result.value.id === workflowId && result.value.sessionId === sessionId ? result.value : invalid(result.ok ? [] : result.issues); };
  const loadWorkflowState = (): WorkflowState => { const result = validateWorkflowState(readJson(statePath), { workflowId, sessionId }); return result.ok ? result.value : invalid(result.issues); };
  const loadTaskResult = (nodeId: string): TaskResult => { const result = validateTaskResult(readJson(resultPath(nodeId))); return result.ok && result.value.workflowId === workflowId && result.value.nodeId === nodeId ? result.value : invalid(result.ok ? [] : result.issues); };
  return {
    rootDir,
    saveWorkflowSpec: (spec) => { if (spec.id !== workflowId || spec.sessionId !== sessionId) throw new WorkflowStorageError("invalid-data"); const checked = validateWorkflowSpec(spec); if (!checked.ok) throw new WorkflowStorageError("invalid-data"); atomicJson(specPath, checked.value); },
    loadWorkflowSpec,
    saveWorkflowState: (state) => { if (state.workflowId !== workflowId || state.sessionId !== sessionId) throw new WorkflowStorageError("invalid-data"); const checked = validateWorkflowState(state, { workflowId, sessionId }); if (!checked.ok) throw new WorkflowStorageError("invalid-data"); atomicJson(statePath, checked.value); },
    loadWorkflowState,
    saveTaskResult: (result) => { safeId(result.nodeId, "node ID"); if (result.workflowId !== workflowId) throw new WorkflowStorageError("invalid-data"); const checked = validateTaskResult(result); if (!checked.ok) throw new WorkflowStorageError("invalid-data"); atomicJson(resultPath(result.nodeId), checked.value); },
    loadTaskResult,
    recoverWorkflowState: () => { try { return { ok: true, value: loadWorkflowState() }; } catch (error) { return { ok: false, error: error instanceof WorkflowStorageError ? error : new WorkflowStorageError("io") }; } },
  };
}
export const createStorage = createWorkflowStorage;
