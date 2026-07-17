import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { createHostPolicyArtifact, validateHostPolicyArtifact, type CapabilityCatalog } from "./capabilities.ts";
import { MAX_SERIALIZED_PAYLOAD_BYTES, validateAgentResultEnvelope, validateWorkflowState, validateWorktreeMetadata } from "./schema.ts";
import { evaluateGate, type GateCommandLaunch } from "./gates.ts";
import { assertCompiledWorkflowIntegrity, type CompiledWorkflow } from "./planner.ts";
import { resolveCombinedModelPolicy } from "./kernels.ts";
import { computeGateEvaluationId, computeGateResultDigest, toWorktreeEvidence, type WorktreeHandle } from "./worktree.ts";
import type { AgentResultEnvelope, GateResult, HostPolicyArtifact, NodeAttempt, NodeStatus, TaskNode, TaskResult, WorkflowState, WorktreeEvidence, WorktreeMetadata, WorkflowTelemetryRecord, WorkflowArtifactProvenance } from "./types.ts";
import type { WorkflowStorage } from "./storage.ts";
import { requireProviderTelemetry, type ProviderTelemetryAdapter, type TelemetryBudget } from "./telemetry.ts";
import { sanitizeUsageHint, type UsageCoordinator } from "./usage-limit.ts";
import { validateRecipeOutput, type WorkflowRecipeId } from "./recipes.ts";

