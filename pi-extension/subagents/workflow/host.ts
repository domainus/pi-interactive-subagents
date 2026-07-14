import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { compileGeneratedWorkflow, compileWorkflow, type CompiledWorkflow } from "./planner.ts";
import { executeWorkflow, type ExecutionResult, type WorkflowNodeLauncher } from "./executor.ts";
import { resolveWorkflowModels, type ResolvedWorkflowModels, type WorkflowModelRegistry } from "./models.ts";
import { createWorkflowStorage, WorkflowStorageError, type WorkflowStorage } from "./storage.ts";
import { resolveWorkflowWorktreeRoot } from "./paths.ts";
import { GitWorktreeManager, loadVerifiedFileApprovalRecord, toWorktreeEvidence } from "./worktree.ts";
import { selectHostWorkflowTemplate, type HostWorkflowTemplate } from "./templates.ts";
import { claimWorkflowRun, getWorkflowRun, releaseWorkflowRun, shutdownWorkflowRuns } from "./registry.ts";
import type { ApplyApprovalRecord, GateResult, TaskNode, WorkflowRunMetadata, WorkflowRunStatus, WorkflowRunTemplate, WorkflowSpec } from "./types.ts";

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
  readonly storageFactory?: (sessionDir: string, sessionId: string, workflowId: string) => WorkflowStorage;
  readonly worktreeFactory?: (options: { cwd: string; root: string; workflowId: string; now: () => number; approvalSigningSecret: string | Uint8Array }) => GitWorktreeManager;
}
export interface WorkflowPlan { readonly metadata: WorkflowRunMetadata; readonly workflow: CompiledWorkflow; }
export interface WorkflowApprovalSummary { readonly token: string; readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly evidenceDigest: string; readonly changedFiles: readonly string[]; readonly changedFileCount: number; readonly gateDigests: readonly string[]; }
export interface WorkflowApplySummary { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly applied: true; }
export interface WorkflowApprovalPreview { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly evidenceDigest: string; readonly changedFiles: readonly string[]; readonly changedFileCount: number; readonly gateDigests: readonly string[]; }
export interface WorkflowApplyPreview { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly token: string; readonly evidenceDigest: string; }

