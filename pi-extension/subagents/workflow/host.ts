import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, statSync, writeSync, realpathSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { compileGeneratedWorkflow, compileWorkflow, type CompiledWorkflow } from "./planner.ts";
import { executeWorkflow, type ExecutionResult, type WorkflowNodeLauncher } from "./executor.ts";
import { resolveWorkflowModels, type ResolvedWorkflowModels, type WorkflowModelRegistry } from "./models.ts";
import { bindWorkflowStorageFence, createWorkflowStorage, WorkflowStorageError, type WorkflowStorage } from "./storage.ts";
import { resolveWorkflowWorktreeRoot } from "./paths.ts";
import { GitWorktreeManager, loadVerifiedFileApprovalRecord, toWorktreeEvidence } from "./worktree.ts";
import { selectHostWorkflowTemplate, type HostWorkflowTemplate } from "./templates.ts";
import { claimWorkflowRun, getWorkflowRun, releaseWorkflowRun, shutdownWorkflowRuns } from "./registry.ts";
import { CoordinationLeaseManager, processStartIdentity, type CoordinationLease } from "./coordination.ts";
import type { ApplyApprovalRecord, GateResult, TaskNode, WorkflowRunMetadata, WorkflowRunStatus, WorkflowRunTemplate, WorkflowSpec } from "./types.ts";
import { workflowHistoryDetail, workflowHistoryList, type WorkflowHistoryEntry, type WorkflowHistoryList, type WorkflowHistoryQuery } from "./history.ts";
import type { ProviderTelemetryAdapter, TelemetryBudget } from "./telemetry.ts";
import type { UsageCoordinator } from "./usage-limit.ts";
import { constructTrustedRecipeNode, assertTrustedRecipe } from "./recipes.ts";
import { expandBounded, type ExpansionManifest } from "./expansion.ts";
import { invalidatedNodeIds } from "./revision.ts";
import { executeWebResearch, type WebResearchAdapter, type WebResearchPolicy, type WebResearchProvenance, type WebResearchRequest } from "./web-research.ts";

export interface WorkflowHostParent { readonly sessionId: string; readonly cwd: string; readonly sessionDir: string; }
export interface WorkflowHostOptions {
  readonly parent: WorkflowHostParent;
  readonly launcher: WorkflowNodeLauncher;
  readonly modelRegistry: WorkflowModelRegistry;
  readonly owner?: symbol;
  readonly clock?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly approvalSigningSecret?: string | Uint8Array;
  /** Durable cross-process mutation lease. Defaults to a session-scoped state file. */
  readonly coordination?: CoordinationLeaseManager;
  readonly coordinationOwnerId?: string;
  readonly coordinationGeneration?: number;
  readonly storageFactory?: (sessionDir: string, sessionId: string, workflowId: string) => WorkflowStorage;
  readonly worktreeFactory?: (options: { cwd: string; root: string; workflowId: string; now: () => number; approvalSigningSecret: string | Uint8Array }) => GitWorktreeManager;
  readonly telemetryAdapter?: ProviderTelemetryAdapter; readonly telemetryBudget?: TelemetryBudget; readonly telemetryRequired?: boolean; readonly webResearchAdapter?: WebResearchAdapter; readonly usageCoordinator?: UsageCoordinator; readonly onUsageReset?: (workflowId: string, callbackId: string) => void;
}
export interface WorkflowPlan { readonly metadata: WorkflowRunMetadata; readonly workflow: CompiledWorkflow; }
export interface WorkflowApprovalSummary { readonly token: string; readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly evidenceDigest: string; readonly changedFiles: readonly string[]; readonly changedFileCount: number; readonly gateDigests: readonly string[]; }
export interface WorkflowApplySummary { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly applied: true; }
export interface WorkflowApprovalPreview { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly evidenceDigest: string; readonly changedFiles: readonly string[]; readonly changedFileCount: number; readonly gateDigests: readonly string[]; }
export interface WorkflowApplyPreview { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly token: string; readonly evidenceDigest: string; }

const terminal = (status: WorkflowRunStatus): boolean => ["cancelled", "completed", "failed"].includes(status);
const plain = (workflow: CompiledWorkflow): WorkflowSpec => ({ version: workflow.version, id: workflow.id, sessionId: workflow.sessionId, objective: workflow.objective, ...(workflow.expertise ? { expertise: workflow.expertise } : {}), ...(workflow.capabilities ? { capabilities: workflow.capabilities } : {}), nodes: workflow.nodes, ...(workflow.bounds ? { bounds: workflow.bounds } : {}), ...(workflow.policy ? { policy: workflow.policy } : {}) });
const isNormalizedAbsolute = (path: string): boolean => isAbsolute(path) && resolve(path) === path && !path.includes("\0");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