export interface WorkflowNodeLaunchContext {
  readonly workflow: CompiledWorkflow; readonly node: TaskNode; readonly attempt: number; readonly cwd: string;
  readonly sourceNodeId?: string; readonly sourceEvidence?: WorktreeEvidence; readonly signal: AbortSignal;
  /** Canonical bounded outputs of successful dependencies, materialized by host. */
  readonly upstreamResults?: Readonly<Record<string, unknown>>;
  /** Host-resolved exact model; adapters must not resolve or fall back. */
  readonly resolvedModel: import("./types.ts").ModelSelection;
  /** Signed artifact and its separately transported secret are handed only to the trusted launcher adapter. */
  readonly policyArtifact: HostPolicyArtifact; readonly policySecret: Uint8Array;
}
export interface WorkflowNodeLaunch { readonly result: Promise<unknown> | unknown; readonly cancel: (reason?: string) => Promise<void> | void; readonly settled: Promise<unknown>; /** Provider request identity supplied by the trusted adapter, never synthesized by the executor. */ readonly providerRequestId?: string | Promise<string | undefined>; readonly usageLimit?: { readonly message?: string; readonly resetAt?: number; readonly retryAfterMs?: number }; }
export interface WorkflowNodeLauncher { launch(context: WorkflowNodeLaunchContext): WorkflowNodeLaunch; }
export class WorkflowLaunchError extends Error { readonly classification: "retryable" | "permanent" | "cancelled" | "usage-limit"; readonly usageSignal?: { readonly message?: string; readonly resetAt?: number; readonly retryAfterMs?: number }; constructor(message: string, classification: WorkflowLaunchError["classification"] = "permanent", usageSignal?: WorkflowLaunchError["usageSignal"]) { super(message); this.name = "WorkflowLaunchError"; this.classification = classification; this.usageSignal = usageSignal; } }
export class WorkflowSettlementError extends Error { constructor(message = "subagent launch did not settle after cancellation") { super(message); this.name = "WorkflowSettlementError"; } }
export interface ExecutorHostPolicy {
  readonly signingSecret?: string | Uint8Array; readonly approvedCapabilities?: readonly string[]; readonly nativeAllowlist?: readonly string[];
  readonly allowedArgv?: readonly (readonly string[])[]; readonly catalog?: CapabilityCatalog;
}
export interface ExecutorOptions {
  readonly launcher: WorkflowNodeLauncher; readonly storage?: Partial<WorkflowStorage>; readonly maxConcurrency?: number; readonly maxRuntimeMs?: number; readonly maxOutputBytes?: number; readonly settlementTimeoutMs?: number;
  readonly signal?: AbortSignal; readonly recoveredState?: WorkflowState; readonly now?: () => number; readonly cwd?: string; readonly runId?: string; readonly hostPolicy?: ExecutorHostPolicy;
  readonly runCommand?: (argv: readonly string[], cwd: string, signal: AbortSignal) => GateCommandLaunch;
  readonly commandRuntimeMs?: number; readonly commandOutputBytes?: number;
  readonly resolvedModels?: Readonly<Record<string, import("./types.ts").ModelSelection>>;
  /** Provider-derived usage telemetry is an optional host seam; required mode fails closed. */
  readonly telemetryAdapter?: ProviderTelemetryAdapter; readonly telemetryBudget?: TelemetryBudget; readonly telemetryRequired?: boolean; readonly usageCoordinator?: UsageCoordinator; readonly onUsageReset?: (callbackId: string) => void;
  readonly worktree?: {
    readonly root?: string; readonly registerWorkflow?: (workflow: CompiledWorkflow) => void; readonly recordGateResult?: (result: GateResult) => void;
    readonly prepare: (node: TaskNode, attempt?: number) => WorktreeHandle; readonly adoptRecovered?: (evidence: WorktreeEvidence, node: TaskNode) => WorktreeHandle;
    readonly capture: (handle: WorktreeHandle, node: TaskNode) => WorktreeMetadata;
  };
}
export interface ExecutionResult { readonly state: WorkflowState; }
const depsOf = (node: TaskNode): readonly string[] => [...new Set([...(node.dependsOn ?? []), ...(node.gate?.dependsOn ?? [])])];
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
function ensureCumulativeTelemetryBudget(records: readonly WorkflowTelemetryRecord[], budget: TelemetryBudget): void { const requestIds = new Set<string>(); for (const record of records) { if (requestIds.has(record.requestId)) throw new Error("duplicate provider request identity in telemetry ledger"); requestIds.add(record.requestId); } const input = records.reduce((sum, item) => sum + item.inputTokens, 0); const output = records.reduce((sum, item) => sum + item.outputTokens, 0); const runtime = records.reduce((sum, item) => sum + item.runtimeMs, 0); if (budget.maxCostUsd !== undefined && records.some((item) => item.costUsd === undefined)) throw new Error("provider cost telemetry is required when maxCostUsd is configured"); const cost = records.reduce((sum, item) => sum + (item.costUsd ?? 0), 0); if (records.length > budget.maxRequests || input > budget.maxInputTokens || output > budget.maxOutputTokens || runtime > budget.maxRuntimeMs || budget.maxCostUsd !== undefined && cost > budget.maxCostUsd) throw new Error("cumulative telemetry budget exceeded"); }
const MAX_UPSTREAM_EVIDENCE_ITEMS = 64;
const MAX_UPSTREAM_EVIDENCE_ITEM_BYTES = 65_536;
const MAX_UPSTREAM_EVIDENCE_BYTES = 256_000;
function materializeUpstreamResults(node: TaskNode, dependencyIds: readonly string[], results: Readonly<Record<string, TaskResult>>): Readonly<Record<string, unknown>> {
  if (dependencyIds.length > MAX_UPSTREAM_EVIDENCE_ITEMS) throw new WorkflowLaunchError(`upstream evidence exceeds ${MAX_UPSTREAM_EVIDENCE_ITEMS} dependencies`, "permanent");
  const materialized: Record<string, unknown> = {};
  for (const id of [...dependencyIds].sort()) {
    const dependency = results[id];
    if (!dependency || dependency.status !== "succeeded") throw new WorkflowLaunchError("upstream dependency result is unavailable", "permanent");
    // Never hand raw envelopes, diffs, or unbounded adapter data to a child.
    // The digest is enough to bind evidence while the bounded output remains
    // executable input for trusted recipe nodes.
    const item = { status: dependency.status, output: dependency.output, attempt: dependency.attempt, rawEnvelopeDigest: dependency.rawEnvelopeDigest };
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(item), "utf8"); } catch { throw new WorkflowLaunchError(`upstream evidence for ${id} is not serializable`, "permanent"); }
    if (bytes > MAX_UPSTREAM_EVIDENCE_ITEM_BYTES) throw new WorkflowLaunchError(`upstream evidence for ${id} exceeds ${MAX_UPSTREAM_EVIDENCE_ITEM_BYTES} bytes`, "permanent");
    materialized[id] = structuredClone(item);
  }
  let total: number;
  try { total = Buffer.byteLength(JSON.stringify(materialized), "utf8"); } catch { throw new WorkflowLaunchError("upstream evidence is not serializable", "permanent"); }
  if (total > MAX_UPSTREAM_EVIDENCE_BYTES) throw new WorkflowLaunchError(`upstream evidence exceeds ${MAX_UPSTREAM_EVIDENCE_BYTES} bytes`, "permanent");
  return Object.freeze(materialized);
}
function rawText(value: unknown): string { if (typeof value === "string") return value; const text = JSON.stringify(value); if (text === undefined) throw new Error("malformed agent result envelope"); return text; }
function asEnvelope(value: unknown, maxBytes: number): { envelope?: AgentResultEnvelope; rawDigest?: string; error?: string; classification?: "malformed" | "permanent" } {
  let text: string; try { text = rawText(value); } catch { return { error: "malformed agent result envelope", classification: "malformed" }; }
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { error: "agent output exceeds maxOutputBytes", classification: "permanent" };
  let parsed: unknown = value; if (typeof value === "string") try { parsed = JSON.parse(value); } catch { return { error: "malformed agent result envelope", classification: "malformed" }; }
  const checked = validateAgentResultEnvelope(parsed); return checked.ok ? { envelope: checked.value, rawDigest: hash(JSON.stringify(checked.value)) } : { error: "malformed agent result envelope", classification: "malformed" };
}
function positiveBounded(name: string, value: number, max: number, minimum = 1): number { if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > max) throw new Error(`${name} must be a finite integer between ${minimum} and ${max}`); return value; }
function cloneRecord<T>(value: Readonly<Record<string, T>> | undefined): Record<string, T> { return Object.fromEntries(Object.entries(value ?? {})); }
interface RecoveryData {
  nodes: Record<string, NodeStatus>; results: Record<string, TaskResult>; attempts: Record<string, NodeAttempt[]>; gates: Record<string, GateResult[]>; worktrees: Record<string, WorktreeEvidence>; recoveredResults: Set<string>; recoveredGateResults: Record<string, TaskResult>; telemetry: WorkflowTelemetryRecord[]; provenance: WorkflowArtifactProvenance[];
}
function plainWorkflowSpec(workflow: CompiledWorkflow) {
  return { version: workflow.version, id: workflow.id, sessionId: workflow.sessionId, objective: workflow.objective, ...(workflow.expertise ? { expertise: workflow.expertise } : {}), ...(workflow.capabilities ? { capabilities: workflow.capabilities } : {}), nodes: workflow.nodes, ...(workflow.bounds ? { bounds: workflow.bounds } : {}), ...(workflow.policy ? { policy: workflow.policy } : {}) };
}
function normalizeRecovery(workflow: CompiledWorkflow, recovered: WorkflowState | undefined, storage?: Partial<WorkflowStorage>): RecoveryData {
  const fresh = Object.fromEntries(workflow.nodes.map((node) => [node.id, "pending" as NodeStatus]));
  if (!recovered) return { nodes: fresh, results: {}, attempts: {}, gates: {}, worktrees: {}, recoveredResults: new Set(), recoveredGateResults: {}, telemetry: [], provenance: [] };
  const checked = validateWorkflowState(recovered, { workflowId: workflow.id, sessionId: workflow.sessionId }); if (!checked.ok) throw new Error("recovered workflow state is invalid"); const safe = structuredClone(checked.value);
  const expected = new Set(workflow.nodes.map((node) => node.id)); for (const result of Object.values(safe.results ?? {})) if (result.workflowIntegrity && (result.workflowIntegrity !== workflow.integrity || result.topologyDigest !== workflow.topology.topologyDigest)) throw new Error("recovered result topology provenance mismatch"); for (const gateList of Object.values(safe.gates ?? {})) for (const gate of gateList) if (gate.workflowIntegrity && (gate.workflowIntegrity !== workflow.integrity || gate.topologyDigest !== workflow.topology.topologyDigest)) throw new Error("recovered gate topology provenance mismatch"); for (const evidence of Object.values(safe.worktrees ?? {})) if (evidence.workflowIntegrity && (evidence.workflowIntegrity !== workflow.integrity || evidence.topologyDigest !== workflow.topology.topologyDigest)) throw new Error("recovered worktree topology provenance mismatch"); if (Object.keys(safe.nodes).length !== expected.size || Object.keys(safe.nodes).some((id) => !expected.has(id))) throw new Error("recovered workflow node ownership mismatch");
  // Caller-provided state is only a recovery hint. Every durable artifact must be reconciled through a trusted loader.
  if (!storage?.loadWorkflowSpec || Object.keys(safe.results ?? {}).some((id) => !storage?.loadTaskResult) || Object.keys(safe.attempts ?? {}).some((id) => !storage?.loadNodeAttempts) || Object.keys(safe.gates ?? {}).some((id) => !storage?.loadGateResults) || Object.keys(safe.worktrees ?? {}).some(() => !storage?.loadWorktreeMetadata) || safe.provenance?.length && !storage?.loadWorkflowProvenance || safe.telemetry?.length && !storage?.loadTelemetryRecords) throw new Error("recovered terminal state lacks trusted storage provenance");
  const trustedSpec = storage.loadWorkflowSpec(); if (!isDeepStrictEqual(trustedSpec, plainWorkflowSpec(workflow))) throw new Error("recovered workflow specification provenance mismatch"); if (safe.provenance?.length) { const trustedProvenance = storage.loadWorkflowProvenance!(); if (!isDeepStrictEqual(trustedProvenance, safe.provenance)) throw new Error("recovered artifact provenance mismatch"); } if (safe.telemetry?.length) { const trustedTelemetry = storage.loadTelemetryRecords!(); if (!isDeepStrictEqual(trustedTelemetry, safe.telemetry)) throw new Error("recovered telemetry ledger provenance mismatch"); }
  const results: Record<string, TaskResult> = {}; const attempts: Record<string, NodeAttempt[]> = {}; const gates: Record<string, GateResult[]> = {}; const worktrees: Record<string, WorktreeEvidence> = {};
  for (const id of Object.keys(safe.results ?? {})) { const loaded = storage!.loadTaskResult!(id); if (!isDeepStrictEqual(loaded, safe.results![id])) throw new Error("recovered result provenance mismatch"); results[id] = structuredClone(loaded); }
  for (const [id, list] of Object.entries(safe.attempts ?? {})) { const loaded = [...storage!.loadNodeAttempts!(id)]; if (!isDeepStrictEqual(loaded, list)) throw new Error("recovered attempt provenance mismatch"); const latest = loaded.at(-1); const usagePauseMarker = latest?.status === "cancelled" && latest.classification === "usage-limit"; if (latest && ["succeeded", "failed", "blocked", "cancelled"].includes(latest.status) && !results[id] && !usagePauseMarker) throw new Error("recovered terminal attempt lacks trusted result"); attempts[id] = structuredClone(loaded); }
  for (const [id, list] of Object.entries(safe.gates ?? {})) { const loaded = [...storage!.loadGateResults!(id)]; if (!isDeepStrictEqual(loaded, list)) throw new Error("recovered gate provenance mismatch"); gates[id] = structuredClone(loaded); }
  for (const [key, evidence] of Object.entries(safe.worktrees ?? {})) { const split = key.lastIndexOf(":"); const loaded = storage!.loadWorktreeMetadata!(key.slice(0, split), Number(key.slice(split + 1))); const trusted = toWorktreeEvidence(loaded); if (!isDeepStrictEqual(trusted, evidence)) throw new Error("recovered worktree provenance mismatch"); worktrees[key] = structuredClone(trusted); }
  // Gate records are retained only when they match the compiled gate definition; their outputs are always re-evaluated.
  for (const [id, list] of Object.entries(gates)) { const node = workflow.dag.byId.get(id); if (!node?.gate || list.some((entry) => { const { gateDigest: _digest, ...body } = entry; return entry.kind !== node.gate!.kind || entry.sourceNodeId !== node.sourceNodeId || computeGateResultDigest(body) !== entry.gateDigest || !(node.gate!.dependsOn ?? []).includes(entry.sourceNodeId ?? ""); })) throw new Error("recovered gate does not match compiled definition"); }
  const recoveredGateResults: Record<string, TaskResult> = {};
  let telemetry = [...(safe.telemetry ?? [])]; let provenance = [...(safe.provenance ?? [])];
  // Reconcile sidecars before trusting the state snapshot. A crash between a
  // durable ledger append and state publication must not lose budget usage or
  // provenance bindings.
  if (storage.loadTelemetryRecords) { try { const sidecar = [...storage.loadTelemetryRecords()]; if (telemetry.length && !isDeepStrictEqual(sidecar, telemetry)) throw new Error("recovered telemetry ledger provenance mismatch"); if (!telemetry.length) telemetry = sidecar; } catch (error) { if (!((error as { code?: unknown })?.code === "missing" || error instanceof Error && /missing/i.test(error.message))) throw error; } }
  if (storage.loadWorkflowProvenance) { try { const sidecar = [...storage.loadWorkflowProvenance()]; if (provenance.length && !isDeepStrictEqual(sidecar, provenance)) throw new Error("recovered artifact provenance mismatch"); if (!provenance.length) provenance = sidecar; } catch (error) { if (!((error as { code?: unknown })?.code === "missing" || error instanceof Error && /missing/i.test(error.message))) throw error; } }
  const requestIds = new Set<string>(); for (const record of telemetry) { if (requestIds.has(record.requestId)) throw new Error("duplicate provider request identity in telemetry ledger"); requestIds.add(record.requestId); }
  for (const node of workflow.nodes) if (node.gate) { if (results[node.id]) { if (!gates[node.id]?.length) throw new Error("recovered gate result lacks its trusted evaluation record"); recoveredGateResults[node.id] = results[node.id]; delete results[node.id]; } fresh[node.id] = "pending"; }
  for (const id of expected) if (!workflow.dag.byId.get(id)?.gate) fresh[id] = results[id]?.status ?? "pending";
  return { nodes: fresh, results, attempts, gates, worktrees, recoveredResults: new Set(Object.keys(results)), recoveredGateResults, telemetry, provenance };
}
function boundedSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolveSettled, reject) => { const timer = setTimeout(() => reject(new WorkflowSettlementError()), timeoutMs); Promise.resolve(promise).then(() => { clearTimeout(timer); resolveSettled(); }, (error) => { clearTimeout(timer); reject(error); }); });
}
async function awaitLaunch(handle: WorkflowNodeLaunch, signal: AbortSignal, settlementTimeoutMs: number): Promise<unknown> {
  if (!handle || typeof handle !== "object" || typeof handle.cancel !== "function" || !handle.settled || typeof handle.settled.then !== "function") throw new WorkflowLaunchError("launcher did not provide cancel/settled semantics");
  let cancelPromise: Promise<void> | undefined; const cancel = () => { if (!cancelPromise) { try { cancelPromise = Promise.resolve(handle.cancel("workflow cancelled")); } catch (error) { cancelPromise = Promise.reject(error); } } return cancelPromise; };
  const settle = () => boundedSettlement(handle.settled, settlementTimeoutMs);
  const stopAndSettle = async () => { void cancel().catch(() => {}); await settle(); };
  let rejectAbort!: (error: Error) => void; const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { void cancel().catch(() => {}); rejectAbort(new WorkflowLaunchError("workflow cancelled", "cancelled")); };
  signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
  try {
    let value: unknown;
    try { value = await Promise.race([Promise.resolve(handle.result), aborted]); }
    catch (error) { if (signal.aborted) { await stopAndSettle(); throw new WorkflowLaunchError("workflow cancelled", "cancelled"); } await settle(); throw error; }
    try { await Promise.race([settle(), aborted]); }
    catch (error) { if (signal.aborted) { await stopAndSettle(); throw new WorkflowLaunchError("workflow cancelled", "cancelled"); } void cancel().catch(() => {}); await settle(); throw error; }
    if (signal.aborted) { await stopAndSettle(); throw new WorkflowLaunchError("workflow cancelled", "cancelled"); } return value;
  } finally { signal.removeEventListener("abort", onAbort); }
}