const terminal = (status: WorkflowRunStatus): boolean => ["cancelled", "completed", "failed"].includes(status);
const plain = (workflow: CompiledWorkflow): WorkflowSpec => ({ version: workflow.version, id: workflow.id, sessionId: workflow.sessionId, objective: workflow.objective, ...(workflow.expertise ? { expertise: workflow.expertise } : {}), ...(workflow.capabilities ? { capabilities: workflow.capabilities } : {}), nodes: workflow.nodes, ...(workflow.bounds ? { bounds: workflow.bounds } : {}), ...(workflow.policy ? { policy: workflow.policy } : {}) });
const isNormalizedAbsolute = (path: string): boolean => isAbsolute(path) && resolve(path) === path && !path.includes("\0");

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
  private readonly plans = new Map<string, WorkflowPlan>();
  private readonly managers = new Map<string, GitWorktreeManager>();
  constructor(options: WorkflowHostOptions) {
    if (!options?.parent || !options.launcher || !options.modelRegistry) throw new Error("WorkflowHost requires parent, launcher, and model registry");
    if (!isNormalizedAbsolute(options.parent.cwd) || !isNormalizedAbsolute(options.parent.sessionDir)) throw new Error("workflow parent paths must be absolute and normalized");
    this.options = options; this.now = options.clock ?? Date.now; this.owner = options.owner ?? Symbol("workflow-host-owner");
  }
  private storage(id: string): WorkflowStorage { return (this.options.storageFactory ?? createWorkflowStorage)(this.options.parent.sessionDir, this.options.parent.sessionId, id); }
  private expectedRoot(workflowId: string): string { return resolveWorkflowWorktreeRoot({ cwd: this.options.parent.cwd, sessionId: this.options.parent.sessionId, workflowId, env: this.options.env, home: this.options.home }); }
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
    if (metadata.template === "build" && metadata.worktreeRoot !== this.expectedRoot(workflowId)) throw new Error("persisted worktree root does not match host policy");
    const plan = Object.freeze({ metadata, workflow }); this.plans.set(workflowId, plan); return plan;
  }
  plan(input: { readonly workflowId: string; readonly generated: unknown; readonly template: WorkflowRunTemplate; readonly confirmMutation?: boolean }): WorkflowPlan {
    const template = selectHostWorkflowTemplate(input.template);
    if (template.template === "build" && input.confirmMutation !== true) throw new Error("build workflow requires explicit confirmation");
    const workflow = compileGeneratedWorkflow(input.generated, { id: input.workflowId, sessionId: this.options.parent.sessionId, capabilities: template.capabilities, bounds: template.bounds, policy: { model: template.model, thinking: template.thinking }, defaultNode: { kernel: template.kernel, mode: template.mode, requiresWorktree: template.requiresWorktree, capabilities: template.capabilities, allowGlobs: template.allowGlobs, denyGlobs: template.denyGlobs, model: { tier: template.model.endsWith("sol") ? "sol" : "luna" }, retries: template.retries } });
    resolveWorkflowModels(workflow, this.options.modelRegistry); // Authenticate every exact model before persistence/root derivation.
    const worktreeRoot = template.template === "build" ? this.expectedRoot(input.workflowId) : undefined; const updatedAt = this.now();
    const metadata: WorkflowRunMetadata = { version: 1, runId: randomUUID(), workflowId: input.workflowId, sessionId: this.options.parent.sessionId, cwd: this.options.parent.cwd, ...(worktreeRoot ? { worktreeRoot } : {}), workflowIntegrity: workflow.integrity, template: template.template, status: "pending", updatedAt };
    const storage = this.storage(input.workflowId); storage.createWorkflowPlan(plain(workflow), metadata);
    const plan = Object.freeze({ metadata, workflow }); this.plans.set(input.workflowId, plan); return plan;
  }
  private execute(workflow: CompiledWorkflow, metadata: WorkflowRunMetadata, storage: WorkflowStorage, models: ResolvedWorkflowModels, controller: AbortController, recoveredState?: unknown): Promise<ExecutionResult> {
    const template = selectHostWorkflowTemplate(metadata.template); const manager = metadata.template === "build" ? this.manager(workflow, metadata) : undefined;
    return executeWorkflow(workflow, { launcher: this.options.launcher, storage, recoveredState: recoveredState as any, cwd: metadata.cwd, signal: controller.signal, resolvedModels: Object.fromEntries(Object.entries(models.byNodeId).map(([id, item]) => [id, { model: item.model, thinking: item.thinking }])), hostPolicy: { approvedCapabilities: template.capabilities, nativeAllowlist: template.allowedTools, allowedArgv: [] }, ...(manager ? { worktree: manager } : {}) });
  }
  private start(plan: WorkflowPlan, recoveredState: unknown, requireMutationConfirmation: boolean, models: ResolvedWorkflowModels): Promise<ExecutionResult> {
    const storage = this.storage(plan.metadata.workflowId); const current = storage.loadWorkflowRunMetadata();
    if (current.template === "build" && !requireMutationConfirmation) throw new Error("starting a build workflow requires explicit confirmation");
    // Models were authenticated by run/resume before any claim or durable mutation.
    if (getWorkflowRun(this.options.parent.sessionId, current.workflowId)) throw new Error("workflow is already running in this session");
    const controller = new AbortController(); let resolvePublic!: (value: ExecutionResult) => void; let rejectPublic!: (reason: unknown) => void;
    const publicPromise = new Promise<ExecutionResult>((resolveValue, rejectValue) => { resolvePublic = resolveValue; rejectPublic = rejectValue; });
    claimWorkflowRun({ runId: current.runId, owner: this.owner, controller, promise: publicPromise, metadata: current });
    const startedAt = current.startedAt ?? this.now(); const running: WorkflowRunMetadata = { ...current, status: "running", startedAt, updatedAt: this.now(), finishedAt: undefined };
    try { storage.saveWorkflowRunMetadata(running); }
    catch (error) { releaseWorkflowRun(this.options.parent.sessionId, current.workflowId, current.runId); rejectPublic(error); return publicPromise; }
    let operation: Promise<ExecutionResult>;
    try { operation = this.execute(plan.workflow, running, storage, models, controller, recoveredState); }
    catch (error) { operation = Promise.reject(error); }
    operation.then((result) => {
      const status: WorkflowRunStatus = result.state.status === "cancelled" ? "cancelled" : result.state.status === "completed" ? "completed" : "failed"; const finishedAt = this.now();
      try { storage.saveWorkflowRunMetadata({ ...running, status, updatedAt: finishedAt, finishedAt }); resolvePublic(result); } catch (error) { rejectPublic(error); }
    }, (error) => {
      const finishedAt = this.now(); const status: WorkflowRunStatus = controller.signal.aborted ? "cancelled" : "failed";
      try { storage.saveWorkflowRunMetadata({ ...running, status, updatedAt: finishedAt, finishedAt }); } catch {} rejectPublic(error);
    }).finally(() => releaseWorkflowRun(this.options.parent.sessionId, current.workflowId, current.runId));
    return publicPromise;
  }
  run(workflowId: string, confirmMutation = false): Promise<ExecutionResult> {
    const plan = this.loadPlan(workflowId); if (plan.metadata.status !== "pending") throw new Error("only a pending workflow can be started"); const models = resolveWorkflowModels(plan.workflow, this.options.modelRegistry); return this.start(plan, undefined, confirmMutation, models);
  }
  resume(workflowId: string, confirmMutation = false): Promise<ExecutionResult> {
    const plan = this.loadPlan(workflowId); const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata(); if (terminal(metadata.status) || metadata.status === "pending") throw new Error("workflow is not resumable");
    if (metadata.template === "build" && confirmMutation !== true) throw new Error("resuming a build workflow requires explicit confirmation");
    // Authenticate every exact node model before recovery can rewrite state or
    // metadata. The frozen registry result is passed unchanged into start().
    const models = resolveWorkflowModels(plan.workflow, this.options.modelRegistry);
    const recovered = storage.recoverWorkflowState(); if (!recovered.ok) throw recovered.error;
    const recoveredMetadata: WorkflowRunMetadata = { ...metadata, status: "recovered", startedAt: metadata.startedAt ?? this.now(), updatedAt: this.now(), finishedAt: undefined }; storage.saveWorkflowRunMetadata(recoveredMetadata);
    const resumed = Object.freeze({ metadata: recoveredMetadata, workflow: plan.workflow }); this.plans.set(workflowId, resumed); return this.start(resumed, recovered.value, confirmMutation, models);
  }
  async cancel(workflowId: string): Promise<void> {
    const running = getWorkflowRun(this.options.parent.sessionId, workflowId); if (!running) return;
    const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata(); if (metadata.status === "running" || metadata.status === "recovered") storage.saveWorkflowRunMetadata({ ...metadata, status: "cancelling", updatedAt: this.now() });
    running.controller.abort(); await running.promise;
  }
  status(workflowId: string): WorkflowRunMetadata { return this.storage(workflowId).loadWorkflowRunMetadata(); }
  statusSnapshot(workflowId: string): { readonly metadata: WorkflowRunMetadata; readonly nodes?: Readonly<Record<string, import("./types.ts").NodeStatus>> } {
    const storage = this.storage(workflowId); const metadata = storage.loadWorkflowRunMetadata();
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
    const evidence = storage.loadWorktreeMetadata(nodeId, attempt); const gates: GateResult[] = [];
    for (const gateNode of plan.workflow.nodes.filter((item) => item.sourceNodeId === nodeId && item.gate)) for (const gate of storage.loadGateResults(gateNode.id)) if (gate.attempt === attempt && gate.evidenceDigest === evidence.evidenceDigest) gates.push(gate);
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
    if (confirmed !== true) throw new Error("approval requires explicit confirmation"); const context = this.approvalContext(workflowId, nodeId, attempt) as ReturnType<WorkflowHost["approvalContext"]> & { handle: any };
    const record = context.manager.issueApproval(context.handle, context.evidence, context.gates, context.node);
    return { token: record.token, workflowId, nodeId, attempt, evidenceDigest: record.evidenceDigest, changedFiles: context.evidence.changedFiles.slice(0, 8).map((file) => file.slice(0, 96)), changedFileCount: context.evidence.changedFiles.length, gateDigests: record.gateResultDigests.slice(0, 8) };
  }
  apply(workflowId: string, nodeId: string, token: string, confirmed: boolean): WorkflowApplySummary {
    if (confirmed !== true) throw new Error("apply requires explicit confirmation"); const plan = this.loadPlan(workflowId); const metadata = this.storage(workflowId).loadWorkflowRunMetadata(); const manager = this.manager(plan.workflow, metadata); const record: ApplyApprovalRecord = manager.loadApproval(token); if (record.nodeId !== nodeId || record.workflowId !== workflowId) throw new Error("approval ownership mismatch");
    const context = this.approvalContext(workflowId, nodeId, record.attempt) as ReturnType<WorkflowHost["approvalContext"]> & { handle: any }; context.manager.apply(context.handle, record, context.node); return { workflowId, nodeId, attempt: record.attempt, applied: true };
  }
  shutdown(): Promise<void> { return shutdownWorkflowRuns(this.owner); }
}
export const createWorkflowHost = (options: WorkflowHostOptions): WorkflowHost => new WorkflowHost(options);
