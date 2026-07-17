import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { MAX_JSON_ARTIFACT_BYTES, MAX_WORKFLOW_STATE_BYTES, schemas, isLegalWorkflowRunStatusTransition, validateTaskResult, validateWorkflowRunMetadata, validateWorkflowSpec, validateWorkflowState } from "./schema.ts";
import type { GateResult, NodeAttempt, TaskResult, WorkflowRunMetadata, WorkflowSpec, WorkflowState, WorktreeEvidence, WorktreeMetadata, ValidationIssue, WorkflowArtifactProvenance, WorkflowTelemetryRecord } from "./types.ts";
import { validateExpansionManifest, type ExpansionManifest } from "./expansion.ts";
import type { WebResearchProvenance } from "./web-research.ts";
import { processStartIdentity } from "./coordination.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; const MAX_BYTES = MAX_JSON_ARTIFACT_BYTES + 1; const MAX_STATE_BYTES = MAX_WORKFLOW_STATE_BYTES + 1; const MAX_WORKTREE_BYTES = 5_242_880;
export class WorkflowStorageError extends Error { readonly code: "invalid-path" | "missing" | "invalid-json" | "invalid-data" | "too-large" | "io"; constructor(code: WorkflowStorageError["code"], message = "Workflow artifact unavailable") { super(message); this.name = "WorkflowStorageError"; this.code = code; } }
function safeId(value: string): string { if (typeof value !== "string" || !ID.test(value) || value.includes("..") || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new WorkflowStorageError("invalid-path"); return value; }
function safeSessionDir(value: string): string { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0") || value.split(/[\\/]/).includes("..")) throw new WorkflowStorageError("invalid-path"); return value; }
export interface WorkflowStorage {
  readonly rootDir: string;
  /** Bind the active run's lease fence before any mutation. */
  readonly setFence?: (fence?: () => void) => void;
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
  readonly saveExpansionManifest: (manifest: ExpansionManifest) => void; readonly loadExpansionManifest: () => ExpansionManifest;
  readonly saveWebResearchProvenance: (provenance: readonly WebResearchProvenance[]) => void; readonly loadWebResearchProvenance: () => readonly WebResearchProvenance[];
  readonly saveWorkflowProvenance: (provenance: WorkflowArtifactProvenance) => void; readonly loadWorkflowProvenance: () => readonly WorkflowArtifactProvenance[];
  readonly saveTelemetryRecord: (record: WorkflowTelemetryRecord) => void; readonly loadTelemetryRecords: () => readonly WorkflowTelemetryRecord[];
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
function invalid(_issues?: readonly ValidationIssue[]): never { throw new WorkflowStorageError("invalid-data"); }
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; };
const safeRelative = (value: string): boolean => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..");
function safeMetadata(value: WorktreeMetadata): boolean { const evidence = sha256(canonical({ workflowId: value.workflowId, nodeId: value.nodeId, attempt: value.attempt, base: value.base, head: value.head, diffHash: value.diffHash, changedFiles: value.changedFiles })); return isAbsolute(value.cwd) && resolve(value.cwd) === value.cwd && !value.cwd.includes("\0") && ((value.mode === "read-only" && value.path === undefined && !value.preserved) || (value.mode === "mutating" && value.path === value.cwd && value.preserved && isAbsolute(value.path) && resolve(value.path) === value.path)) && Buffer.byteLength(value.status, "utf8") <= 65_536 && Buffer.byteLength(value.diff, "utf8") <= 4_194_304 && value.changedFiles.length <= 512 && value.changedFiles.every(safeRelative) && value.diffHash === sha256(value.diff) && value.evidenceDigest === evidence; }
function safeGate(value: GateResult): boolean { const { gateDigest, ...body } = value; return gateDigest === sha256(canonical(body)); }
function evidenceOnly(value: WorktreeMetadata): WorktreeEvidence { const { diff: _diff, status: _status, ...evidence } = value; return evidence; }
const runIdentity = (value: WorkflowRunMetadata): string => canonical({ runId: value.runId, workflowId: value.workflowId, sessionId: value.sessionId, cwd: value.cwd, worktreeRoot: value.worktreeRoot, workflowIntegrity: value.workflowIntegrity, topology: value.topology, revision: value.revision, parentWorkflowId: value.parentWorkflowId, parentRunId: value.parentRunId, parentIntegrity: value.parentIntegrity, invalidatedNodeIds: value.invalidatedNodeIds, template: value.template });
const telemetryDigest = (value: WorkflowTelemetryRecord): string => { const { recordDigest: _digest, ...body } = value; return sha256(canonical(body)); };
const webProvenanceDigest = (value: WebResearchProvenance): string => { const { provenanceDigest: _digest, ...body } = value; return sha256(JSON.stringify(body)); };
function exactLedgerBinding(value: { workflowId: string; runId: string; workflowIntegrity: string; topologyDigest: string; nodeId?: string; attempt?: number }, metadata: WorkflowRunMetadata | undefined): boolean {
  return !metadata || (value.workflowId === metadata.workflowId && value.runId === metadata.runId && value.workflowIntegrity === metadata.workflowIntegrity && value.topologyDigest === metadata.topology?.topologyDigest && (!value.nodeId || value.nodeId.length > 0) && (value.attempt === undefined || value.attempt >= 1));
}
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
  if (!previous) return next.status === "running" || next.status === "cancelled" || next.classification === "imported" && next.status !== "pending";
  // A usage-limit cancellation is a durable pause marker, not a terminal
  // attempt. Resume may reopen this exact attempt after clearing stale fields.
  if (previous.status === "cancelled" && previous.classification === "usage-limit") return next.status === "running";
  if (terminalStatuses.has(previous.status)) return isDeepStrictEqual(previous, next);
  if (previous.status === "running") return next.status === "running" || next.status === "retrying" || terminalStatuses.has(next.status);
  if (previous.status === "retrying") return next.status === "retrying" || next.status === "running" || terminalStatuses.has(next.status);
  return false;
}
export function workflowArtifactRoot(sessionDir: string, sessionId: string, workflowId: string): string { return join(safeSessionDir(sessionDir), "artifacts", safeId(sessionId), "workflow", safeId(workflowId)); }
export interface WorkflowStorageOptions { readonly fence?: () => void; readonly requireBindings?: boolean; }
export function bindWorkflowStorageFence(storage: WorkflowStorage, fence: () => void): WorkflowStorage {
  const mutators = new Set(["saveWorkflowRunMetadata", "saveRunMetadata", "saveWorkflowRun", "createWorkflowPlan", "saveWorkflowSpec", "saveWorkflowState", "saveTaskResult", "saveNodeAttempt", "saveGateResult", "saveWorktreeMetadata", "saveExpansionManifest", "saveWebResearchProvenance", "saveWorkflowProvenance", "saveTelemetryRecord", "recoverWorkflowState"]);
  return new Proxy(storage, { get(target, property, receiver) { const value = Reflect.get(target, property, receiver); if (!mutators.has(String(property)) || typeof value !== "function") return value; return (...args: unknown[]) => { fence(); return (value as (...items: unknown[]) => unknown)(...args); }; } });
}
export function createWorkflowStorage(sessionDir: string, sessionId: string, workflowId: string, options: WorkflowStorageOptions = {}): WorkflowStorage {
  let activeFence = options.fence;
  const guard = (): void => { activeFence?.(); };
  const rootDir = workflowArtifactRoot(sessionDir, sessionId, workflowId); const storageLockPath = join(rootDir, ".storage.lock");
  const withStorageLock = <T>(operation: () => T): T => {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 }); let fd: number | undefined; let ownerObservation = false; const deadline = Date.now() + 2_000;
    try {
      while (fd === undefined) {
        try {
          fd = openSync(storageLockPath, "wx", 0o600); const token = randomBytes(32).toString("hex"); const content = JSON.stringify({ pid: process.pid, start: processStartIdentity(process.pid), token }); writeFileSync(fd, content); fsyncSync(fd); fstatSync(fd); ownerObservation = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw new WorkflowStorageError("io", "workflow storage lock is unavailable");
          // Never reclaim an existing pathname after a validate/close/reopen
          // sequence. Node has no inode-conditional unlink primitive, so a
          // stale decision could delete a fresh replacement in the race
          // between validation and unlink. Recovery is operator-driven.
          if (Date.now() >= deadline) throw new WorkflowStorageError("io", "workflow storage lock is busy; stale-lock recovery is disabled; operator verification and recovery are required");
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } catch {}
        }
      }
      return operation();
    } finally {
      // Only the creator releases its own lock. Contenders never unlink an
      // existing pathname; stale locks require explicit operator recovery.
      if (ownerObservation) { try { unlinkSync(storageLockPath); } catch {} }
      if (fd !== undefined) try { closeSync(fd); } catch {}
    }
  };
  const provenancePath = join(rootDir, "provenance.json"); const telemetryPath = join(rootDir, "telemetry.json"); const webProvenancePath = join(rootDir, "web-provenance.json"); const manifestPath = join(rootDir, "expansion.json"); const specPath = join(rootDir, "workflow.json"); const statePath = join(rootDir, "state.json"); const runMetadataPath = join(rootDir, "run.json"); const planLockPath = join(rootDir, "plan.lock");
  const assertPlanCommitted = (): void => { if (existsSync(planLockPath)) throw new WorkflowStorageError("invalid-data", "workflow plan is incomplete"); };
  const loadWorkflowRunMetadata = (): WorkflowRunMetadata => { assertPlanCommitted(); const result = validateWorkflowRunMetadata(readJson(runMetadataPath), { workflowId, sessionId }); if (!result.ok) invalid(result.issues); return result.value; };
  const saveWorkflowRunMetadata = (metadata: WorkflowRunMetadata): void => {
    guard(); const checked = validateWorkflowRunMetadata(metadata, { workflowId, sessionId }); if (!checked.ok) invalid(checked.issues);
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
    guard(); if (spec.id !== workflowId || spec.sessionId !== sessionId) invalid();
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
  const loadTaskResult = (nodeId: string): TaskResult => { const result = validateTaskResult(readJson(pathFor("result", nodeId))); return result.ok && result.value.workflowId === workflowId && result.value.nodeId === nodeId && (!options.requireBindings || result.value.workflowIntegrity && result.value.topologyDigest) ? result.value : invalid(result.ok ? [] : result.issues); };
  const loadArray = <T extends { workflowId: string; nodeId: string }>(path: string, schema: unknown, nodeId: string, max: number): readonly T[] => { const value = existsSync(path) ? readJson(path) : []; if (!Array.isArray(value) || value.length > max || value.some((x) => !Value.Check(schema as any, x) || x.workflowId !== workflowId || x.nodeId !== nodeId)) invalid(); return value as T[]; };
  return {
    rootDir,
    setFence: (fence?: () => void) => { activeFence = fence; },
    saveWorkflowRunMetadata, loadWorkflowRunMetadata, saveRunMetadata: saveWorkflowRunMetadata, loadRunMetadata: loadWorkflowRunMetadata, saveWorkflowRun: saveWorkflowRunMetadata, loadWorkflowRun: loadWorkflowRunMetadata,
    saveWorkflowSpec: (spec) => { guard(); if (spec.id !== workflowId || spec.sessionId !== sessionId) invalid(); const checked = validateWorkflowSpec(spec); if (!checked.ok) invalid(checked.issues); atomicJson(specPath, checked.value); }, loadWorkflowSpec, createWorkflowPlan,
    saveWorkflowState: (state) => { guard(); const checked = validateWorkflowState(state, { workflowId, sessionId }); if (!checked.ok) invalid(checked.issues); atomicJson(statePath, checked.value, MAX_STATE_BYTES); }, loadWorkflowState,
    saveTaskResult: (result) => { guard(); safeId(result.nodeId); if (result.workflowId !== workflowId || options.requireBindings && (!result.workflowIntegrity || !result.topologyDigest)) throw new WorkflowStorageError("invalid-data", "legacy or unbound task result cannot be persisted"); const checked = validateTaskResult(result); if (!checked.ok) invalid(checked.issues); const path = pathFor("result", result.nodeId); if (existsSync(path)) { const prior = loadTaskResult(result.nodeId); if (isDeepStrictEqual(prior, checked.value)) return; throw new WorkflowStorageError("invalid-data", "task result identity is immutable"); } atomicJson(path, checked.value); }, loadTaskResult,
    saveNodeAttempt: (attempt) => { guard(); safeId(attempt.nodeId); if (attempt.workflowId !== workflowId || !Value.Check(schemas.NodeAttemptSchema, attempt)) invalid(); const path = pathFor("attempts", attempt.nodeId); const prior = loadArray<NodeAttempt>(path, schemas.NodeAttemptSchema, attempt.nodeId, 100); if (!validAttempts(prior) || attempt.attempt > prior.length + 1) invalid(); const previous = prior.find((item) => item.attempt === attempt.attempt); if (!legalAttemptUpdate(previous, attempt)) invalid(); const next = attempt.attempt === prior.length + 1 ? [...prior, attempt] : prior.map((item) => item.attempt === attempt.attempt ? attempt : item); if (next.length > 100 || !validAttempts(next)) invalid(); atomicJson(path, next); },
    loadNodeAttempts: (nodeId) => { const values = loadArray<NodeAttempt>(pathFor("attempts", nodeId), schemas.NodeAttemptSchema, nodeId, 100); if (!validAttempts(values)) invalid(); return values; },
    saveGateResult: (result) => { guard(); safeId(result.nodeId); if (result.workflowId !== workflowId || options.requireBindings && (!result.workflowIntegrity || !result.topologyDigest) || !Value.Check(schemas.GateResultSchema, result) || !safeGate(result)) invalid(); const path = pathFor("gates", result.nodeId); const prior = loadArray<GateResult>(path, schemas.GateResultSchema, result.nodeId, 64); const index = prior.findIndex((item) => item.evaluationId === result.evaluationId); if (index >= 0) { if (isDeepStrictEqual(prior[index], result)) return; throw new WorkflowStorageError("invalid-data", "gate evaluation identity is immutable"); } const next = [...prior, result]; if (next.length > 64) invalid(); atomicJson(path, next); },
    loadGateResults: (nodeId) => { const values = loadArray<GateResult>(pathFor("gates", nodeId), schemas.GateResultSchema, nodeId, 64); if (values.some((value) => !safeGate(value)) || new Set(values.map((value) => value.evaluationId)).size !== values.length) invalid(); return values; },
    saveWorkflowProvenance: (provenance) => { guard(); withStorageLock(() => { const metadata = (() => { try { return loadWorkflowRunMetadata(); } catch { return undefined; } })(); if (!Value.Check(schemas.WorkflowArtifactProvenanceSchema, provenance) || provenance.workflowId !== workflowId || options.requireBindings && (!metadata || !exactLedgerBinding(provenance, metadata))) invalid(); const prior = existsSync(provenancePath) ? readJson(provenancePath) : []; if (!Array.isArray(prior) || prior.length >= 10000 || prior.some((item) => !Value.Check(schemas.WorkflowArtifactProvenanceSchema, item))) invalid(); if (prior.some((item) => item.artifactId === provenance.artifactId && !isDeepStrictEqual(item, provenance))) throw new WorkflowStorageError("invalid-data", "provenance identity is immutable"); if (!prior.some((item) => isDeepStrictEqual(item, provenance))) atomicJson(provenancePath, [...prior, provenance], MAX_STATE_BYTES); }); },
    loadWorkflowProvenance: () => { const value = readJson(provenancePath); const metadata = (() => { try { return loadWorkflowRunMetadata(); } catch { return undefined; } })(); if (!Array.isArray(value) || value.length > 10000 || value.some((item) => !Value.Check(schemas.WorkflowArtifactProvenanceSchema, item) || item.workflowId !== workflowId || options.requireBindings && (!metadata || !exactLedgerBinding(item as WorkflowArtifactProvenance, metadata)))) invalid(); return value as readonly WorkflowArtifactProvenance[]; },
    saveTelemetryRecord: (record) => { guard(); withStorageLock(() => { if (!Value.Check(schemas.WorkflowTelemetryRecordSchema, record) || record.workflowId !== workflowId || record.recordDigest !== telemetryDigest(record)) invalid(); const prior = existsSync(telemetryPath) ? readJson(telemetryPath) : []; if (!Array.isArray(prior) || prior.length >= 10000 || prior.some((item) => !Value.Check(schemas.WorkflowTelemetryRecordSchema, item) || item.recordDigest !== telemetryDigest(item as WorkflowTelemetryRecord))) invalid(); if (prior.some((item) => item.recordDigest === record.recordDigest && !isDeepStrictEqual(item, record))) throw new WorkflowStorageError("invalid-data", "telemetry identity is immutable"); if (!prior.some((item) => isDeepStrictEqual(item, record))) atomicJson(telemetryPath, [...prior, record], MAX_STATE_BYTES); }); },
    loadTelemetryRecords: () => { const value = readJson(telemetryPath); const metadata = (() => { try { return loadWorkflowRunMetadata(); } catch { return undefined; } })(); if (!Array.isArray(value) || value.length > 10000 || value.some((item) => !Value.Check(schemas.WorkflowTelemetryRecordSchema, item) || item.workflowId !== workflowId || (item as WorkflowTelemetryRecord).recordDigest !== telemetryDigest(item as WorkflowTelemetryRecord) || options.requireBindings && (!metadata || !exactLedgerBinding(item as WorkflowTelemetryRecord, metadata)))) invalid(); return value as readonly WorkflowTelemetryRecord[]; },
    saveWebResearchProvenance: (provenance) => { guard(); withStorageLock(() => { guard(); if (!Array.isArray(provenance) || provenance.length > 256 || provenance.some((item) => !item || item.provider !== "host-web-research" || !/^[a-f0-9]{64}$/.test(item.contentDigest) || !/^[a-f0-9]{64}$/.test(item.provenanceDigest) || item.provenanceDigest !== webProvenanceDigest(item as WebResearchProvenance) || !Number.isSafeInteger(item.fetchedAt) || item.bytes < 0 || item.bytes > 4_194_304)) invalid(); const prior = existsSync(webProvenancePath) ? readJson(webProvenancePath) : []; if (!Array.isArray(prior) || prior.some((item) => !item || item.provenanceDigest !== webProvenanceDigest(item as WebResearchProvenance))) invalid(); const combined = [...prior as WebResearchProvenance[]]; for (const item of provenance) { const existing = combined.find((entry) => entry.provenanceDigest === item.provenanceDigest); if (existing && !isDeepStrictEqual(existing, item)) throw new WorkflowStorageError("invalid-data", "web provenance identity is immutable"); if (!existing) combined.push(item); } if (combined.length > 256) invalid(); atomicJson(webProvenancePath, combined, MAX_BYTES); }); },
    loadWebResearchProvenance: () => { const value = readJson(webProvenancePath); if (!Array.isArray(value) || value.length > 256 || value.some((item) => item?.provider !== "host-web-research" || item.provenanceDigest !== webProvenanceDigest(item as WebResearchProvenance))) invalid(); return value as readonly WebResearchProvenance[]; },
    saveExpansionManifest: (manifest) => { guard(); withStorageLock(() => { guard(); const checked = validateExpansionManifest(manifest); const metadata = loadWorkflowRunMetadata(); if (manifest.workflowId !== workflowId || manifest.runId !== metadata.runId || manifest.workflowIntegrity !== metadata.workflowIntegrity || manifest.topologyDigest !== metadata.topology?.topologyDigest || !manifest.runId || !manifest.workflowIntegrity || !manifest.topologyDigest || !manifest.upstreamNodeId || !manifest.upstreamRawDigest || !Number.isInteger(manifest.upstreamAttempt)) invalid(); if (!/^[a-f0-9]{64}$/.test(manifest.workflowIntegrity) || !/^[a-f0-9]{64}$/.test(manifest.topologyDigest) || !/^[a-f0-9]{64}$/.test(manifest.upstreamRawDigest)) invalid(); if (existsSync(manifestPath)) { const prior = validateExpansionManifest(readJson(manifestPath)); if (prior.manifestId !== checked.manifestId || !isDeepStrictEqual(prior, checked)) throw new WorkflowStorageError("invalid-data", "expansion manifest identity is immutable"); return; } atomicJson(manifestPath, checked, MAX_BYTES); }); },
    loadExpansionManifest: () => { const value = readJson(manifestPath); const checked = validateExpansionManifest(value); if (checked.workflowId !== workflowId || !checked.runId || !checked.workflowIntegrity || !checked.topologyDigest || !checked.upstreamNodeId || !checked.upstreamRawDigest || !Number.isInteger(checked.upstreamAttempt)) invalid(); return checked; },
    saveWorktreeMetadata: (metadata) => { guard(); safeId(metadata.nodeId); if (metadata.workflowId !== workflowId || options.requireBindings && (!metadata.workflowIntegrity || !metadata.topologyDigest) || !Value.Check(schemas.WorktreeMetadataSchema, metadata) || !safeMetadata(metadata)) invalid(); atomicJson(pathFor("worktree", metadata.nodeId, `-${metadata.attempt}`), metadata, MAX_WORKTREE_BYTES); },
    loadWorktreeMetadata: (nodeId, attempt = 1) => { safeId(nodeId); if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) invalid(); const value = readJson(pathFor("worktree", nodeId, `-${attempt}`), MAX_WORKTREE_BYTES); if (!Value.Check(schemas.WorktreeMetadataSchema, value) || !safeMetadata(value as WorktreeMetadata) || options.requireBindings && (!(value as WorktreeMetadata).workflowIntegrity || !(value as WorktreeMetadata).topologyDigest) || (value as WorktreeMetadata).workflowId !== workflowId || (value as WorktreeMetadata).nodeId !== nodeId || (value as WorktreeMetadata).attempt !== attempt) invalid(); return value as WorktreeMetadata; },
    recoverWorkflowState: () => { try {
      let loaded = loadWorkflowState(); const nodes = { ...loaded.nodes }; const results = { ...(loaded.results ?? {}) }; const attempts = Object.fromEntries(Object.entries(loaded.attempts ?? {}).map(([id, list]) => [id, [...list]])); const gates = Object.fromEntries(Object.entries(loaded.gates ?? {}).map(([id, list]) => [id, [...list]])); const worktrees = { ...(loaded.worktrees ?? {}) }; let changed = false;
      for (const id of Object.keys(nodes)) {
        if (existsSync(pathFor("result", id))) { const result = loadTaskResult(id); if (!isDeepStrictEqual(results[id], result)) { results[id] = result; changed = true; } if (nodes[id] !== result.status) { nodes[id] = result.status; changed = true; } }
        const loadedAttempts = loadArray<NodeAttempt>(pathFor("attempts", id), schemas.NodeAttemptSchema, id, 100); if (!validAttempts(loadedAttempts)) invalid(); if (loadedAttempts.length && !isDeepStrictEqual(attempts[id], loadedAttempts)) { attempts[id] = [...loadedAttempts]; changed = true; }
        const loadedGates = loadArray<GateResult>(pathFor("gates", id), schemas.GateResultSchema, id, 64); if (loadedGates.some((gate) => !safeGate(gate)) || new Set(loadedGates.map((gate) => gate.evaluationId)).size !== loadedGates.length) invalid(); if (loadedGates.length && !isDeepStrictEqual(gates[id], loadedGates)) { gates[id] = [...loadedGates]; changed = true; }
        for (const name of existsSync(rootDir) ? readdirSync(rootDir) : []) { const match = /^worktree-([A-Za-z0-9][A-Za-z0-9._-]{0,127})-([1-9][0-9]{0,2})\.json$/.exec(name); if (!match || match[1] !== id) continue; const attempt = Number(match[2]); const metadata = ((): WorktreeMetadata => { const value = readJson(join(rootDir, name), MAX_WORKTREE_BYTES); if (!Value.Check(schemas.WorktreeMetadataSchema, value) || !safeMetadata(value as WorktreeMetadata) || (value as WorktreeMetadata).workflowId !== workflowId || (value as WorktreeMetadata).nodeId !== id || (value as WorktreeMetadata).attempt !== attempt) return invalid(); return value as WorktreeMetadata; })(); const key = `${id}:${attempt}`; const evidence = evidenceOnly(metadata); if (!isDeepStrictEqual(worktrees[key], evidence)) { worktrees[key] = evidence; changed = true; } }
        if ((nodes[id] === "running" || nodes[id] === "retrying") && !results[id]) { nodes[id] = "pending"; changed = true; }
      }
      // Every provenance digest must resolve to the current immutable sidecar;
      // otherwise an edited ledger is rejected before recovery can spend budget.
      for (const entry of loaded.provenance ?? []) {
        let expected: string | undefined;
        if (entry.kind === "result" && entry.nodeId) { try { expected = sha256(canonical(loadTaskResult(entry.nodeId))); } catch {} }
        else if (entry.kind === "gate" && entry.nodeId) { try { const values = readJson(pathFor("gates", entry.nodeId)); expected = Array.isArray(values) && values.some((item) => item?.gateDigest === entry.artifactDigest) ? entry.artifactDigest : undefined; } catch {} }
        else if (entry.kind === "worktree" && entry.nodeId && entry.attempt) { try { const value = readJson(pathFor("worktree", entry.nodeId, `-${entry.attempt}`)) as WorktreeMetadata; expected = evidenceOnly(value).evidenceDigest; } catch {} }
        else if (entry.kind === "telemetry") { try { const values = readJson(telemetryPath); expected = Array.isArray(values) && values.some((item) => item?.recordDigest === entry.artifactDigest && item.recordDigest === telemetryDigest(item as WorkflowTelemetryRecord)) ? entry.artifactDigest : undefined; } catch {} }
        else if (entry.kind === "manifest") { try { expected = sha256(canonical(validateExpansionManifest(readJson(manifestPath)))); } catch {} }
        if (expected !== entry.artifactDigest) invalid();
      }
      // Ledger sidecars may have been durably published immediately before a
      // crash interrupted state publication. Reconcile them into state before
      // any caller can spend budget or trust provenance.
      try {
        const sidecarTelemetryValue = existsSync(telemetryPath) ? readJson(telemetryPath) : [];
        const bindingMetadata = (() => { try { return loadWorkflowRunMetadata(); } catch { return undefined; } })();
        if (!Array.isArray(sidecarTelemetryValue) || sidecarTelemetryValue.some((item) => !Value.Check(schemas.WorkflowTelemetryRecordSchema, item) || (item as WorkflowTelemetryRecord).recordDigest !== telemetryDigest(item as WorkflowTelemetryRecord) || options.requireBindings && (!bindingMetadata || !exactLedgerBinding(item as WorkflowTelemetryRecord, bindingMetadata)))) invalid();
        const sidecarTelemetry = [...(sidecarTelemetryValue as readonly WorkflowTelemetryRecord[])];
        if (!isDeepStrictEqual(sidecarTelemetry, loaded.telemetry ?? [])) { loaded = { ...loaded, telemetry: sidecarTelemetry }; changed = true; }
      } catch (error) { if (!((error as { code?: unknown })?.code === "missing")) throw error; }
      try {
        const sidecarProvenanceValue = existsSync(provenancePath) ? readJson(provenancePath) : [];
        const bindingMetadata = (() => { try { return loadWorkflowRunMetadata(); } catch { return undefined; } })();
        if (!Array.isArray(sidecarProvenanceValue) || sidecarProvenanceValue.some((item) => !Value.Check(schemas.WorkflowArtifactProvenanceSchema, item) || options.requireBindings && (!bindingMetadata || !exactLedgerBinding(item as WorkflowArtifactProvenance, bindingMetadata)))) invalid();
        const sidecarProvenance = [...(sidecarProvenanceValue as readonly WorkflowArtifactProvenance[])];
        if (!isDeepStrictEqual(sidecarProvenance, loaded.provenance ?? [])) { loaded = { ...loaded, provenance: sidecarProvenance }; changed = true; }
      } catch (error) { if (!((error as { code?: unknown })?.code === "missing")) throw error; }
      // Repair the crash window where an immutable sidecar was published just
      // before its provenance append. Only exact artifacts bound to the
      // current run metadata may be synthesized.
      const binding = (() => { try { return loadWorkflowRunMetadata(); } catch { return undefined; } })();
      if (binding?.runId && binding.topology?.topologyDigest) {
        const repaired = [...(loaded.provenance ?? [])]; const keys = new Set(repaired.map((entry) => `${entry.kind}:${entry.nodeId ?? ""}:${entry.attempt ?? 0}:${entry.artifactDigest}`));
        const repair = (entry: WorkflowArtifactProvenance) => { const key = `${entry.kind}:${entry.nodeId ?? ""}:${entry.attempt ?? 0}:${entry.artifactDigest}`; if (!keys.has(key)) { repaired.push(entry); keys.add(key); changed = true; } };
        for (const [nodeId, result] of Object.entries(results)) repair({ version: 1, workflowId, runId: binding.runId, workflowIntegrity: binding.workflowIntegrity, topologyDigest: binding.topology.topologyDigest, kind: "result", nodeId, ...(result.attempt ? { attempt: result.attempt } : {}), artifactId: `${nodeId}.${result.attempt ?? 0}.result.recovered`, artifactDigest: sha256(canonical(result)), capturedAt: result.finishedAt });
        for (const [nodeId, list] of Object.entries(gates)) for (const gate of list) repair({ version: 1, workflowId, runId: binding.runId, workflowIntegrity: binding.workflowIntegrity, topologyDigest: binding.topology.topologyDigest, kind: "gate", nodeId, ...(gate.attempt ? { attempt: gate.attempt } : {}), artifactId: `${nodeId}.${gate.attempt ?? 0}.gate.recovered`, artifactDigest: gate.gateDigest, capturedAt: gate.checkedAt });
        for (const [key, evidence] of Object.entries(worktrees)) repair({ version: 1, workflowId, runId: binding.runId, workflowIntegrity: binding.workflowIntegrity, topologyDigest: binding.topology.topologyDigest, kind: "worktree", nodeId: evidence.nodeId, attempt: evidence.attempt, artifactId: `${evidence.nodeId}.${evidence.attempt}.worktree.recovered`, artifactDigest: evidence.evidenceDigest, capturedAt: evidence.capturedAt });
        // Telemetry is an independently durable budget ledger. If a crash
        // happened after its sidecar append but before the provenance/state
        // append, synthesize the exact bound entry rather than dropping usage.
        for (const record of loaded.telemetry ?? []) repair({ version: 1, workflowId, runId: binding.runId, workflowIntegrity: binding.workflowIntegrity, topologyDigest: binding.topology.topologyDigest, kind: "telemetry", nodeId: record.nodeId, attempt: record.attempt, artifactId: `${record.nodeId}.${record.attempt}.telemetry.recovered`, artifactDigest: record.recordDigest, capturedAt: record.capturedAt });
        if (!isDeepStrictEqual(repaired, loaded.provenance ?? [])) { loaded = { ...loaded, provenance: repaired }; atomicJson(provenancePath, repaired, MAX_STATE_BYTES); }
      }
      for (const entry of loaded.provenance ?? []) {
        let expected: string | undefined;
        if (entry.kind === "result" && entry.nodeId) { try { expected = sha256(canonical(loadTaskResult(entry.nodeId))); } catch {} }
        else if (entry.kind === "gate" && entry.nodeId) { try { const values = readJson(pathFor("gates", entry.nodeId)); expected = Array.isArray(values) && values.some((item) => item?.gateDigest === entry.artifactDigest) ? entry.artifactDigest : undefined; } catch {} }
        else if (entry.kind === "worktree" && entry.nodeId && entry.attempt) { try { expected = evidenceOnly(readJson(pathFor("worktree", entry.nodeId, `-${entry.attempt}`)) as WorktreeMetadata).evidenceDigest; } catch {} }
        else if (entry.kind === "telemetry") { try { const values = readJson(telemetryPath); expected = Array.isArray(values) && values.some((item) => item?.recordDigest === entry.artifactDigest && item.recordDigest === telemetryDigest(item as WorkflowTelemetryRecord)) ? entry.artifactDigest : undefined; } catch {} }
        else if (entry.kind === "manifest") { try { expected = sha256(canonical(validateExpansionManifest(readJson(manifestPath)))); } catch {} }
        if (expected !== entry.artifactDigest) invalid();
      }
      if (!changed) return { ok: true, value: loaded }; const recovered: WorkflowState = { ...loaded, status: "recovered", nodes, ...(Object.keys(results).length ? { results } : {}), ...(Object.keys(attempts).length ? { attempts } : {}), ...(Object.keys(gates).length ? { gates } : {}), ...(Object.keys(worktrees).length ? { worktrees } : {}), updatedAt: Date.now() }; const checked = validateWorkflowState(recovered, { workflowId, sessionId }); if (!checked.ok) invalid(checked.issues); atomicJson(statePath, recovered, MAX_STATE_BYTES); return { ok: true, value: recovered };
    } catch (error) { return { ok: false, error: error instanceof WorkflowStorageError ? error : new WorkflowStorageError("io") }; } },
  };
}
export interface WorkflowHistoryIndexEntry { readonly workflowId: string; readonly runId: string; readonly status: WorkflowRunMetadata["status"]; readonly updatedAt?: number; readonly revision?: number; readonly workflowIntegrity: string; readonly topologyDigest?: string; }
export function enumerateWorkflowRunMetadata(sessionDir: string, sessionId: string, options: { readonly limit?: number; readonly cursor?: string } = {}): { readonly entries: readonly WorkflowHistoryIndexEntry[]; readonly nextCursor?: string; readonly diagnostics?: readonly string[] } {
  const root = join(safeSessionDir(sessionDir), "artifacts", safeId(sessionId), "workflow");
  let names: string[]; try { names = readdirSync(root); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { entries: [] }; throw new WorkflowStorageError("io", "workflow history index unavailable"); }
  const limit = options.limit ?? 32; if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new WorkflowStorageError("invalid-data", "workflow history limit is invalid");
  const sorted = names.filter((name) => ID.test(name)).sort(); const start = options.cursor ? sorted.indexOf(options.cursor) + 1 : 0; if (options.cursor && start === 0) throw new WorkflowStorageError("invalid-data", "workflow history cursor is invalid");
  const entries: WorkflowHistoryIndexEntry[] = []; const diagnostics: string[] = [];
  for (const workflowId of sorted.slice(start, start + limit)) { try { const storage = createWorkflowStorage(sessionDir, sessionId, workflowId); const metadata = storage.loadWorkflowRunMetadata(); entries.push({ workflowId, runId: metadata.runId, status: metadata.status, ...(metadata.updatedAt !== undefined ? { updatedAt: metadata.updatedAt } : {}), ...(metadata.revision !== undefined ? { revision: metadata.revision } : {}), workflowIntegrity: metadata.workflowIntegrity, ...(metadata.topology ? { topologyDigest: metadata.topology.topologyDigest } : {}) }); } catch (error) { diagnostics.push(`${workflowId}: ${error instanceof Error ? error.message : "corrupt workflow artifact"}`); } }
  const last = sorted[start + Math.min(limit, sorted.length - start) - 1]; return { entries: Object.freeze(entries), ...(diagnostics.length ? { diagnostics: Object.freeze(diagnostics.slice(0, 32)) } : {}), ...(start + Math.min(limit, sorted.length - start) < sorted.length && last ? { nextCursor: last } : {}) };
}
export const createStorage = createWorkflowStorage;