export async function executeWorkflow(workflow: CompiledWorkflow, options: ExecutorOptions): Promise<ExecutionResult> {
  if (!options?.launcher) throw new Error("workflow launcher is required"); assertCompiledWorkflowIntegrity(workflow);
  const concurrencyCeiling = workflow.bounds?.maxConcurrency ?? 64; const capacity = positiveBounded("maxConcurrency", options.maxConcurrency ?? concurrencyCeiling, Math.min(64, concurrencyCeiling));
  const runtimeCeiling = workflow.bounds?.maxRuntimeMs ?? 86_400_000; const maxRuntime = positiveBounded("maxRuntimeMs", options.maxRuntimeMs ?? runtimeCeiling, runtimeCeiling);
  const outputCeiling = workflow.policy?.maxOutputBytes ?? MAX_SERIALIZED_PAYLOAD_BYTES; const maxOutputBytes = positiveBounded("maxOutputBytes", options.maxOutputBytes ?? outputCeiling, outputCeiling);
  const settlementTimeoutMs = positiveBounded("settlementTimeoutMs", options.settlementTimeoutMs ?? 5_000, 30_000);
  const resolvedModels = options.resolvedModels ?? Object.freeze(Object.fromEntries(workflow.nodes.map((node) => [node.id, resolveCombinedModelPolicy({ node: node.model, workflow: workflow.policy })])));
  if (options.telemetryBudget?.maxCostUsd !== undefined && options.telemetryRequired !== true) throw new Error("provider cost budget requires mandatory telemetry");
  if (options.telemetryRequired && (!options.telemetryAdapter || !options.telemetryBudget)) throw new Error("provider telemetry is required but unavailable");
  if (options.cwd && (!isAbsolute(options.cwd) || resolve(options.cwd) !== options.cwd || options.cwd.includes("\0"))) throw new Error("executor cwd must be an absolute normalized path");
  options.worktree?.registerWorkflow?.(workflow);
  const now = options.now ?? Date.now; const started = now(); const recovered = normalizeRecovery(workflow, options.recoveredState, options.storage); if (options.recoveredState?.runId && options.runId && options.recoveredState.runId !== options.runId) throw new Error("recovered workflow run ownership mismatch"); const { nodes, results, attempts, gates, worktrees, recoveredResults, recoveredGateResults, telemetry, provenance } = recovered; if (options.telemetryRequired && telemetry.length) { if (!options.telemetryAdapter || !options.telemetryBudget) throw new Error("provider telemetry is required but unavailable"); const verifiedLedger = await requireProviderTelemetry(options.telemetryAdapter, telemetry.map((entry) => entry.requestId), options.telemetryBudget, options.signal); if (verifiedLedger.items.length !== telemetry.length || verifiedLedger.items.some((item, index) => item.requestId !== telemetry[index].requestId || item.model !== telemetry[index].model || item.inputTokens !== telemetry[index].inputTokens || item.outputTokens !== telemetry[index].outputTokens || item.runtimeMs !== telemetry[index].runtimeMs || item.costUsd !== telemetry[index].costUsd || item.capturedAt !== telemetry[index].capturedAt || item.signature !== telemetry[index].providerSignature)) throw new Error("persisted telemetry ledger provenance mismatch"); }
  const policySecret = typeof options.hostPolicy?.signingSecret === "string" ? Buffer.from(options.hostPolicy.signingSecret) : options.hostPolicy?.signingSecret ? Buffer.from(options.hostPolicy.signingSecret) : randomBytes(32);
  if (policySecret.byteLength < 32) { policySecret.fill(0); throw new Error("host policy signing secret must contain at least 32 bytes"); }
  const policyArgv = options.hostPolicy?.allowedArgv ?? [];
  const savedResults = new Set(Object.keys(results)); const controller = new AbortController(); let timedOut = false;
  const externalAbort = () => controller.abort(); if (options.signal) { if (options.signal.aborted) controller.abort(); else options.signal.addEventListener("abort", externalAbort, { once: true }); }
  const runtimeTimer = setTimeout(() => { timedOut = true; controller.abort(); }, maxRuntime);
  let state: WorkflowState = { version: 1, workflowId: workflow.id, sessionId: workflow.sessionId, ...(options.runId ? { runId: options.runId } : {}), status: "running", nodes: { ...nodes }, results: { ...results }, attempts: Object.fromEntries(Object.entries(attempts).map(([k, v]) => [k, [...v]])), gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, [...v]])), worktrees: { ...worktrees }, telemetry: [...telemetry], provenance: [...provenance], updatedAt: started };
  const persist = () => options.storage?.saveWorkflowState?.(state);
  const save = () => { state = { ...state, nodes: { ...nodes }, results: { ...results }, attempts: Object.fromEntries(Object.entries(attempts).map(([k, v]) => [k, [...v]])), gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, [...v]])), worktrees: { ...worktrees }, telemetry: [...telemetry], provenance: [...provenance], updatedAt: now() }; persist(); };
  const saveResultOnce = (result: TaskResult) => { if (savedResults.has(result.nodeId)) throw new Error(`duplicate task result persistence: ${result.nodeId}`); savedResults.add(result.nodeId); options.storage?.saveTaskResult?.(result); };
  const addProvenance = (entry: WorkflowArtifactProvenance): void => { provenance.push(entry); options.storage?.saveWorkflowProvenance?.(entry); };
  const markAttempt = (node: TaskNode, attempt: number, patch: Partial<NodeAttempt>) => {
    const list = attempts[node.id] ?? []; if (attempt > list.length + 1) throw new Error("attempt sequence is not consecutive"); const previous = list.find((item) => item.attempt === attempt);
    const item: NodeAttempt = { version: 1, workflowId: workflow.id, nodeId: node.id, attempt, status: patch.status ?? previous?.status ?? "running", ...(previous ?? {}), ...patch };
    const normalized = item.status === "running" ? (() => { const { finishedAt: _finishedAt, error: _error, classification: _classification, ...rest } = item; return rest as NodeAttempt; })() : item;
    attempts[node.id] = previous ? list.map((entry) => entry.attempt === attempt ? normalized : entry) : [...list, normalized]; options.storage?.saveNodeAttempt?.(normalized);
  };
  const complete = (node: TaskNode, attempt: number | undefined, status: TaskResult["status"], error?: string, envelope?: AgentResultEnvelope, rawDigest?: string, classification?: NodeAttempt["classification"]): TaskResult => {
    const finishedAt = now(); const result: TaskResult = { version: 1, workflowId: workflow.id, nodeId: node.id, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, status, ...(envelope?.output !== undefined ? { output: envelope.output } : {}), ...(error ? { error } : {}), ...(attempt ? { attempt, startedAt: attempts[node.id]?.find((x) => x.attempt === attempt)?.startedAt } : {}), finishedAt, ...(envelope && rawDigest ? { rawEnvelope: envelope, rawEnvelopeDigest: rawDigest } : {}) };
    results[node.id] = result; nodes[node.id] = status; if (attempt) markAttempt(node, attempt, { status, finishedAt, ...(error ? { error } : {}), ...(classification ? { classification } : {}) });
    // Publish the immutable artifact before its provenance ledger entry. A
    // crash can then be repaired from a durable artifact, never from a dangling
    // provenance claim.
    saveResultOnce(result);
    if (options.runId) addProvenance({ version: 1, workflowId: workflow.id, runId: options.runId, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, kind: "result", nodeId: node.id, ...(attempt ? { attempt } : {}), artifactId: `${node.id}.${attempt ?? 0}.result`, artifactDigest: hash(canonical(result)), capturedAt: finishedAt }); save(); return result;
  };
  try { persist(); } catch (error) { policySecret.fill(0); throw error; }
  const running = new Map<string, Promise<{ id: string; result: TaskResult }>>(); const handles = new Map<string, WorktreeHandle>();
  const adoptSource = (sourceId: string, sourceAttempt: number, evidence: WorktreeEvidence): WorktreeHandle => {
    const key = `${sourceId}:${sourceAttempt}`; const existing = handles.get(key); if (existing) return existing;
    const sourceNode = workflow.dag.byId.get(sourceId); if (!sourceNode || !options.worktree?.adoptRecovered) throw new Error("recovered worktree requires trusted manager adoption");
    const adopted = options.worktree.adoptRecovered(evidence, sourceNode); if (adopted.workflowId !== workflow.id || adopted.nodeId !== sourceId || adopted.attempt !== sourceAttempt || adopted.mode !== evidence.mode || adopted.cwd !== evidence.cwd || adopted.path !== evidence.path || adopted.preserved !== evidence.preserved || adopted.base !== evidence.base) throw new Error("adopted worktree identity mismatch");
    handles.set(key, adopted); return adopted;
  };
  const runGateNode = async (node: TaskNode): Promise<{ id: string; result: TaskResult }> => {
    nodes[node.id] = "running"; save();
    const sourceId = node.sourceNodeId ?? node.gate?.dependsOn?.[0]; const sourceResult = sourceId ? results[sourceId] : undefined; const sourceAttempt = sourceResult?.attempt;
    let evidence = sourceId && sourceAttempt ? worktrees[`${sourceId}:${sourceAttempt}`] : undefined; let sourceHandle = sourceId && sourceAttempt ? handles.get(`${sourceId}:${sourceAttempt}`) : undefined; let recoveryError: string | undefined;
    if (sourceId && sourceAttempt && recoveredResults.has(sourceId) && evidence && !sourceHandle) try {
      sourceHandle = adoptSource(sourceId, sourceAttempt, evidence); const fresh = options.worktree!.capture(sourceHandle, workflow.dag.byId.get(sourceId)!); const checked = validateWorktreeMetadata(fresh);
      if (!checked.ok || fresh.workflowId !== workflow.id || fresh.nodeId !== sourceId || fresh.attempt !== sourceAttempt || fresh.mode !== sourceHandle.mode || fresh.base !== sourceHandle.base || fresh.cwd !== sourceHandle.cwd || fresh.path !== sourceHandle.path || fresh.preserved !== sourceHandle.preserved) throw new Error("recovered worktree recapture failed integrity validation");
      evidence = toWorktreeEvidence(checked.value); worktrees[`${sourceId}:${sourceAttempt}`] = evidence;
    } catch (error) { recoveryError = error instanceof Error ? error.message : "recovered worktree adoption failed"; }
    if (sourceId && recoveredResults.has(sourceId) && node.gate?.kind === "command" && !sourceHandle) recoveryError ??= "recovered command gate lacks an adopted live worktree";
    if (sourceId && recoveredResults.has(sourceId) && node.gate?.kind === "diff-scope" && !sourceHandle) recoveryError ??= "recovered diff gate lacks an adopted live worktree";
    const evaluation = recoveryError ? { kind: node.gate!.kind, passed: false, checkedAt: now(), error: recoveryError } : await evaluateGate(node.gate!, {
      dependencyResults: results, rawDependencyEnvelopes: Object.fromEntries(Object.entries(results).map(([id, result]) => [id, result.rawEnvelope])), rawDependencyDigests: Object.fromEntries(Object.entries(results).map(([id, result]) => [id, result.rawEnvelopeDigest])),
      changedFiles: evidence?.changedFiles, allowGlobs: node.allowGlobs, denyGlobs: node.denyGlobs, hostAllowedArgv: policyArgv,
      cwd: sourceHandle?.cwd ?? (!sourceId || !recoveredResults.has(sourceId) ? options.cwd : undefined), runCommand: options.runCommand,
      signal: controller.signal, commandRuntimeMs: options.commandRuntimeMs, commandOutputBytes: options.commandOutputBytes, now: now(),
    });
    const evaluationId = computeGateEvaluationId({ workflowId: workflow.id, nodeId: node.id, kind: evaluation.kind, ...(sourceId ? { sourceNodeId: sourceId } : {}), ...(sourceAttempt ? { attempt: sourceAttempt } : {}), ...(evidence ? { evidenceDigest: evidence.evidenceDigest } : {}), ...(sourceResult?.rawEnvelopeDigest ? { rawEnvelopeDigest: sourceResult.rawEnvelopeDigest } : {}), ...(node.gate?.argv ? { argv: node.gate.argv } : {}) });
    const list = gates[node.id] ?? []; const index = list.findIndex((item) => item.evaluationId === evaluationId); const prior = index >= 0 ? list[index] : undefined;
    const body: Omit<GateResult, "gateDigest"> = { version: 1, workflowId: workflow.id, nodeId: node.id, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, kind: evaluation.kind, passed: evaluation.passed && !controller.signal.aborted, checkedAt: prior?.checkedAt ?? evaluation.checkedAt, ...(sourceId ? { sourceNodeId: sourceId } : {}), ...(sourceAttempt ? { attempt: sourceAttempt } : {}), ...(evidence ? { evidenceDigest: evidence.evidenceDigest } : {}), ...(sourceResult?.rawEnvelopeDigest ? { rawEnvelopeDigest: sourceResult.rawEnvelopeDigest } : {}), evaluationId, ...(evaluation.error || controller.signal.aborted ? { error: controller.signal.aborted ? (timedOut ? "workflow runtime exceeded" : "workflow cancelled") : evaluation.error } : {}) };
    const gateResult: GateResult = { ...body, gateDigest: computeGateResultDigest(body) }; let retained = gateResult;
    if (prior) { if (isDeepStrictEqual(prior, gateResult)) retained = prior; else throw new Error("gate evaluation identity is immutable"); }
    const next = prior ? list : [...list, retained]; if (next.length > 64) throw new Error("gate result limit exceeded"); gates[node.id] = next;
    if (!prior) { options.storage?.saveGateResult?.(retained); if (options.runId) addProvenance({ version: 1, workflowId: workflow.id, runId: options.runId, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, kind: "gate", nodeId: node.id, ...(sourceAttempt ? { attempt: sourceAttempt } : {}), artifactId: `${node.id}.${sourceAttempt ?? 0}.gate.${retained.evaluationId.slice(0, 12)}`, artifactDigest: retained.gateDigest, capturedAt: retained.checkedAt }); } options.worktree?.recordGateResult?.(retained); save();
    const cancelled = controller.signal.aborted; const envelope: AgentResultEnvelope = retained.passed ? { version: 1, status: "succeeded", output: { gateDigest: retained.gateDigest } } : { version: 1, status: "blocked", error: retained.error ?? "gate failed" };
    const recoveredTask = recoveredGateResults[node.id];
    if (prior && recoveredTask && !cancelled) {
      const expectedStatus = retained.passed ? "succeeded" : "blocked"; const output = recoveredTask.output as { gateDigest?: unknown } | undefined;
      if (recoveredTask.status !== expectedStatus || (retained.passed && output?.gateDigest !== retained.gateDigest)) throw new Error("recovered gate task result does not match re-evaluated gate");
      results[node.id] = recoveredTask; nodes[node.id] = recoveredTask.status; savedResults.add(node.id); save(); return { id: node.id, result: recoveredTask };
    }
    const text = JSON.stringify(envelope); return { id: node.id, result: cancelled ? complete(node, undefined, "cancelled", timedOut ? "workflow runtime exceeded" : "workflow cancelled", undefined, undefined, "cancelled") : complete(node, undefined, retained.passed ? "succeeded" : "blocked", retained.passed ? undefined : envelope.error!, envelope, hash(text), retained.passed ? undefined : "permanent") };
  };
  const run = async (node: TaskNode): Promise<{ id: string; result: TaskResult }> => {
    if (node.gate) return runGateNode(node);
    if (node.mode === "mutating" && !options.worktree) return { id: node.id, result: complete(node, undefined, "failed", "mutating node requires a trusted worktree manager", undefined, undefined, "permanent") };
    const maxAttempts = Math.min(node.retries ?? 0, workflow.bounds?.maxRetries ?? 10) + 1; const prior = attempts[node.id] ?? []; const latest = prior.at(-1); let attempt = latest?.attempt ?? 0; let usedAttempts = prior.length;
    const pausedUsageAttempt = latest?.classification === "usage-limit";
    if (latest && ["succeeded", "failed", "blocked", "cancelled"].includes(latest.status) && !results[node.id] && !pausedUsageAttempt) return { id: node.id, result: complete(node, undefined, "failed", "recovered terminal attempt lacks result", undefined, undefined, "permanent") };
    if (latest && (latest.status === "running" || latest.status === "retrying")) { markAttempt(node, latest.attempt, { status: "cancelled", finishedAt: now(), error: "interrupted attempt recovered", classification: "cancelled" }); save(); }
    // A provider pause is not a retry and must resume the same attempt after
    // restart. The sidecar remains an explicit usage-limit cancellation so
    // stale recovery cannot mistake it for an unaccounted terminal result.
    if (pausedUsageAttempt) { usedAttempts = Math.max(0, usedAttempts - 1); attempt = Math.max(0, attempt - 1); }
    if (usedAttempts >= maxAttempts) return { id: node.id, result: complete(node, undefined, "failed", "retry budget exhausted during recovery", undefined, undefined, "permanent") };
    while (usedAttempts < maxAttempts) {
      attempt++; usedAttempts++; if (controller.signal.aborted) return { id: node.id, result: complete(node, undefined, "cancelled", timedOut ? "workflow runtime exceeded" : "workflow cancelled", undefined, undefined, "cancelled") };
      let handle: WorktreeHandle | undefined;
      try { const prepared = options.worktree?.prepare(node, attempt); if (prepared) { if (prepared.workflowId !== workflow.id || prepared.nodeId !== node.id || prepared.attempt !== attempt || prepared.mode !== node.mode || (node.mode === "read-only" ? prepared.path !== undefined || prepared.preserved : prepared.path !== prepared.cwd || !prepared.preserved) || !isAbsolute(prepared.cwd) || resolve(prepared.cwd) !== prepared.cwd || prepared.cwd.includes("\0") || !/^[A-Fa-f0-9]{40,64}$/.test(prepared.base)) throw new Error("worktree handle ownership mismatch"); handle = prepared; handles.set(`${node.id}:${attempt}`, handle); } }
      catch (error) { return { id: node.id, result: complete(node, undefined, "failed", error instanceof Error ? error.message : "worktree preparation failed", undefined, undefined, "permanent") }; }
      nodes[node.id] = "running"; save();
      let attemptRecorded = false;
      const recordStarted = () => { if (!attemptRecorded) { markAttempt(node, attempt, { status: "running", startedAt: now() }); attemptRecorded = true; save(); } };
      let value: unknown; let launchError: WorkflowLaunchError | undefined; let captureError: Error | undefined; let launchRequestId: string | undefined;
      try {
        const cwd = handle?.cwd ?? options.cwd ?? process.cwd();
        const artifact = createHostPolicyArtifact({ workflow, node, attempt, cwd, ...(node.mode === "mutating" ? { worktreeRoot: options.worktree?.root ?? (handle?.path ? resolve(handle.path, "..") : undefined) } : {}), hostApprovedCapabilities: options.hostPolicy?.approvedCapabilities ?? [], nativeAllowlist: options.hostPolicy?.nativeAllowlist ?? [], allowedArgv: policyArgv, signingSecret: policySecret, catalog: options.hostPolicy?.catalog });
        if (!validateHostPolicyArtifact(artifact, policySecret, { workflowId: workflow.id, nodeId: node.id, attempt, cwd, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, ...(node.mode === "mutating" ? { worktreeRoot: options.worktree?.root ?? (handle?.path ? resolve(handle.path, "..") : undefined) } : {}) })) throw new WorkflowLaunchError("host policy artifact verification failed", "permanent");
        const upstreamResults = materializeUpstreamResults(node, depsOf(node), results);
        const launch = options.launcher.launch({ workflow, node, attempt, cwd, upstreamResults, resolvedModel: resolvedModels[node.id] ?? (() => { throw new WorkflowLaunchError("resolved model selection is required", "permanent"); })(), policyArtifact: artifact, policySecret: Buffer.from(policySecret), signal: controller.signal });
        if (launch.usageLimit) throw new WorkflowLaunchError(launch.usageLimit.message ?? "provider usage limit reached", "usage-limit", launch.usageLimit);
        recordStarted();
        value = await awaitLaunch(launch, controller.signal, settlementTimeoutMs);
        launchRequestId = typeof launch.providerRequestId === "string" ? launch.providerRequestId : launch.providerRequestId ? await launch.providerRequestId : undefined;
        // Provider setup may publish its request identity asynchronously; only
        // inspect it after the launch has settled.
        if (options.telemetryRequired && (!launchRequestId || !/^[A-Za-z0-9._:-]{1,256}$/.test(launchRequestId))) throw new WorkflowLaunchError("provider request identity unavailable", "permanent");
      } catch (error) { if (error instanceof WorkflowSettlementError) throw error; launchError = error instanceof WorkflowLaunchError ? error : new WorkflowLaunchError(error instanceof Error ? error.message : "node launch failed"); }
      finally {
        if (handle && options.worktree) try { const captured = options.worktree.capture(handle, node); const checked = validateWorktreeMetadata(captured); if (!checked.ok || captured.workflowId !== workflow.id || captured.nodeId !== node.id || captured.attempt !== attempt || captured.mode !== handle.mode || captured.base !== handle.base || captured.cwd !== handle.cwd || captured.path !== handle.path || captured.preserved !== handle.preserved) throw new Error("captured evidence ownership or integrity mismatch"); const metadata: WorktreeMetadata = Object.freeze({ ...checked.value, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, changedFiles: Object.freeze([...checked.value.changedFiles]) }); const evidence = toWorktreeEvidence(metadata); worktrees[`${node.id}:${attempt}`] = evidence; options.storage?.saveWorktreeMetadata?.(metadata); if (options.runId) addProvenance({ version: 1, workflowId: workflow.id, runId: options.runId, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, kind: "worktree", nodeId: node.id, attempt, artifactId: `${node.id}.${attempt}.worktree`, artifactDigest: evidence.evidenceDigest, capturedAt: evidence.capturedAt }); save(); } catch (error) { captureError = error instanceof Error ? error : new Error("evidence capture failed"); }
      }
      if (captureError && !launchError) launchError = new WorkflowLaunchError(`evidence capture failed: ${captureError.message}`, "permanent");
      if (launchError) {
        if (launchError.classification === "usage-limit") {
          if (attemptRecorded) { markAttempt(node, attempt, { status: "cancelled", finishedAt: now(), error: "provider usage limit; attempt paused", classification: "usage-limit" }); }
          nodes[node.id] = "pending"; const callbackId = `usage-${workflow.id}-${node.id}-${now()}`; const pause = sanitizeUsageHint(launchError.usageSignal ?? { message: launchError.message }, now, callbackId); const callbackAt = pause.resetAt ?? pause.pausedAt + (pause.retryAfterMs ?? 60_000);
          state = { ...state, status: "paused", pause, nodes: { ...nodes }, attempts: Object.fromEntries(Object.entries(attempts).map(([k, v]) => [k, [...v]])), telemetry: [...telemetry], provenance: [...provenance], updatedAt: now() }; persist();
          // Publish the durable pause before registering the timer. A
          // synchronous test/runtime coordinator therefore cannot observe a
          // callback ID that has not yet been persisted in state.
          options.usageCoordinator?.schedule(callbackId, callbackAt, () => { if (state.pause?.callbackId === callbackId) options.onUsageReset?.(callbackId); });
          return { id: node.id, result: { version: 1, workflowId: workflow.id, nodeId: node.id, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, status: "blocked", error: "workflow paused by provider usage limit", attempt, finishedAt: now() } }; }
        if (!attemptRecorded) recordStarted();
        const cancelled = launchError.classification === "cancelled" || controller.signal.aborted; const retry = !cancelled && launchError.classification === "retryable" && attempt < maxAttempts;
        if (retry) { nodes[node.id] = "retrying"; markAttempt(node, attempt, { status: "retrying", finishedAt: now(), error: launchError.message, classification: "retryable" }); save(); continue; }
        return { id: node.id, result: complete(node, attempt, cancelled ? "cancelled" : "failed", timedOut ? "workflow runtime exceeded" : launchError.message, undefined, undefined, cancelled ? "cancelled" : launchError.classification) };
      }
      if (options.telemetryRequired) { try { const telemetryResult = await requireProviderTelemetry(options.telemetryAdapter, [launchRequestId!], options.telemetryBudget!, controller.signal); const item = telemetryResult.items[0]; if (item.requestId !== launchRequestId || item.model !== (resolvedModels[node.id]?.model ?? "") || !options.runId) throw new Error("provider telemetry binding mismatch"); const recordBody = { version: 1 as const, workflowId: workflow.id, runId: options.runId, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, nodeId: node.id, attempt, model: item.model, requestId: item.requestId, inputTokens: item.inputTokens, outputTokens: item.outputTokens, ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}), runtimeMs: item.runtimeMs, capturedAt: item.capturedAt, providerSignature: item.signature }; const record: WorkflowTelemetryRecord = { ...recordBody, recordDigest: hash(canonical(recordBody)) }; telemetry.push(record); ensureCumulativeTelemetryBudget(telemetry, options.telemetryBudget!); options.storage?.saveTelemetryRecord?.(record); const telemetryProvenance = { version: 1 as const, workflowId: workflow.id, runId: options.runId, workflowIntegrity: workflow.integrity, topologyDigest: workflow.topology.topologyDigest, kind: "telemetry" as const, nodeId: node.id, attempt, artifactId: `${node.id}.${attempt}.telemetry`, artifactDigest: record.recordDigest, capturedAt: item.capturedAt }; addProvenance(telemetryProvenance); } catch (error) { return { id: node.id, result: complete(node, attempt, "failed", error instanceof Error ? error.message : "provider telemetry unavailable", undefined, undefined, "permanent") }; } }
      const parsed = asEnvelope(value, maxOutputBytes); if (parsed.error) return { id: node.id, result: complete(node, attempt, "failed", parsed.error, undefined, undefined, parsed.classification) };
      const envelope = parsed.envelope!;
      const recipeInput = node.input && typeof node.input === "object" && !Array.isArray(node.input) ? node.input as { recipeId?: unknown; outputShape?: unknown } : undefined;
      if (envelope.status === "succeeded" && typeof recipeInput?.recipeId === "string" && recipeInput.outputShape !== undefined) {
        try {
          const candidateSet = recipeInput.recipeId === "candidate-selection" ? [...new Set(depsOf(node).flatMap((id) => {
            const output = results[id]?.output; if (typeof output === "string") return [output]; if (Array.isArray(output)) return output.filter((item): item is string => typeof item === "string"); if (output && typeof output === "object") { const record = output as Record<string, unknown>; const candidates = record.candidates; if (Array.isArray(candidates)) return candidates.filter((item): item is string => typeof item === "string"); if (typeof record.candidate === "string") return [record.candidate]; return []; } return [];
          }))] : undefined;
          validateRecipeOutput(recipeInput.recipeId as WorkflowRecipeId, envelope.output, candidateSet ? { candidates: candidateSet } : {});
        }
        catch (error) { return { id: node.id, result: complete(node, attempt, "failed", error instanceof Error ? error.message : "trusted recipe output is malformed", undefined, undefined, "malformed") }; }
      }
      const retry = envelope.status !== "succeeded" && envelope.retryable === true && attempt < maxAttempts;
      if (retry) { nodes[node.id] = "retrying"; markAttempt(node, attempt, { status: "retrying", finishedAt: now(), error: envelope.error ?? "retryable result", classification: "retryable" }); save(); continue; }
      const status = envelope.status === "succeeded" ? "succeeded" : envelope.status === "blocked" ? "blocked" : "failed";
      return { id: node.id, result: complete(node, attempt, status, envelope.error ?? undefined, envelope, parsed.rawDigest, status === "succeeded" ? undefined : envelope.retryable ? "retryable" : "permanent") };
    }
    throw new Error("retry accounting exhausted without a result");
  };
  const ready = () => workflow.dag.order.map((id) => workflow.dag.byId.get(id)!).filter((node) => nodes[node.id] === "pending" && depsOf(node).every((dep) => nodes[dep] === "succeeded"));
  try {
    while (state.status !== "paused" && Object.values(nodes).some((status) => status === "pending" || status === "running" || status === "retrying")) {
      if (controller.signal.aborted) for (const node of workflow.nodes) if (nodes[node.id] === "pending" || nodes[node.id] === "retrying") complete(node, undefined, "cancelled", timedOut ? "workflow runtime exceeded" : "workflow cancelled", undefined, undefined, "cancelled");
      for (const node of ready()) if (!controller.signal.aborted && running.size < capacity) { const task = run(node); running.set(node.id, task); void task.finally(() => running.delete(node.id)).catch(() => {}); }
      for (const node of workflow.nodes) if (nodes[node.id] === "pending" && depsOf(node).some((dep) => ["failed", "blocked", "cancelled"].includes(nodes[dep]))) complete(node, undefined, "blocked", "dependency did not succeed", undefined, undefined, "permanent");
      if (!running.size) { if (Object.values(nodes).some((x) => x === "pending")) for (const node of workflow.nodes) if (nodes[node.id] === "pending") complete(node, undefined, "blocked", "unschedulable dependency", undefined, undefined, "permanent"); break; }
      await Promise.race(running.values());
    }
    if (running.size) await Promise.allSettled(running.values());
  } catch (error) { const active = [...running.values()]; controller.abort(); await Promise.allSettled(active); throw error; }
  finally { clearTimeout(runtimeTimer); if (options.signal) options.signal.removeEventListener("abort", externalAbort); policySecret.fill(0); }
  const cancelled = Object.values(nodes).some((x) => x === "cancelled"); const failed = Object.values(nodes).some((x) => x === "failed" || x === "blocked"); const finalStatus = state.status === "paused" ? "paused" : cancelled ? "cancelled" : failed ? "failed" : "completed";
  state = { ...state, status: finalStatus, nodes: { ...nodes }, results: { ...results }, attempts: Object.fromEntries(Object.entries(attempts).map(([k, v]) => [k, [...v]])), gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, [...v]])), worktrees: { ...worktrees }, telemetry: [...telemetry], provenance: [...provenance], ...(finalStatus === "paused" ? { pause: state.pause } : { pause: undefined }), updatedAt: now() }; persist(); return { state };
}
export function parseAgentResultEnvelope(value: unknown, maxOutputBytes = MAX_SERIALIZED_PAYLOAD_BYTES): AgentResultEnvelope { const parsed = asEnvelope(value, positiveBounded("maxOutputBytes", maxOutputBytes, MAX_SERIALIZED_PAYLOAD_BYTES)); if (!parsed.envelope) throw new Error(parsed.error); return parsed.envelope; }
export const runWorkflow = executeWorkflow;
export class WorkflowExecutor { private readonly options: ExecutorOptions; constructor(options: ExecutorOptions) { this.options = options; } execute(workflow: CompiledWorkflow): Promise<ExecutionResult> { return executeWorkflow(workflow, this.options); } }
