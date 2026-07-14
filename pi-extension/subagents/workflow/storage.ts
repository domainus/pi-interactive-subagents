import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { MAX_JSON_ARTIFACT_BYTES, MAX_WORKFLOW_STATE_BYTES, schemas, isLegalWorkflowRunStatusTransition, validateTaskResult, validateWorkflowRunMetadata, validateWorkflowSpec, validateWorkflowState } from "./schema.ts";
import type { GateResult, NodeAttempt, TaskResult, WorkflowRunMetadata, WorkflowSpec, WorkflowState, WorktreeEvidence, WorktreeMetadata, ValidationIssue } from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; const MAX_BYTES = MAX_JSON_ARTIFACT_BYTES + 1; const MAX_STATE_BYTES = MAX_WORKFLOW_STATE_BYTES + 1; const MAX_WORKTREE_BYTES = 5_242_880;
export class WorkflowStorageError extends Error { readonly code: "invalid-path" | "missing" | "invalid-json" | "invalid-data" | "too-large" | "io"; constructor(code: WorkflowStorageError["code"], message = "Workflow artifact unavailable") { super(message); this.name = "WorkflowStorageError"; this.code = code; } }
function safeId(value: string): string { if (typeof value !== "string" || !ID.test(value) || value.includes("..") || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new WorkflowStorageError("invalid-path"); return value; }
function safeSessionDir(value: string): string { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0") || value.split(/[\\/]/).includes("..")) throw new WorkflowStorageError("invalid-path"); return value; }
export interface WorkflowStorage {
  readonly rootDir: string;
  readonly saveWorkflowRunMetadata: (metadata: WorkflowRunMetadata) => void; readonly loadWorkflowRunMetadata: () => WorkflowRunMetadata;
  /** Short aliases retained for callers that treat run metadata as the primary artifact. */
  readonly saveRunMetadata: (metadata: WorkflowRunMetadata) => void; readonly loadRunMetadata: () => WorkflowRunMetadata;
  readonly saveWorkflowRun: (metadata: WorkflowRunMetadata) => void; readonly loadWorkflowRun: () => WorkflowRunMetadata;
  readonly saveWorkflowSpec: (spec: WorkflowSpec) => void; readonly loadWorkflowSpec: () => WorkflowSpec;
  /** Exclusive initial pair creation; never overwrites an existing plan. */
  readonly createWorkflowPlan: (spec: WorkflowSpec, metadata: WorkflowRunMetadata) => void;
  readonly saveWorkflowState: (state: WorkflowState) => void; readonly loadWorkflowState: () => WorkflowState;
  readonly saveTaskResult: (result: TaskResult) => void; readonly loadTaskResult: (nodeId: string) => TaskResult;
  readonly saveNodeAttempt: (attempt: NodeAttempt) => void; readonly loadNodeAttempts: (nodeId: string) => readonly NodeAttempt[];
  readonly saveGateResult: (result: GateResult) => void; readonly loadGateResults: (nodeId: string) => readonly GateResult[];
  readonly saveWorktreeMetadata: (metadata: WorktreeMetadata) => void; readonly loadWorktreeMetadata: (nodeId: string, attempt?: number) => WorktreeMetadata;
  readonly recoverWorkflowState: () => { readonly ok: true; readonly value: WorkflowState } | { readonly ok: false; readonly error: WorkflowStorageError };
}
function encode(value: unknown, maxBytes = MAX_BYTES): string { let text: string; try { text = JSON.stringify(value); } catch { throw new WorkflowStorageError("invalid-data"); } if (!text) throw new WorkflowStorageError("invalid-data"); const content = `${text}\n`; if (Buffer.byteLength(content, "utf8") > maxBytes) throw new WorkflowStorageError("too-large"); return content; }
function atomicJson(path: string, value: unknown, maxBytes = MAX_BYTES): void {
  const content = encode(value, maxBytes); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`; let fd: number | undefined;
  try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); try { const dirFd = openSync(dirname(path), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* platform dependent */ } }
  catch (error) { if (fd !== undefined) try { closeSync(fd); } catch {} try { unlinkSync(temp); } catch {} if (error instanceof WorkflowStorageError) throw error; throw new WorkflowStorageError("io"); }
}
function exclusiveJson(path: string, value: unknown, maxBytes = MAX_BYTES): void {
  const content = encode(value, maxBytes); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); let fd: number | undefined; let created = false;
  try { fd = openSync(path, "wx", 0o600); created = true; writeFileSync(fd, content, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; }
  catch (error) { if (fd !== undefined) try { closeSync(fd); } catch {} if (created) { try { unlinkSync(path); } catch { throw new WorkflowStorageError("io", "workflow plan rollback failed"); } } if (error instanceof WorkflowStorageError) throw error; throw new WorkflowStorageError("io"); }
}
function readJson(path: string, maxBytes = MAX_BYTES): unknown { let size: number; try { size = statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new WorkflowStorageError("missing"); throw new WorkflowStorageError("io"); } if (!Number.isFinite(size) || size < 0 || size > maxBytes) throw new WorkflowStorageError("too-large"); let text: string; try { text = readFileSync(path, "utf8"); } catch { throw new WorkflowStorageError("io"); } if (Buffer.byteLength(text) > maxBytes) throw new WorkflowStorageError("too-large"); try { return JSON.parse(text); } catch { throw new WorkflowStorageError("invalid-json"); } }
function invalid(_issues: readonly ValidationIssue[] = []): never { throw new WorkflowStorageError("invalid-data"); }
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; };
const safeRelative = (value: string): boolean => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..");
function safeMetadata(value: WorktreeMetadata): boolean { const evidence = sha256(canonical({ workflowId: value.workflowId, nodeId: value.nodeId, attempt: value.attempt, base: value.base, head: value.head, diffHash: value.diffHash, changedFiles: value.changedFiles })); return isAbsolute(value.cwd) && resolve(value.cwd) === value.cwd && !value.cwd.includes("\0") && ((value.mode === "read-only" && value.path === undefined && !value.preserved) || (value.mode === "mutating" && value.path === value.cwd && value.preserved && isAbsolute(value.path) && resolve(value.path) === value.path)) && Buffer.byteLength(value.status, "utf8") <= 65_536 && Buffer.byteLength(value.diff, "utf8") <= 4_194_304 && value.changedFiles.length <= 512 && value.changedFiles.every(safeRelative) && value.diffHash === sha256(value.diff) && value.evidenceDigest === evidence; }
function safeGate(value: GateResult): boolean { const { gateDigest, ...body } = value; return gateDigest === sha256(canonical(body)); }
function evidenceOnly(value: WorktreeMetadata): WorktreeEvidence { const { diff: _diff, status: _status, ...evidence } = value; return evidence; }
const runIdentity = (value: WorkflowRunMetadata): string => canonical({ runId: value.runId, workflowId: value.workflowId, sessionId: value.sessionId, cwd: value.cwd, worktreeRoot: value.worktreeRoot, workflowIntegrity: value.workflowIntegrity, template: value.template });
const terminalStatuses = new Set(["succeeded", "failed", "blocked", "cancelled"]);
function validAttempts(values: readonly NodeAttempt[]): boolean {
  if (!values.every((item, index) => item.attempt === index + 1 && item.status !== "pending")) return false;
  for (let i = 0; i < values.length; i++) {
    const item = values[i]; if (item.status === "running" && item.finishedAt !== undefined) return false; if (i < values.length - 1 && item.status !== "retrying" && item.status !== "cancelled") return false;
    if (i > 0 && terminalStatuses.has(values[i - 1].status) && values[i - 1].status !== "cancelled") return false;
  }
  return true;
}
function legalAttemptUpdate(previous: NodeAttempt | undefined, next: NodeAttempt): boolean {
  if (!previous) return next.status === "running" || next.status === "cancelled";
  if (terminalStatuses.has(previous.status)) return isDeepStrictEqual(previous, next);
  if (previous.status === "running") return next.status === "running" || next.status === "retrying" || terminalStatuses.has(next.status);
  if (previous.status === "retrying") return next.status === "retrying" || next.status === "running" || terminalStatuses.has(next.status);
  return false;
}
export function workflowArtifactRoot(sessionDir: string, sessionId: string, workflowId: string): string { return join(safeSessionDir(sessionDir), "artifacts", safeId(sessionId), "workflow", safeId(workflowId)); }
export function createWorkflowStorage(sessionDir: string, sessionId: string, workflowId: string): WorkflowStorage {
  const rootDir = workflowArtifactRoot(sessionDir, sessionId, workflowId); const specPath = join(rootDir, "workflow.json"); const statePath = join(rootDir, "state.json"); const runMetadataPath = join(rootDir, "run.json"); const planLockPath = join(rootDir, "plan.lock");
  const assertPlanCommitted = (): void => { if (existsSync(planLockPath)) throw new WorkflowStorageError("invalid-data", "workflow plan is incomplete"); };
  const loadWorkflowRunMetadata = (): WorkflowRunMetadata => { assertPlanCommitted(); const result = validateWorkflowRunMetadata(readJson(runMetadataPath), { workflowId, sessionId }); if (!result.ok) invalid(result.issues); return result.value; };
  const saveWorkflowRunMetadata = (metadata: WorkflowRunMetadata): void => {
    const checked = validateWorkflowRunMetadata(metadata, { workflowId, sessionId }); if (!checked.ok) invalid(checked.issues);
    if (existsSync(runMetadataPath)) {
      const previous = loadWorkflowRunMetadata();
      if (runIdentity(previous) !== runIdentity(checked.value)) throw new WorkflowStorageError("invalid-data", "workflow run ownership is immutable");
      if (!isLegalWorkflowRunStatusTransition(previous.status, checked.value.status)) throw new WorkflowStorageError("invalid-data", "illegal workflow run status transition");
      for (const field of ["startedAt", "finishedAt"] as const) if (previous[field] !== undefined && checked.value[field] !== previous[field]) throw new WorkflowStorageError("invalid-data", `${field} is immutable once recorded`);
      if (previous.updatedAt !== undefined && (checked.value.updatedAt === undefined || checked.value.updatedAt < previous.updatedAt)) throw new WorkflowStorageError("invalid-data", "updatedAt must be monotonic");
      if (previous.status === checked.value.status && isDeepStrictEqual(previous, checked.value)) return;
    }
    atomicJson(runMetadataPath, checked.value, MAX_BYTES);
  };
  const pathFor = (kind: string, nodeId: string, suffix = "") => join(rootDir, `${kind}-${safeId(nodeId)}${suffix}.json`);
  const loadWorkflowSpec = (): WorkflowSpec => { assertPlanCommitted(); const result = validateWorkflowSpec(readJson(specPath)); return result.ok && result.value.id === workflowId && result.value.sessionId === sessionId ? result.value : invalid(result.ok ? [] : result.issues); };
  const loadWorkflowState = (): WorkflowState => { const result = validateWorkflowState(readJson(statePath, MAX_STATE_BYTES), { workflowId, sessionId }); return result.ok ? result.value : invalid(result.issues); };
  const createWorkflowPlan = (spec: WorkflowSpec, metadata: WorkflowRunMetadata): void => {
    if (spec.id !== workflowId || spec.sessionId !== sessionId) invalid();
    const checkedSpec = validateWorkflowSpec(spec); if (!checkedSpec.ok) invalid(checkedSpec.issues);
    const checkedMetadata = validateWorkflowRunMetadata(metadata, { workflowId, sessionId }); if (!checkedMetadata.ok) invalid(checkedMetadata.issues);
    let lockFd: number | undefined; let lockAcquired = false; let retainLock = false; let committed = false;
    try {
      mkdirSync(rootDir, { recursive: true, mode: 0o700 }); lockFd = openSync(planLockPath, "wx", 0o600); lockAcquired = true;
      if (existsSync(specPath) || existsSync(runMetadataPath)) throw new WorkflowStorageError("invalid-data", "workflow plan already exists");
      let wroteSpec = false; let wroteRun = false;
      try { exclusiveJson(specPath, checkedSpec.value); wroteSpec = true; exclusiveJson(runMetadataPath, checkedMetadata.value); wroteRun = true; const dirFd = openSync(rootDir, "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } committed = true; }
      catch (error) { let rollbackFailed = error instanceof WorkflowStorageError && error.message === "workflow plan rollback failed"; if (wroteRun) try { unlinkSync(runMetadataPath); } catch { rollbackFailed = true; } if (wroteSpec) try { unlinkSync(specPath); } catch { rollbackFailed = true; } if (rollbackFailed) retainLock = true; throw error; }
    } catch (error) { if (error instanceof WorkflowStorageError) throw error; if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new WorkflowStorageError("invalid-data", "workflow plan already exists"); throw new WorkflowStorageError("io"); }
    finally { if (lockFd !== undefined) try { closeSync(lockFd); } catch { retainLock = true; throw new WorkflowStorageError("io", "workflow plan lock could not be closed"); } if (lockAcquired && !retainLock) { try { unlinkSync(planLockPath); } catch { throw new WorkflowStorageError("io", "workflow plan commit lock could not be removed"); } try { const dirFd = openSync(rootDir, "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { throw new WorkflowStorageError("io", committed ? "workflow plan commit could not be synchronized" : "workflow plan rollback could not be synchronized"); } } }
  };
  const loadTaskResult = (nodeId: string): TaskResult => { const result = validateTaskResult(readJson(pathFor("result", nodeId))); return result.ok && result.value.workflowId === workflowId && result.value.nodeId === nodeId ? result.value : invalid(result.ok ? [] : result.issues); };
  const loadArray = <T extends { workflowId: string; nodeId: string }>(path: string, schema: unknown, nodeId: string, max: number): readonly T[] => { const value = existsSync(path) ? readJson(path) : []; if (!Array.isArray(value) || value.length > max || value.some((x) => !Value.Check(schema as any, x) || x.workflowId !== workflowId || x.nodeId !== nodeId)) invalid(); return value as T[]; };
  return {
    rootDir,
    saveWorkflowRunMetadata, loadWorkflowRunMetadata, saveRunMetadata: saveWorkflowRunMetadata, loadRunMetadata: loadWorkflowRunMetadata, saveWorkflowRun: saveWorkflowRunMetadata, loadWorkflowRun: loadWorkflowRunMetadata,
    saveWorkflowSpec: (spec) => { if (spec.id !== workflowId || spec.sessionId !== sessionId) invalid(); const checked = validateWorkflowSpec(spec); if (!checked.ok) invalid(checked.issues); atomicJson(specPath, checked.value); }, loadWorkflowSpec, createWorkflowPlan,
    saveWorkflowState: (state) => { const checked = validateWorkflowState(state, { workflowId, sessionId }); if (!checked.ok) invalid(checked.issues); atomicJson(statePath, checked.value, MAX_STATE_BYTES); }, loadWorkflowState,
    saveTaskResult: (result) => { safeId(result.nodeId); if (result.workflowId !== workflowId) invalid(); const checked = validateTaskResult(result); if (!checked.ok) invalid(checked.issues); const path = pathFor("result", result.nodeId); if (existsSync(path)) { const prior = loadTaskResult(result.nodeId); if (isDeepStrictEqual(prior, checked.value)) return; throw new WorkflowStorageError("invalid-data", "task result identity is immutable"); } atomicJson(path, checked.value); }, loadTaskResult,
    saveNodeAttempt: (attempt) => { safeId(attempt.nodeId); if (attempt.workflowId !== workflowId || !Value.Check(schemas.NodeAttemptSchema, attempt)) invalid(); const path = pathFor("attempts", attempt.nodeId); const prior = loadArray<NodeAttempt>(path, schemas.NodeAttemptSchema, attempt.nodeId, 100); if (!validAttempts(prior) || attempt.attempt > prior.length + 1) invalid(); const previous = prior.find((item) => item.attempt === attempt.attempt); if (!legalAttemptUpdate(previous, attempt)) invalid(); const next = attempt.attempt === prior.length + 1 ? [...prior, attempt] : prior.map((item) => item.attempt === attempt.attempt ? attempt : item); if (next.length > 100 || !validAttempts(next)) invalid(); atomicJson(path, next); },
    loadNodeAttempts: (nodeId) => { const values = loadArray<NodeAttempt>(pathFor("attempts", nodeId), schemas.NodeAttemptSchema, nodeId, 100); if (!validAttempts(values)) invalid(); return values; },
    saveGateResult: (result) => { safeId(result.nodeId); if (result.workflowId !== workflowId || !Value.Check(schemas.GateResultSchema, result) || !safeGate(result)) invalid(); const path = pathFor("gates", result.nodeId); const prior = loadArray<GateResult>(path, schemas.GateResultSchema, result.nodeId, 64); const index = prior.findIndex((item) => item.evaluationId === result.evaluationId); if (index >= 0) { if (isDeepStrictEqual(prior[index], result)) return; throw new WorkflowStorageError("invalid-data", "gate evaluation identity is immutable"); } const next = [...prior, result]; if (next.length > 64) invalid(); atomicJson(path, next); },
    loadGateResults: (nodeId) => { const values = loadArray<GateResult>(pathFor("gates", nodeId), schemas.GateResultSchema, nodeId, 64); if (values.some((value) => !safeGate(value)) || new Set(values.map((value) => value.evaluationId)).size !== values.length) invalid(); return values; },
    saveWorktreeMetadata: (metadata) => { safeId(metadata.nodeId); if (metadata.workflowId !== workflowId || !Value.Check(schemas.WorktreeMetadataSchema, metadata) || !safeMetadata(metadata)) invalid(); atomicJson(pathFor("worktree", metadata.nodeId, `-${metadata.attempt}`), metadata, MAX_WORKTREE_BYTES); },
    loadWorktreeMetadata: (nodeId, attempt = 1) => { safeId(nodeId); if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) invalid(); const value = readJson(pathFor("worktree", nodeId, `-${attempt}`), MAX_WORKTREE_BYTES); if (!Value.Check(schemas.WorktreeMetadataSchema, value) || !safeMetadata(value as WorktreeMetadata) || (value as WorktreeMetadata).workflowId !== workflowId || (value as WorktreeMetadata).nodeId !== nodeId || (value as WorktreeMetadata).attempt !== attempt) invalid(); return value as WorktreeMetadata; },
    recoverWorkflowState: () => { try {
      const loaded = loadWorkflowState(); const nodes = { ...loaded.nodes }; const results = { ...(loaded.results ?? {}) }; const attempts = Object.fromEntries(Object.entries(loaded.attempts ?? {}).map(([id, list]) => [id, [...list]])); const gates = Object.fromEntries(Object.entries(loaded.gates ?? {}).map(([id, list]) => [id, [...list]])); const worktrees = { ...(loaded.worktrees ?? {}) }; let changed = false;
      for (const id of Object.keys(nodes)) {
        if (existsSync(pathFor("result", id))) { const result = loadTaskResult(id); if (!isDeepStrictEqual(results[id], result)) { results[id] = result; changed = true; } if (nodes[id] !== result.status) { nodes[id] = result.status; changed = true; } }
        const loadedAttempts = loadArray<NodeAttempt>(pathFor("attempts", id), schemas.NodeAttemptSchema, id, 100); if (!validAttempts(loadedAttempts)) invalid(); if (loadedAttempts.length && !isDeepStrictEqual(attempts[id], loadedAttempts)) { attempts[id] = [...loadedAttempts]; changed = true; }
        const loadedGates = loadArray<GateResult>(pathFor("gates", id), schemas.GateResultSchema, id, 64); if (loadedGates.some((gate) => !safeGate(gate)) || new Set(loadedGates.map((gate) => gate.evaluationId)).size !== loadedGates.length) invalid(); if (loadedGates.length && !isDeepStrictEqual(gates[id], loadedGates)) { gates[id] = [...loadedGates]; changed = true; }
        for (const name of existsSync(rootDir) ? readdirSync(rootDir) : []) { const match = /^worktree-([A-Za-z0-9][A-Za-z0-9._-]{0,127})-([1-9][0-9]{0,2})\.json$/.exec(name); if (!match || match[1] !== id) continue; const attempt = Number(match[2]); const metadata = ((): WorktreeMetadata => { const value = readJson(join(rootDir, name), MAX_WORKTREE_BYTES); if (!Value.Check(schemas.WorktreeMetadataSchema, value) || !safeMetadata(value as WorktreeMetadata) || (value as WorktreeMetadata).workflowId !== workflowId || (value as WorktreeMetadata).nodeId !== id || (value as WorktreeMetadata).attempt !== attempt) return invalid(); return value as WorktreeMetadata; })(); const key = `${id}:${attempt}`; const evidence = evidenceOnly(metadata); if (!isDeepStrictEqual(worktrees[key], evidence)) { worktrees[key] = evidence; changed = true; } }
        if ((nodes[id] === "running" || nodes[id] === "retrying") && !results[id]) { nodes[id] = "pending"; changed = true; }
      }
      if (!changed) return { ok: true, value: loaded }; const recovered: WorkflowState = { ...loaded, status: "recovered", nodes, ...(Object.keys(results).length ? { results } : {}), ...(Object.keys(attempts).length ? { attempts } : {}), ...(Object.keys(gates).length ? { gates } : {}), ...(Object.keys(worktrees).length ? { worktrees } : {}), updatedAt: Date.now() }; const checked = validateWorkflowState(recovered, { workflowId, sessionId }); if (!checked.ok) invalid(checked.issues); atomicJson(statePath, recovered, MAX_STATE_BYTES); return { ok: true, value: recovered };
    } catch (error) { return { ok: false, error: error instanceof WorkflowStorageError ? error : new WorkflowStorageError("io") }; } },
  };
}
export const createStorage = createWorkflowStorage;