function loadOrCreateApprovalSecret(options: WorkflowHostOptions, create = true): Buffer {
  if (options.approvalSigningSecret) { const bytes = Buffer.from(options.approvalSigningSecret); if (bytes.byteLength < 32) throw new Error("workflow approval signing secret is too short"); return bytes; }
  const configured = options.env?.PI_WORKFLOW_APPROVAL_SECRET ?? process.env.PI_WORKFLOW_APPROVAL_SECRET;
  if (configured) { const bytes = Buffer.from(configured, "utf8"); if (bytes.byteLength < 32) throw new Error("PI_WORKFLOW_APPROVAL_SECRET is too short"); return bytes; }
  const home = options.home ?? homedir(); if (!isNormalizedAbsolute(home)) throw new Error("workflow home must be absolute and normalized");
  const agentDirectory = join(home, ".pi", "agent"); const directory = join(agentDirectory, "workflow-secrets"); const path = join(directory, "approval.key");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const assertPrivateDir = (): void => {
    const check = (target: string, exactMode?: number): void => { const info = lstatSync(target); const mode = info.mode & 0o777; if (info.isSymbolicLink() || !info.isDirectory() || (exactMode !== undefined ? mode !== exactMode : (mode & 0o022) !== 0) || (uid !== undefined && info.uid !== uid)) throw new Error("workflow approval key directory is not trusted"); };
    try { check(home); } catch { throw new Error("workflow approval key ancestor is not trusted"); }
    for (const ancestor of [join(home, ".pi"), agentDirectory]) try { check(ancestor); } catch (error) { if (create && !existsSync(ancestor)) { mkdirSync(ancestor, { mode: 0o700 }); check(ancestor); } else throw error; }
    try { check(directory, 0o700); } catch { if (create && !existsSync(directory)) { mkdirSync(directory, { mode: 0o700 }); check(directory, 0o700); } else throw new Error("workflow approval key directory is not trusted"); }
  };
  const read = (): Buffer => { let fd: number | undefined; try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const info = fstatSync(fd); if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid) || info.size < 44 || info.size > 256) throw new Error("workflow approval key is invalid"); const bytes = Buffer.alloc(info.size); let offset = 0; while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; } if (offset !== bytes.length) throw new Error("workflow approval key is invalid"); const value = Buffer.from(bytes.toString("utf8").trim(), "base64"); if (value.byteLength !== 32) throw new Error("workflow approval key is invalid"); return value; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} } };
  assertPrivateDir();
  if (existsSync(path)) return read();
  if (!create) throw new Error("workflow approval key is unavailable");
  const secret = randomBytes(32); let fd: number | undefined;
  try { fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600); const body = Buffer.from(`${secret.toString("base64")}\n`); writeSync(fd, body, 0, body.length); fsyncSync(fd); closeSync(fd); fd = undefined; chmodSync(path, 0o600); return secret; }
  catch (error) { if (fd !== undefined) try { closeSync(fd); } catch {} if (existsSync(path)) return read(); throw error; }
}

export class WorkflowHost {
  private readonly options: WorkflowHostOptions;
  private readonly now: () => number;
  private readonly owner: symbol;
  private readonly coordination: CoordinationLeaseManager;
  private readonly coordinationOwnerId: string;
  private readonly coordinationGeneration: number;
  private readonly plans = new Map<string, WorkflowPlan>();
  private readonly managers = new Map<string, GitWorktreeManager>();
  private readonly pauseCallbacks = new Set<string>();
  constructor(options: WorkflowHostOptions) {
    if (!options?.parent || !options.launcher || !options.modelRegistry) throw new Error("WorkflowHost requires parent, launcher, and model registry");
    if (!isNormalizedAbsolute(options.parent.cwd) || !isNormalizedAbsolute(options.parent.sessionDir)) throw new Error("workflow parent paths must be absolute and normalized");
    try {
      if (realpathSync(options.parent.cwd) !== options.parent.cwd) throw new Error("workflow parent cwd must be canonical");
      try {
        const gitRoot = execFileSync("git", ["-C", options.parent.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (gitRoot && realpathSync(gitRoot) !== options.parent.cwd) throw new Error("workflow parent cwd must equal git repository root");
      } catch (error) { if (error instanceof Error && /must equal/.test(error.message)) throw error; }
    } catch { throw new Error("workflow parent cwd is unavailable or not canonical"); }
    this.options = options; this.now = options.clock ?? Date.now; this.owner = options.owner ?? Symbol("workflow-host-owner");
    this.coordination = options.coordination ?? CoordinationLeaseManager.forAgentState(options.home ?? homedir(), this.now);
    this.coordinationOwnerId = options.coordinationOwnerId ?? `host-${process.pid}-${randomUUID().slice(0, 12)}`;
    this.coordinationGeneration = options.coordinationGeneration ?? 0;
  }
  private storage(id: string): WorkflowStorage { return this.options.storageFactory ? this.options.storageFactory(this.options.parent.sessionDir, this.options.parent.sessionId, id) : createWorkflowStorage(this.options.parent.sessionDir, this.options.parent.sessionId, id, { requireBindings: true }); }
  private expectedRoot(workflowId: string): string { return resolveWorkflowWorktreeRoot({ cwd: this.options.parent.cwd, sessionId: this.options.parent.sessionId, workflowId, env: this.options.env, home: this.options.home }); }
  private mutationLease(workflow: CompiledWorkflow, metadata: WorkflowRunMetadata): CoordinationLease {
    const scopes = workflow.nodes.filter((node) => node.mode === "mutating").flatMap((node) => node.allowGlobs ?? []);
    return this.coordination.acquire({ ownerId: this.coordinationOwnerId, ownerPid: process.pid, ownerProcessStartTime: processStartIdentity(), workflowId: metadata.workflowId, runId: metadata.runId, sessionId: metadata.sessionId, generation: this.coordinationGeneration, repositoryRoot: metadata.cwd, objective: workflow.objective, mode: "mutating", ...(scopes.length ? { pathScopes: scopes } : {}) });
  }
  private manager(workflow: CompiledWorkflow, metadata: WorkflowRunMetadata): GitWorktreeManager {
    if (metadata.template !== "build" || !metadata.worktreeRoot) throw new Error("build run is missing persisted worktree root");
    if (metadata.worktreeRoot !== this.expectedRoot(workflow.id)) throw new Error("persisted worktree root does not match host policy");
    const existing = this.managers.get(workflow.id); if (existing) return existing;
    const secret = loadOrCreateApprovalSecret(this.options); let manager: GitWorktreeManager;
    try { manager = (this.options.worktreeFactory ?? ((value) => new GitWorktreeManager(value)))({ cwd: metadata.cwd, root: metadata.worktreeRoot, workflowId: workflow.id, now: this.now, approvalSigningSecret: secret }); } finally { secret.fill(0); }
    this.managers.set(workflow.id, manager); return manager;
  }
  private loadPlan(workflowId: string): WorkflowPlan {
    const cached = this.plans.get(workflowId); if (cached) return cached;
    const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata(); const workflow = compileWorkflow(storage.loadWorkflowSpec(), { addValidationGates: false });
    if (workflow.integrity !== metadata.workflowIntegrity || metadata.workflowId !== workflow.id || metadata.sessionId !== this.options.parent.sessionId || metadata.cwd !== this.options.parent.cwd) throw new Error("workflow plan integrity or ownership mismatch");
    if (!metadata.topology || JSON.stringify(metadata.topology) !== JSON.stringify(workflow.topology)) throw new Error("workflow topology binding is missing or mismatched; migrate by creating a new plan");
    if (metadata.template === "build" && metadata.worktreeRoot !== this.expectedRoot(workflowId)) throw new Error("persisted worktree root does not match host policy");
    const plan = Object.freeze({ metadata, workflow }); this.plans.set(workflowId, plan); return plan;
  }
  plan(input: { readonly workflowId: string; readonly generated: unknown; readonly template: WorkflowRunTemplate; readonly confirmMutation?: boolean; readonly recipeId?: string }): WorkflowPlan {
    const template = selectHostWorkflowTemplate(input.template);
    if (template.template === "build" && input.confirmMutation !== true) throw new Error("build workflow requires explicit confirmation");
    let workflow = compileGeneratedWorkflow(input.generated, { id: input.workflowId, sessionId: this.options.parent.sessionId, capabilities: template.capabilities, bounds: template.bounds, policy: { model: template.model, thinking: template.thinking }, defaultNode: { kernel: template.kernel, mode: template.mode, requiresWorktree: template.requiresWorktree, capabilities: template.capabilities, allowGlobs: template.allowGlobs, denyGlobs: template.denyGlobs, model: { tier: template.model.endsWith("sol") ? "sol" : "luna" }, retries: template.retries } });
    if (input.recipeId !== undefined) { const recipe = assertTrustedRecipe(input.recipeId); const recipeNode = constructTrustedRecipeNode(recipe.id, workflow.nodes.map((node) => node.id), template.capabilities, template.allowGlobs, template.denyGlobs); workflow = compileWorkflow({ ...plain(workflow), nodes: [...workflow.nodes, recipeNode] }, { addValidationGates: false }); }
    resolveWorkflowModels(workflow, this.options.modelRegistry); // Authenticate every exact model before persistence/root derivation.
    const worktreeRoot = template.template === "build" ? this.expectedRoot(input.workflowId) : undefined; const updatedAt = this.now();
    const metadata: WorkflowRunMetadata = { version: 1, runId: randomUUID(), workflowId: input.workflowId, sessionId: this.options.parent.sessionId, cwd: this.options.parent.cwd, ...(worktreeRoot ? { worktreeRoot } : {}), workflowIntegrity: workflow.integrity, topology: workflow.topology, revision: 1, template: template.template, status: "pending", updatedAt };
    const storage = this.storage(input.workflowId); storage.createWorkflowPlan(plain(workflow), metadata);
    const plan = Object.freeze({ metadata, workflow }); this.plans.set(input.workflowId, plan); return plan;
  }
  revise(input: { readonly workflowId: string; readonly newWorkflowId: string; readonly generated: unknown; readonly template?: WorkflowRunTemplate; readonly confirmMutation?: boolean; readonly recipeId?: string }): WorkflowPlan {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.newWorkflowId) || input.newWorkflowId === input.workflowId) throw new Error("revised workflow ID is invalid or reused");
    const parent = this.loadPlan(input.workflowId); const template = selectHostWorkflowTemplate(input.template ?? parent.metadata.template);
    if (template.template === "build" && input.confirmMutation !== true) throw new Error("revised build workflow requires explicit confirmation");
    let workflow = compileGeneratedWorkflow(input.generated, { id: input.newWorkflowId, sessionId: this.options.parent.sessionId, capabilities: template.capabilities, bounds: template.bounds, policy: { model: template.model, thinking: template.thinking }, defaultNode: { kernel: template.kernel, mode: template.mode, requiresWorktree: template.requiresWorktree, capabilities: template.capabilities, allowGlobs: template.allowGlobs, denyGlobs: template.denyGlobs, model: { tier: template.model.endsWith("sol") ? "sol" : "luna" }, retries: template.retries } });
    if (input.recipeId !== undefined) { const recipe = assertTrustedRecipe(input.recipeId); const recipeNode = constructTrustedRecipeNode(recipe.id, workflow.nodes.map((node) => node.id), template.capabilities, template.allowGlobs, template.denyGlobs); workflow = compileWorkflow({ ...plain(workflow), nodes: [...workflow.nodes, recipeNode] }, { addValidationGates: false }); }
    resolveWorkflowModels(workflow, this.options.modelRegistry);
    const invalidated = invalidatedNodeIds(parent.workflow, workflow); if (!invalidated.length) throw new Error("revised workflow has no changed or invalidated nodes"); const worktreeRoot = template.template === "build" ? this.expectedRoot(input.newWorkflowId) : undefined; const updatedAt = this.now(); const metadata: WorkflowRunMetadata = { version: 1, runId: randomUUID(), workflowId: input.newWorkflowId, sessionId: this.options.parent.sessionId, cwd: this.options.parent.cwd, ...(worktreeRoot ? { worktreeRoot } : {}), workflowIntegrity: workflow.integrity, topology: workflow.topology, revision: (parent.metadata.revision ?? 1) + 1, parentWorkflowId: parent.metadata.workflowId, parentRunId: parent.metadata.runId, parentIntegrity: parent.workflow.integrity, invalidatedNodeIds: invalidated, template: template.template, status: "pending", updatedAt };
    const storage = this.storage(input.newWorkflowId); const lease = this.mutationLease(parent.workflow, parent.metadata);
    try {
      storage.createWorkflowPlan(plain(workflow), metadata); const plan = Object.freeze({ metadata, workflow });
      this.importRevisionReadOnlyResults(parent, plan, storage, invalidated);
      this.plans.set(input.newWorkflowId, plan); return plan;
    } finally { try { this.coordination.release(lease); } catch {} }
  }
  private importRevisionReadOnlyResults(parent: WorkflowPlan, revised: WorkflowPlan, destination: WorkflowStorage, invalidated: readonly string[]): void {
    let sourceState: import("./types.ts").WorkflowState; let sourceProvenance: readonly import("./types.ts").WorkflowArtifactProvenance[];
    try { sourceState = this.storage(parent.metadata.workflowId).loadWorkflowState(); sourceProvenance = [...this.storage(parent.metadata.workflowId).loadWorkflowProvenance()]; } catch (error) { if (error instanceof WorkflowStorageError && error.code === "missing") return; throw error; }
    if (sourceState.status !== "completed" && sourceState.status !== "recovered") return;
    const invalid = new Set(invalidated); const importedNodes = revised.workflow.nodes.filter((node) => !invalid.has(node.id) && node.mode === "read-only" && parent.workflow.dag.byId.get(node.id)?.mode === "read-only");
    const results: Record<string, import("./types.ts").TaskResult> = {}; const attempts: Record<string, readonly import("./types.ts").NodeAttempt[]> = {}; const provenance: import("./types.ts").WorkflowArtifactProvenance[] = [];
    for (const node of importedNodes) {
      const sourceNode = parent.workflow.dag.byId.get(node.id); const sourceResult = sourceState.results?.[node.id]; const sourceAttempts = sourceState.attempts?.[node.id];
      if (!sourceNode || !sourceResult || sourceState.nodes[node.id] !== "succeeded" || sourceResult.status !== "succeeded" || !sourceResult.attempt || !sourceAttempts?.length || sourceAttempts.at(-1)?.status !== "succeeded") continue;
      const sourceDigest = digest(sourceResult); const sourceEntry = sourceProvenance.find((entry) => entry.kind === "result" && entry.nodeId === node.id && entry.attempt === sourceResult.attempt && entry.artifactDigest === sourceDigest);
      if (!sourceEntry || sourceEntry.workflowId !== parent.metadata.workflowId || sourceEntry.runId !== parent.metadata.runId || sourceEntry.workflowIntegrity !== parent.workflow.integrity || sourceEntry.topologyDigest !== parent.workflow.topology.topologyDigest) continue;
      const imported: import("./types.ts").TaskResult = Object.freeze({ ...sourceResult, workflowId: revised.workflow.id, workflowIntegrity: revised.workflow.integrity, topologyDigest: revised.workflow.topology.topologyDigest });
      destination.saveTaskResult(imported); const importedAttempts = sourceAttempts.map((attempt, index) => Object.freeze({ ...attempt, workflowId: revised.workflow.id, ...(index === sourceAttempts.length - 1 ? { status: "succeeded" as const, classification: "imported" as const } : { classification: "imported" as const }) })); for (const importedAttempt of importedAttempts) destination.saveNodeAttempt(importedAttempt); results[node.id] = imported; attempts[node.id] = importedAttempts;
      const entry: import("./types.ts").WorkflowArtifactProvenance = Object.freeze({ version: 1, workflowId: revised.workflow.id, runId: revised.metadata.runId, workflowIntegrity: revised.workflow.integrity, topologyDigest: revised.workflow.topology.topologyDigest, kind: "result", nodeId: node.id, attempt: imported.attempt, artifactId: `${node.id}.${imported.attempt}.result.imported`, artifactDigest: digest(imported), capturedAt: imported.finishedAt, importedFromWorkflowId: parent.metadata.workflowId, importedFromRunId: parent.metadata.runId, importedFromArtifactDigest: sourceDigest });
      destination.saveWorkflowProvenance(entry); provenance.push(entry);
    }
    if (Object.keys(results).length) destination.saveWorkflowState({ version: 1, workflowId: revised.workflow.id, sessionId: revised.workflow.sessionId, runId: revised.metadata.runId, status: "recovered", nodes: Object.fromEntries(revised.workflow.nodes.map((node) => [node.id, results[node.id]?.status ?? "pending"])), results, attempts, provenance, updatedAt: this.now() });
  }
  rerun(input: { readonly workflowId: string; readonly newWorkflowId: string; readonly confirmMutation?: boolean }): WorkflowPlan {
    const parent = this.loadPlan(input.workflowId); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.newWorkflowId) || input.newWorkflowId === input.workflowId) throw new Error("rerun workflow ID is invalid or reused"); if (parent.metadata.template === "build" && input.confirmMutation !== true) throw new Error("rerun build workflow requires explicit confirmation"); const workflow = compileWorkflow({ ...plain(parent.workflow), id: input.newWorkflowId }, { addValidationGates: false }); resolveWorkflowModels(workflow, this.options.modelRegistry); const worktreeRoot = parent.metadata.template === "build" ? this.expectedRoot(input.newWorkflowId) : undefined; const metadata: WorkflowRunMetadata = { version: 1, runId: randomUUID(), workflowId: input.newWorkflowId, sessionId: this.options.parent.sessionId, cwd: this.options.parent.cwd, ...(worktreeRoot ? { worktreeRoot } : {}), workflowIntegrity: workflow.integrity, topology: workflow.topology, revision: (parent.metadata.revision ?? 1) + 1, parentWorkflowId: parent.metadata.workflowId, parentRunId: parent.metadata.runId, parentIntegrity: parent.workflow.integrity, invalidatedNodeIds: workflow.nodes.map((node) => node.id), template: parent.metadata.template, status: "pending", updatedAt: this.now() }; const storage = this.storage(input.newWorkflowId); storage.createWorkflowPlan(plain(workflow), metadata); const plan = Object.freeze({ metadata, workflow }); this.plans.set(input.newWorkflowId, plan); return plan;
  }
  private execute(workflow: CompiledWorkflow, metadata: WorkflowRunMetadata, storage: WorkflowStorage, models: ResolvedWorkflowModels, controller: AbortController, recoveredState?: unknown, fence?: () => void): Promise<ExecutionResult> {
    const template = selectHostWorkflowTemplate(metadata.template); const manager = metadata.template === "build" ? this.manager(workflow, metadata) : undefined; if (manager && fence) manager.setFence(fence);
    return executeWorkflow(workflow, { launcher: this.options.launcher, storage, recoveredState: recoveredState as any, cwd: metadata.cwd, runId: metadata.runId, signal: controller.signal, telemetryAdapter: this.options.telemetryAdapter, telemetryBudget: this.options.telemetryBudget, telemetryRequired: this.options.telemetryRequired, usageCoordinator: this.options.usageCoordinator, onUsageReset: (callbackId) => { try { this.options.onUsageReset?.(metadata.workflowId, callbackId); } finally { this.coordinatorResume(metadata.workflowId, callbackId); } }, resolvedModels: Object.fromEntries(Object.entries(models.byNodeId).map(([id, item]) => [id, { model: item.model, thinking: item.thinking }])), hostPolicy: { approvedCapabilities: template.capabilities, nativeAllowlist: template.allowedTools, allowedArgv: [] }, ...(manager ? { worktree: manager } : {}) });
  }
  private start(plan: WorkflowPlan, recoveredState: unknown, requireMutationConfirmation: boolean, models: ResolvedWorkflowModels, preclaimedLease?: CoordinationLease): Promise<ExecutionResult> {
    const storage = this.storage(plan.metadata.workflowId); const current = storage.loadWorkflowRunMetadata();
    if (current.template === "build" && !requireMutationConfirmation) throw new Error("starting a build workflow requires explicit confirmation");
    // Models were authenticated by run/resume before any claim or durable mutation.
    if (getWorkflowRun(this.options.parent.sessionId, current.workflowId)) throw new Error("workflow is already running in this session");
    const controller = new AbortController(); let resolvePublic!: (value: ExecutionResult) => void; let rejectPublic!: (reason: unknown) => void;
    const publicPromise = new Promise<ExecutionResult>((resolveValue, rejectValue) => { resolvePublic = resolveValue; rejectPublic = rejectValue; });
    claimWorkflowRun({ runId: current.runId, owner: this.owner, controller, promise: publicPromise, metadata: current });
    const mutating = plan.workflow.nodes.some((node) => node.mode === "mutating");
    const scopes = plan.workflow.nodes.filter((node) => node.mode === "mutating").flatMap((node) => node.allowGlobs ?? []);
    let lease: CoordinationLease;
    try {
      lease = preclaimedLease ?? this.coordination.acquire({ ownerId: this.coordinationOwnerId, ownerPid: process.pid, ownerProcessStartTime: processStartIdentity(), workflowId: current.workflowId, runId: current.runId, sessionId: current.sessionId, generation: this.coordinationGeneration, repositoryRoot: current.cwd, objective: plan.workflow.objective, mode: mutating ? "mutating" : "read-only", ...(mutating && scopes.length ? { pathScopes: scopes } : {}) });
    } catch (error) {
      releaseWorkflowRun(this.options.parent.sessionId, current.workflowId, current.runId);
      rejectPublic(error); return publicPromise;
    }
    const startedAt = current.startedAt ?? this.now(); const running: WorkflowRunMetadata = { ...current, status: "running", startedAt, updatedAt: this.now(), finishedAt: undefined };
    const fence = () => { lease = this.coordination.refresh(lease); };
    const guardedStorage = bindWorkflowStorageFence(storage, fence);
    try { guardedStorage.saveWorkflowRunMetadata(running); }
    catch (error) { this.coordination.release(lease); releaseWorkflowRun(this.options.parent.sessionId, current.workflowId, current.runId); rejectPublic(error); return publicPromise; }
    const leaseTimer = setInterval(() => { try { fence(); } catch { controller.abort(); } }, Math.max(1_000, Math.floor((lease.expiresAt - lease.acquiredAt) / 3)));
    leaseTimer.unref?.();
    let operation: Promise<ExecutionResult>;
    try { operation = this.execute(plan.workflow, running, guardedStorage, models, controller, recoveredState, fence); }
    catch (error) { operation = Promise.reject(error); }
    operation.then((result) => {
      const status: WorkflowRunStatus = result.state.status === "cancelled" ? "cancelled" : result.state.status === "paused" ? "paused" : result.state.status === "completed" ? "completed" : "failed"; const finishedAt = this.now();
      try { guardedStorage.saveWorkflowRunMetadata({ ...running, status, ...(result.state.pause ? { pause: result.state.pause } : {}), updatedAt: finishedAt, ...(status === "paused" ? {} : { finishedAt }) }); clearInterval(leaseTimer); try { this.coordination.release(lease); } catch {} resolvePublic(result); } catch (error) { rejectPublic(error); }
    }, (error) => {
      const finishedAt = this.now(); const status: WorkflowRunStatus = controller.signal.aborted ? "cancelled" : "failed";
      try { guardedStorage.saveWorkflowRunMetadata({ ...running, status, updatedAt: finishedAt, finishedAt }); } catch {} clearInterval(leaseTimer); try { this.coordination.release(lease); } catch {} rejectPublic(error);
    }).finally(() => { clearInterval(leaseTimer); try { this.coordination.release(lease); } catch {} releaseWorkflowRun(this.options.parent.sessionId, current.workflowId, current.runId); });
    return publicPromise;
  }
  private restorePauseCoordinator(metadata: WorkflowRunMetadata): void {
    const pause = metadata.pause; if (!pause?.callbackId || !this.options.usageCoordinator || this.pauseCallbacks.has(`${metadata.workflowId}:${pause.callbackId}`)) return;
    const key = `${metadata.workflowId}:${pause.callbackId}`; this.pauseCallbacks.add(key);
    const at = pause.resetAt ?? pause.pausedAt + (pause.retryAfterMs ?? 60_000);
    this.options.usageCoordinator.schedule(pause.callbackId, at, () => { this.pauseCallbacks.delete(key); this.coordinatorResume(metadata.workflowId, pause.callbackId!); });
  }
  private coordinatorResume(workflowId: string, callbackId: string): void {
    try {
      const metadata = this.storage(workflowId).loadWorkflowRunMetadata();
      if (metadata.status !== "paused" || metadata.pause?.callbackId !== callbackId) return;
      void this.resume(workflowId, metadata.template === "build").catch(() => undefined);
    } catch { /* stale callbacks and corrupted artifacts fail closed */ }
  }
  run(workflowId: string, confirmMutation = false): Promise<ExecutionResult> {
    const plan = this.loadPlan(workflowId); if (plan.metadata.status !== "pending" && plan.metadata.status !== "recovered") throw new Error("only a pending or recovered workflow can be started"); const models = resolveWorkflowModels(plan.workflow, this.options.modelRegistry);
    // Revisions publish a recovered state while their run metadata remains
    // pending. Detect that exact persisted snapshot and reconcile it through
    // trusted storage; never infer or reuse results from an in-memory parent.
    let recoveredState: import("./types.ts").WorkflowState | undefined;
    try { const persisted = this.storage(workflowId).loadWorkflowState(); if (persisted.status === "recovered") recoveredState = persisted; }
    catch (error) { if (!(error instanceof WorkflowStorageError && error.code === "missing")) throw error; }
    if (recoveredState) { if (recoveredState.runId !== plan.metadata.runId) throw new Error("recovered revision run ownership mismatch"); const recovered = this.storage(workflowId).recoverWorkflowState(); if (!recovered.ok) throw (recovered as { readonly ok: false; readonly error: WorkflowStorageError }).error; return this.start(plan, recovered.value, confirmMutation, models); }
    return this.start(plan, undefined, confirmMutation, models);
  }
  resume(workflowId: string, confirmMutation = false): Promise<ExecutionResult> {
    const plan = this.loadPlan(workflowId); const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata(); if (terminal(metadata.status) || metadata.status === "pending") throw new Error("workflow is not resumable");
    if (metadata.template === "build" && confirmMutation !== true) throw new Error("resuming a build workflow requires explicit confirmation");
    this.restorePauseCoordinator(metadata);
    if (metadata.pause?.callbackId) { this.options.usageCoordinator?.cancel?.(metadata.pause.callbackId); this.pauseCallbacks.delete(`${workflowId}:${metadata.pause.callbackId}`); }
    // Acquire the durable lease before recovery or any metadata mutation. A
    // second process therefore fails closed without rewriting the active run.
    const mutating = plan.workflow.nodes.some((node) => node.mode === "mutating"); const scopes = plan.workflow.nodes.filter((node) => node.mode === "mutating").flatMap((node) => node.allowGlobs ?? []);
    const lease = this.coordination.acquire({ ownerId: this.coordinationOwnerId, ownerPid: process.pid, ownerProcessStartTime: processStartIdentity(), workflowId: metadata.workflowId, runId: metadata.runId, sessionId: metadata.sessionId, generation: this.coordinationGeneration, repositoryRoot: metadata.cwd, objective: plan.workflow.objective, mode: mutating ? "mutating" : "read-only", ...(mutating && scopes.length ? { pathScopes: scopes } : {}) });
    try {
      const guardedStorage = bindWorkflowStorageFence(storage, () => this.coordination.refresh(lease));
      const models = resolveWorkflowModels(plan.workflow, this.options.modelRegistry);
      const recovered = guardedStorage.recoverWorkflowState(); if (!recovered.ok) throw (recovered as { readonly ok: false; readonly error: WorkflowStorageError }).error;
      const { pause: _pause, ...withoutPause } = metadata; const recoveredMetadata: WorkflowRunMetadata = { ...withoutPause, status: "recovered", startedAt: metadata.startedAt ?? this.now(), updatedAt: this.now(), finishedAt: undefined }; guardedStorage.saveWorkflowRunMetadata(recoveredMetadata);
      const resumed = Object.freeze({ metadata: recoveredMetadata, workflow: plan.workflow }); this.plans.set(workflowId, resumed); return this.start(resumed, recovered.value, confirmMutation, models, lease);
    } catch (error) { try { this.coordination.release(lease); } catch {} throw error; }
  }
  async cancel(workflowId: string): Promise<void> {
    const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata();
    if (metadata.status === "paused") { const plan = this.loadPlan(workflowId); const lease = this.mutationLease(plan.workflow, metadata); try { if (metadata.pause?.callbackId) this.options.usageCoordinator?.cancel?.(metadata.pause.callbackId); bindWorkflowStorageFence(storage, () => this.coordination.refresh(lease)).saveWorkflowRunMetadata({ ...metadata, status: "cancelled", updatedAt: this.now(), finishedAt: this.now(), pause: undefined }); } finally { try { this.coordination.release(lease); } catch {} } return; }
    const running = getWorkflowRun(this.options.parent.sessionId, workflowId); if (!running) {
      if (metadata.status === "running" || metadata.status === "recovered" || metadata.status === "cancelling") throw new Error("workflow is running in another process");
      return;
    }
    if (metadata.status === "running" || metadata.status === "recovered") storage.saveWorkflowRunMetadata({ ...metadata, status: "cancelling", updatedAt: this.now() });
    running.controller.abort(); await running.promise;
  }
  status(workflowId: string): WorkflowRunMetadata { const metadata = this.storage(workflowId).loadWorkflowRunMetadata(); this.restorePauseCoordinator(metadata); return metadata; }
  /** Bounded metadata-only history/detail projection; raw prompts, outputs, diffs, tokens, and secrets never leave storage. */
  history(workflowId: string): WorkflowHistoryEntry { return workflowHistoryDetail(this.storage(workflowId)); }
  historyList(query: WorkflowHistoryQuery = {}): WorkflowHistoryList { return workflowHistoryList(this.options.parent.sessionDir, this.options.parent.sessionId, query); }
  async research(workflowId: string, requests: readonly WebResearchRequest[], policy?: WebResearchPolicy): Promise<{ readonly provenance: readonly WebResearchProvenance[] }> { if (!this.options.webResearchAdapter) throw new Error("web research runtime is unavailable"); const plan = this.loadPlan(workflowId); const metadata = this.storage(workflowId).loadWorkflowRunMetadata(); const result = await executeWebResearch(requests, this.options.webResearchAdapter, policy); const storage = this.storage(workflowId); const lease = this.mutationLease(plan.workflow, metadata); try { const guarded = bindWorkflowStorageFence(storage, () => this.coordination.refresh(lease)); const prior = (() => { try { return [...guarded.loadWebResearchProvenance()]; } catch (error) { if (error instanceof WorkflowStorageError && error.code === "missing") return []; throw error; } })(); const combined = [...prior, ...result.provenance]; guarded.saveWebResearchProvenance(combined); return { provenance: result.provenance }; } finally { try { this.coordination.release(lease); } catch {} } }
  expandAndPlan(workflowId: string, newWorkflowId: string, upstreamNodeId: string, upstreamPath: string, recipeId: string, idPrefix = "expanded"): { readonly manifest: ExpansionManifest; readonly plan: WorkflowPlan } { const manifest = this.expand(workflowId, upstreamNodeId, upstreamPath, recipeId, idPrefix); const parent = this.loadPlan(workflowId); const generated = { objective: `${parent.workflow.objective} expanded`, nodes: manifest.items.map((item) => ({ id: item.id, objective: typeof item.input === "string" ? item.input : `Process expansion item ${item.id}`, input: item.input })) }; try { const plan = this.revise({ workflowId, newWorkflowId, generated, recipeId, confirmMutation: parent.metadata.template === "build" }); return { manifest, plan }; } catch (error) { // Crash recovery: manifest publication may precede revised-plan publication.
      try { const existing = this.loadPlan(newWorkflowId); if (existing.metadata.parentWorkflowId === workflowId && existing.metadata.parentIntegrity === parent.workflow.integrity) return { manifest, plan: existing }; } catch { /* preserve original failure */ } throw error; } }
  expand(workflowId: string, upstreamNodeId: string, upstreamPath: string, recipeId: string, idPrefix = "expanded"): ExpansionManifest {
    const plan = this.loadPlan(workflowId); const metadata = this.storage(workflowId).loadWorkflowRunMetadata(); const state = this.storage(workflowId).loadWorkflowState(); const result = state.results?.[upstreamNodeId]; if (!result || result.status !== "succeeded") throw new Error("expansion upstream result is unavailable"); const recipe = assertTrustedRecipe(recipeId); const upstreamRawDigest = result.rawEnvelopeDigest; if (!upstreamRawDigest) throw new Error("expansion requires an exact upstream raw envelope digest"); const manifest = expandBounded({ upstream: result.output, upstreamPath, idPrefix, recipe: { recipeId: recipe.id, recipeDigest: recipe.digest, maxItems: recipe.maxCandidates, maxItemBytes: 65_536, maxTotalBytes: 1_048_576 }, workflowId, runId: metadata.runId, workflowIntegrity: plan.workflow.integrity, topologyDigest: plan.workflow.topology.topologyDigest, upstreamNodeId, upstreamAttempt: result.attempt, upstreamRawDigest }); const storage = this.storage(workflowId); const lease = this.mutationLease(plan.workflow, metadata); try { const guarded = bindWorkflowStorageFence(storage, () => this.coordination.refresh(lease)); guarded.saveExpansionManifest(manifest); guarded.saveWorkflowProvenance({ version: 1, workflowId, runId: metadata.runId, workflowIntegrity: plan.workflow.integrity, topologyDigest: plan.workflow.topology.topologyDigest, kind: "manifest", artifactId: `manifest.${manifest.manifestId.slice(0, 24)}`, artifactDigest: digest(manifest), capturedAt: this.now() }); return manifest; } finally { try { this.coordination.release(lease); } catch {} }
  }
  statusSnapshot(workflowId: string): { readonly metadata: WorkflowRunMetadata; readonly nodes?: Readonly<Record<string, import("./types.ts").NodeStatus>> } {
    const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata(); this.restorePauseCoordinator(metadata);
    try { return { metadata, nodes: storage.loadWorkflowState().nodes }; }
    catch (error) {
      // A planned run has no state yet; corruption or missing state after a
      // start/resume is an actionable bounded error, never metadata-only.
      if (error instanceof WorkflowStorageError && error.code === "missing" && metadata.status === "pending") return { metadata };
      throw new WorkflowStorageError(error instanceof WorkflowStorageError ? error.code : "io", "workflow state is unavailable");
    }
  }
  private approvalEvidenceContext(workflowId: string, nodeId: string, attempt: number): { storage: WorkflowStorage; workflow: CompiledWorkflow; metadata: WorkflowRunMetadata; node: TaskNode; evidence: ReturnType<WorkflowStorage["loadWorktreeMetadata"]>; gates: GateResult[] } {
    const plan = this.loadPlan(workflowId); const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata(); if (metadata.status !== "completed" || metadata.template !== "build") throw new Error("only a completed build workflow can be approved");
    const node = plan.workflow.nodes.find((item) => item.id === nodeId); if (!node || node.mode !== "mutating") throw new Error("unknown mutating workflow node");
    const evidence = storage.loadWorktreeMetadata(nodeId, attempt); if (!evidence.workflowIntegrity || !evidence.topologyDigest || evidence.workflowIntegrity !== plan.workflow.integrity || evidence.topologyDigest !== plan.workflow.topology.topologyDigest) throw new Error("approval evidence topology provenance is missing or mismatched; migrate by creating a new run"); const gates: GateResult[] = [];
    for (const gateNode of plan.workflow.nodes.filter((item) => item.sourceNodeId === nodeId && item.gate)) for (const gate of storage.loadGateResults(gateNode.id)) if (gate.attempt === attempt && gate.evidenceDigest === evidence.evidenceDigest && gate.workflowIntegrity === plan.workflow.integrity && gate.topologyDigest === plan.workflow.topology.topologyDigest) gates.push(gate);
    if (gates.length < 3) throw new Error("required gate evidence is unavailable");
    return { storage, workflow: plan.workflow, metadata, node, evidence, gates };
  }
  private approvalContext(workflowId: string, nodeId: string, attempt: number): ReturnType<WorkflowHost["approvalEvidenceContext"]> & { manager: GitWorktreeManager; handle: any } {
    const context = this.approvalEvidenceContext(workflowId, nodeId, attempt); const manager = this.manager(context.workflow, context.metadata); manager.registerWorkflow(context.workflow); const handle = manager.adoptRecovered(toWorktreeEvidence(context.evidence), context.node); for (const gate of context.gates) manager.recordGateResult(gate);
    return Object.assign(context, { manager, handle });
  }
  previewApproval(workflowId: string, nodeId: string, attempt: number): WorkflowApprovalPreview {
    const context = this.approvalEvidenceContext(workflowId, nodeId, attempt);
    return { workflowId, nodeId, attempt, evidenceDigest: context.evidence.evidenceDigest, changedFiles: context.evidence.changedFiles.slice(0, 8).map((file) => file.slice(0, 96)), changedFileCount: context.evidence.changedFiles.length, gateDigests: context.gates.slice(0, 8).map((gate) => gate.gateDigest) };
  }
  previewApply(workflowId: string, nodeId: string, token: string): WorkflowApplyPreview {
    const plan = this.loadPlan(workflowId); const metadata = this.storage(workflowId).loadWorkflowRunMetadata(); if (metadata.template !== "build" || !metadata.worktreeRoot) throw new Error("approval ownership mismatch"); const secret = loadOrCreateApprovalSecret(this.options, false); let record: ApplyApprovalRecord; try { record = loadVerifiedFileApprovalRecord(join(metadata.worktreeRoot, ".approvals"), token, secret); } finally { secret.fill(0); }
    if (record.nodeId !== nodeId || record.workflowId !== workflowId || plan.workflow.id !== workflowId) throw new Error("approval ownership mismatch");
    return { workflowId, nodeId, attempt: record.attempt, token: record.token, evidenceDigest: record.evidenceDigest };
  }
  approve(workflowId: string, nodeId: string, attempt: number, confirmed: boolean): WorkflowApprovalSummary {
    if (confirmed !== true) throw new Error("approval requires explicit confirmation"); const plan = this.loadPlan(workflowId); const metadata = this.storage(workflowId).loadWorkflowRunMetadata(); let lease = this.mutationLease(plan.workflow, metadata);
    try { const existingManager = this.manager(plan.workflow, metadata); existingManager.setFence(() => { lease = this.coordination.refresh(lease); }); const context = this.approvalContext(workflowId, nodeId, attempt) as ReturnType<WorkflowHost["approvalContext"]> & { handle: any };
      const record = context.manager.issueApproval(context.handle, context.evidence, context.gates, context.node);
      return { token: record.token, workflowId, nodeId, attempt, evidenceDigest: record.evidenceDigest, changedFiles: context.evidence.changedFiles.slice(0, 8).map((file) => file.slice(0, 96)), changedFileCount: context.evidence.changedFiles.length, gateDigests: record.gateResultDigests.slice(0, 8) };
    } finally { try { this.coordination.release(lease); } catch {} }
  }
  apply(workflowId: string, nodeId: string, token: string, confirmed: boolean): WorkflowApplySummary {
    if (confirmed !== true) throw new Error("apply requires explicit confirmation"); const plan = this.loadPlan(workflowId); const metadata = this.storage(workflowId).loadWorkflowRunMetadata(); let lease = this.mutationLease(plan.workflow, metadata);
    try { const manager = this.manager(plan.workflow, metadata); manager.setFence(() => { lease = this.coordination.refresh(lease); }); const record: ApplyApprovalRecord = manager.loadApproval(token); if (record.nodeId !== nodeId || record.workflowId !== workflowId) throw new Error("approval ownership mismatch");
      const context = this.approvalContext(workflowId, nodeId, record.attempt) as ReturnType<WorkflowHost["approvalContext"]> & { handle: any }; context.manager.apply(context.handle, record, context.node); return { workflowId, nodeId, attempt: record.attempt, applied: true };
    } finally { try { this.coordination.release(lease); } catch {} }
  }
  shutdown(): Promise<void> { return shutdownWorkflowRuns(this.owner); }
}
export const createWorkflowHost = (options: WorkflowHostOptions): WorkflowHost => new WorkflowHost(options);
