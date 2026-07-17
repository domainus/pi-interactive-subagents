import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DEFAULT_CAPABILITY_CATALOG, type CapabilityCatalog } from "./capabilities.ts";
import { resolveCombinedModelPolicy } from "./kernels.ts";
import { WORKFLOW_MODELS, WORKFLOW_VERSION, type AgentResultEnvelope, type GateResult, type NodeAttempt, type NodeStatus, type TaskNode, type TaskResult, type WorkflowRunMetadata, type WorkflowRunStatus, type WorkflowSpec, type WorkflowState, type WorktreeEvidence, type WorktreeMetadata, type ValidationIssue, type ValidationResult, type WorkflowPauseInfo, type WorkflowTopologySummary, type WorkflowTelemetryRecord, type WorkflowArtifactProvenance } from "./types.ts";

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const SafeText = Type.String({ minLength: 1, maxLength: 16_384 });
const ShortText = Type.String({ minLength: 1, maxLength: 512 });
const RelativePath = Type.String({ minLength: 1, maxLength: 512 });
const RelativeGlob = Type.String({ minLength: 1, maxLength: 512 });
const AbsolutePath = Type.String({ minLength: 1, maxLength: 4096 });
/** Shared serialized payload ceilings. TypeBox Unknown is deliberately supplemented by these checks. */
export const MAX_SERIALIZED_PAYLOAD_BYTES = 65_536;
/** JSON bytes, excluding the newline used by storage. */
export const MAX_JSON_ARTIFACT_BYTES = 1_048_575;
export const MAX_WORKFLOW_STATE_BYTES = 67_108_863;
export function serializedByteLength(value: unknown): number | undefined {
  try { const text = JSON.stringify(value); return text === undefined ? undefined : Buffer.byteLength(text, "utf8"); } catch { return undefined; }
}
export function withinSerializedBytes(value: unknown, maxBytes = MAX_SERIALIZED_PAYLOAD_BYTES): boolean {
  const size = serializedByteLength(value); return size !== undefined && Number.isSafeInteger(size) && size <= maxBytes;
}
const Kernel = Type.Union([Type.Literal("readonly"), Type.Literal("builder"), Type.Literal("validator"), Type.Literal("adjudicator"), Type.Literal("interactive")]);
const Thinking = Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => Type.Literal(value)));
const NodeStatusSchema = Type.Union(["pending", "running", "retrying", "succeeded", "failed", "blocked", "cancelled"].map((value) => Type.Literal(value)));
const GateKindSchema = Type.Union(["result-schema", "dependency-success", "diff-scope", "command"].map((value) => Type.Literal(value)));
const WorkflowRunStatusSchema = Type.Union(["pending", "running", "cancelling", "paused", "cancelled", "completed", "failed", "recovered"].map((value) => Type.Literal(value)));
const PauseSchema = Type.Object({ reason: Type.Union(["usage-limit", "provider-unavailable", "manual"].map((value) => Type.Literal(value))), message: Type.String({ minLength: 1, maxLength: 512 }), resetAt: Type.Optional(Type.Integer({ minimum: 0 })), retryAfterMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })), callbackId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" })), hintDigest: Digest, pausedAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const TopologySchema = Type.Object({ nodeCount: Type.Integer({ minimum: 1, maximum: 256 }), edgeCount: Type.Integer({ minimum: 0, maximum: 65_536 }), maxDepth: Type.Integer({ minimum: 1, maximum: 256 }), order: Type.Array(Id, { minItems: 1, maxItems: 256 }), nodeDigests: Type.Record(Id, Digest), topologyDigest: Digest }, { additionalProperties: false });
const WorkflowRunTemplateSchema = Type.Union(["research", "build", "review"].map((value) => Type.Literal(value)));
export const ModelRequestSchema = Type.Object({ tier: Type.Union([Type.Literal("luna"), Type.Literal("sol")]), risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")])) }, { additionalProperties: false });
export const GateSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), kind: GateKindSchema, dependsOn: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 256, uniqueItems: true })), reason: Type.Optional(Type.String({ maxLength: 1024 })), argv: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 })), allowGlobs: Type.Optional(Type.Array(RelativeGlob, { minItems: 1, maxItems: 128, uniqueItems: true })), denyGlobs: Type.Optional(Type.Array(RelativeGlob, { maxItems: 128, uniqueItems: true })) }, { additionalProperties: false });
export const WorkflowBoundsSchema = Type.Object({ maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })), maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })), maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })), maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })), maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000 })) }, { additionalProperties: false });
export const WorkflowPolicySchema = Type.Object({ model: Type.Optional(Type.Union(WORKFLOW_MODELS.map((value) => Type.Literal(value)))), thinking: Type.Optional(Thinking), maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SERIALIZED_PAYLOAD_BYTES })) }, { additionalProperties: false });
export const TaskNodeSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), id: Id, kernel: Kernel, objective: SafeText, expertise: Type.Array(ShortText, { maxItems: 32 }), capabilities: Type.Array(ShortText, { maxItems: 64 }), mode: Type.Union([Type.Literal("read-only"), Type.Literal("mutating")]), requiresWorktree: Type.Boolean(), workspaceRoot: Type.Optional(RelativePath), allowGlobs: Type.Optional(Type.Array(RelativeGlob, { minItems: 1, maxItems: 128, uniqueItems: true })), denyGlobs: Type.Optional(Type.Array(RelativeGlob, { maxItems: 128, uniqueItems: true })), dependsOn: Type.Optional(Type.Array(Id, { maxItems: 256, uniqueItems: true })), gate: Type.Optional(GateSchema), sourceNodeId: Type.Optional(Id), input: Type.Optional(Type.Unknown()), model: Type.Optional(ModelRequestSchema), retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }, { additionalProperties: false });
export const WorkflowSpecSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), id: Id, sessionId: Id, objective: SafeText, expertise: Type.Optional(Type.Array(ShortText, { maxItems: 32 })), capabilities: Type.Optional(Type.Array(ShortText, { maxItems: 64, uniqueItems: true })), nodes: Type.Array(TaskNodeSchema, { minItems: 1, maxItems: 256 }), bounds: Type.Optional(WorkflowBoundsSchema), policy: Type.Optional(WorkflowPolicySchema) }, { additionalProperties: false });
export const WorkflowRunMetadataSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), runId: Id, workflowId: Id, sessionId: Id, cwd: AbsolutePath, worktreeRoot: Type.Optional(AbsolutePath), workflowIntegrity: Digest, template: WorkflowRunTemplateSchema, status: WorkflowRunStatusSchema, startedAt: Type.Optional(Type.Integer({ minimum: 0 })), updatedAt: Type.Optional(Type.Integer({ minimum: 0 })), finishedAt: Type.Optional(Type.Integer({ minimum: 0 })), topology: Type.Optional(TopologySchema), pause: Type.Optional(PauseSchema), revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), parentWorkflowId: Type.Optional(Id), parentRunId: Type.Optional(Id), parentIntegrity: Type.Optional(Digest), invalidatedNodeIds: Type.Optional(Type.Array(Id, { maxItems: 256, uniqueItems: true })) }, { additionalProperties: false });
export const AgentResultEnvelopeSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("blocked")]), output: Type.Optional(Type.Unknown()), error: Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()])), retryable: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const TaskResultSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, nodeId: Id, workflowIntegrity: Type.Optional(Digest), topologyDigest: Type.Optional(Digest), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("cancelled")]), output: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), startedAt: Type.Optional(Type.Integer({ minimum: 0 })), finishedAt: Type.Integer({ minimum: 0 }), attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), rawEnvelope: Type.Optional(AgentResultEnvelopeSchema), rawEnvelopeDigest: Type.Optional(Digest) }, { additionalProperties: false });
export const NodeAttemptSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, nodeId: Id, attempt: Type.Integer({ minimum: 1, maximum: 100 }), status: NodeStatusSchema, startedAt: Type.Optional(Type.Integer({ minimum: 0 })), finishedAt: Type.Optional(Type.Integer({ minimum: 0 })), error: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), classification: Type.Optional(Type.Union([Type.Literal("retryable"), Type.Literal("permanent"), Type.Literal("cancelled"), Type.Literal("malformed"), Type.Literal("usage-limit"), Type.Literal("imported")])) }, { additionalProperties: false });
export const GateResultSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, nodeId: Id, workflowIntegrity: Type.Optional(Digest), topologyDigest: Type.Optional(Digest), kind: GateKindSchema, passed: Type.Boolean(), checkedAt: Type.Integer({ minimum: 0 }), sourceNodeId: Type.Optional(Id), attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), evidenceDigest: Type.Optional(Digest), rawEnvelopeDigest: Type.Optional(Digest), evaluationId: Digest, gateDigest: Digest, error: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, { additionalProperties: false });
export const WorkflowTelemetryRecordSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, runId: Id, workflowIntegrity: Digest, topologyDigest: Digest, nodeId: Id, attempt: Type.Integer({ minimum: 1, maximum: 100 }), model: Type.Union(WORKFLOW_MODELS.map((value) => Type.Literal(value))), requestId: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._:-]+$" }), inputTokens: Type.Integer({ minimum: 0, maximum: 100_000_000 }), outputTokens: Type.Integer({ minimum: 0, maximum: 100_000_000 }), costUsd: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })), runtimeMs: Type.Integer({ minimum: 0, maximum: 86_400_000 }), capturedAt: Type.Integer({ minimum: 0 }), providerSignature: Type.String({ minLength: 64, maxLength: 512, pattern: "^[a-f0-9]+$" }), recordDigest: Digest }, { additionalProperties: false });
export const WorkflowArtifactProvenanceSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, runId: Id, workflowIntegrity: Digest, topologyDigest: Digest, kind: Type.Union(["result", "gate", "worktree", "telemetry", "manifest"].map((value) => Type.Literal(value))), nodeId: Type.Optional(Id), attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), artifactId: Id, artifactDigest: Digest, capturedAt: Type.Integer({ minimum: 0 }), importedFromWorkflowId: Type.Optional(Id), importedFromRunId: Type.Optional(Id), importedFromArtifactDigest: Type.Optional(Digest) }, { additionalProperties: false });
const WorktreeEvidenceFields = { version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, nodeId: Id, workflowIntegrity: Type.Optional(Digest), topologyDigest: Type.Optional(Digest), attempt: Type.Integer({ minimum: 1, maximum: 100 }), mode: Type.Union([Type.Literal("read-only"), Type.Literal("mutating")]), cwd: AbsolutePath, path: Type.Optional(AbsolutePath), base: Type.String({ pattern: "^[A-Fa-f0-9]{40,64}$" }), head: Type.String({ pattern: "^[A-Fa-f0-9]{40,64}$" }), diffHash: Digest, changedFiles: Type.Array(RelativePath, { maxItems: 512, uniqueItems: true }), evidenceDigest: Digest, capturedAt: Type.Integer({ minimum: 0 }), preserved: Type.Boolean() } as const;
export const WorktreeEvidenceSchema = Type.Object(WorktreeEvidenceFields, { additionalProperties: false });
export const WorktreeMetadataSchema = Type.Object({ ...WorktreeEvidenceFields, status: Type.String({ maxLength: 65_536 }), diff: Type.String({ maxLength: 4_194_304 }) }, { additionalProperties: false });
export const WorkflowStateSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, sessionId: Id, runId: Type.Optional(Id), status: Type.Union(["pending", "running", "paused", "retrying", "gated", "completed", "succeeded", "failed", "cancelled", "recovered"].map((value) => Type.Literal(value))), nodes: Type.Record(Id, NodeStatusSchema), results: Type.Optional(Type.Record(Id, TaskResultSchema)), attempts: Type.Optional(Type.Record(Id, Type.Array(NodeAttemptSchema, { maxItems: 100 }))), gates: Type.Optional(Type.Record(Id, Type.Array(GateResultSchema, { maxItems: 64 }))), worktrees: Type.Optional(Type.Record(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[1-9][0-9]{0,2}$" }), WorktreeEvidenceSchema)), pause: Type.Optional(PauseSchema), telemetry: Type.Optional(Type.Array(WorkflowTelemetryRecordSchema, { maxItems: 10000 })), provenance: Type.Optional(Type.Array(WorkflowArtifactProvenanceSchema, { maxItems: 10000 })), updatedAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const schemas = { WorkflowSpecSchema, WorkflowRunMetadataSchema, TaskNodeSchema, GateSchema, AgentResultEnvelopeSchema, TaskResultSchema, NodeAttemptSchema, GateResultSchema, WorktreeEvidenceSchema, WorktreeMetadataSchema, WorkflowStateSchema, WorkflowTelemetryRecordSchema, WorkflowArtifactProvenanceSchema, ModelRequestSchema, WorkflowBoundsSchema, WorkflowPolicySchema } as const;

function schemaIssues(schema: TSchema, value: unknown): ValidationIssue[] { if (Value.Check(schema, value)) return []; return [...Value.Errors(schema, value)].slice(0, 64).map((e) => ({ path: e.path && e.path !== "/" ? e.path : "$", message: e.message })); }
const issue = (path: string, message: string): ValidationIssue => ({ path, message });
const unsafeRelative = (value: string): boolean => typeof value !== "string" || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => part === ".." || part === "." || part === "");
const unsafeGlob = (value: string): boolean => unsafeRelative(value.replaceAll("**", "x").replaceAll("*", "x").replaceAll("?", "x")) || !/^[A-Za-z0-9_@+.,/\-*? ]+$/.test(value);
const hasDuplicate = (items: readonly string[] | undefined): boolean => Boolean(items && new Set(items).size !== items.length);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const jsonDigest = (value: unknown): string | undefined => { try { return sha256(JSON.stringify(value)); } catch { return undefined; } };
const canonical = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; };
const evidenceDigest = (item: WorktreeEvidence): string => sha256(canonical({ workflowId: item.workflowId, nodeId: item.nodeId, attempt: item.attempt, base: item.base, head: item.head, diffHash: item.diffHash, changedFiles: item.changedFiles }));
const TERMINAL_ATTEMPT_STATUSES = new Set<NodeStatus>(["succeeded", "failed", "blocked", "cancelled"]);
function legalAttemptTransition(previous: NodeAttempt | undefined, next: NodeAttempt): boolean {
  if (!previous) return next.status === "running" || next.status === "cancelled";
  if (previous.attempt !== next.attempt) return false;
  if (TERMINAL_ATTEMPT_STATUSES.has(previous.status)) return isDeepEqualAttempt(previous, next);
  if (previous.status === "running") return next.status === "running" || next.status === "retrying" || TERMINAL_ATTEMPT_STATUSES.has(next.status);
  if (previous.status === "retrying") return next.status === "retrying" || next.status === "running" || TERMINAL_ATTEMPT_STATUSES.has(next.status);
  return false;
}
function isDeepEqualAttempt(left: NodeAttempt, right: NodeAttempt): boolean { return canonical(left) === canonical(right); }
function validateAttemptHistory(list: readonly NodeAttempt[]): boolean {
  if (!list.length) return true;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item.attempt !== i + 1 || item.status === "pending") return false;
    if (i < list.length - 1) {
      const previous = list[i - 1];
      const usageResume = previous?.status === "cancelled" && previous.classification === "usage-limit" && item.status === "running";
      if (!usageResume && item.status !== "retrying" && item.status !== "cancelled") return false;
    }
    if (i > 0) {
      const previous = list[i - 1];
      if (TERMINAL_ATTEMPT_STATUSES.has(previous.status) && previous.status !== "cancelled") return false;
    }
    if (item.status === "running" && item.finishedAt !== undefined) return false;

  }
  return true;
}

function validateEvidence(item: WorktreeEvidence, path: string, issues: ValidationIssue[]): void {
  if (!isAbsolute(item.cwd) || resolve(item.cwd) !== item.cwd || item.cwd.includes("\0") || (item.mode === "read-only" && (item.path !== undefined || item.preserved)) || (item.path !== undefined && (!isAbsolute(item.path) || resolve(item.path) !== item.path || item.path.includes("\0"))) || (item.mode === "mutating" && (!item.path || item.path !== item.cwd || !item.preserved)) || item.changedFiles.some(unsafeRelative)) issues.push(issue(path, "unsafe worktree metadata"));
  if (item.evidenceDigest !== evidenceDigest(item)) issues.push(issue(path, "worktree evidence digest mismatch"));
}
export function validateWorktreeMetadata(value: unknown): ValidationResult<WorktreeMetadata> {
  const issues = schemaIssues(WorktreeMetadataSchema, value); if (issues.length) return { ok: false, issues }; const item = value as WorktreeMetadata; validateEvidence(item, "$", issues);
  if (Buffer.byteLength(item.status, "utf8") > 65_536 || Buffer.byteLength(item.diff, "utf8") > 4_194_304) issues.push(issue("$", "worktree evidence exceeds byte bound"));
  if (item.diffHash !== sha256(item.diff)) issues.push(issue("/diffHash", "worktree diff digest mismatch"));
  return issues.length ? { ok: false, issues } : { ok: true, value: item };
}

export function validateTaskNode(value: unknown, catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): ValidationResult<TaskNode> {
  const issues = schemaIssues(TaskNodeSchema, value); if (issues.length) return { ok: false, issues };
  const node = value as TaskNode;
  if (node.mode === "mutating" && node.kernel !== "builder") issues.push(issue("/mode", "only the builder kernel may mutate"));
  if (node.mode === "mutating" && !node.requiresWorktree) issues.push(issue("/requiresWorktree", "mutating builder nodes require a worktree"));
  if (node.workspaceRoot && unsafeRelative(node.workspaceRoot)) issues.push(issue("/workspaceRoot", "unsafe ownership path"));
  for (const [field, values] of [["allowGlobs", node.allowGlobs], ["denyGlobs", node.denyGlobs], ["gate/allowGlobs", node.gate?.allowGlobs], ["gate/denyGlobs", node.gate?.denyGlobs]] as const) if (values?.some(unsafeGlob)) issues.push(issue(`/${field}`, "unsafe relative ownership glob"));
  if (hasDuplicate(node.dependsOn) || hasDuplicate(node.gate?.dependsOn)) issues.push(issue("/dependsOn", "duplicate dependency IDs"));
  if (node.dependsOn && JSON.stringify([...node.dependsOn].slice().sort()) !== JSON.stringify(node.dependsOn)) issues.push(issue("/dependsOn", "dependsOn must be in canonical sorted order"));
  if (node.gate?.dependsOn && JSON.stringify([...node.gate.dependsOn].slice().sort()) !== JSON.stringify(node.gate.dependsOn)) issues.push(issue("/gate/dependsOn", "gate dependsOn must be in canonical sorted order"));
  if (new Set(node.expertise).size !== node.expertise.length || node.expertise.some((entry) => entry.trim() !== entry)) issues.push(issue("/expertise", "expertise must be unique and trimmed"));
  if (node.gate?.kind === "command") { if (!node.gate.argv?.length || node.gate.argv.some((part) => part.includes("\0"))) issues.push(issue("/gate/argv", "command gate requires safe argv")); }
  else if (node.gate?.argv) issues.push(issue("/gate/argv", "argv is only valid for command gates"));
  if (node.gate && !node.gate.dependsOn?.length) issues.push(issue("/gate/dependsOn", "deterministic gates require dependencies"));
  if (node.input !== undefined && !withinSerializedBytes(node.input)) issues.push(issue("/input", "serialized input exceeds payload bound"));
  for (const capability of node.capabilities) if (!Object.prototype.hasOwnProperty.call(catalog, capability)) issues.push(issue("/capabilities", "unknown capability"));
  return issues.length ? { ok: false, issues } : { ok: true, value: node };
}
export function computeWorkflowDepths(nodes: readonly TaskNode[]): Readonly<Record<string, number>> {
  const byId = new Map(nodes.map((node) => [node.id, node])); const memo = new Map<string, number>(); const active = new Set<string>();
  const depth = (id: string): number => { const cached = memo.get(id); if (cached !== undefined) return cached; if (active.has(id)) throw new Error("workflow dependency cycle detected"); active.add(id); const node = byId.get(id); if (!node) throw new Error(`unknown dependency: ${id}`); const deps = [...new Set([...(node.dependsOn ?? []), ...(node.gate?.dependsOn ?? [])])]; const value = deps.length ? Math.max(...deps.map(depth)) + 1 : 1; active.delete(id); memo.set(id, value); return value; };
  for (const node of nodes) depth(node.id); return Object.freeze(Object.fromEntries(memo));
}
const RUN_TERMINAL_STATUSES = new Set<WorkflowRunStatus>(["cancelled", "completed", "failed"]);
const RUN_STATUS_TRANSITIONS: Readonly<Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>> = Object.freeze({
  pending: Object.freeze(["pending", "running", "cancelling", "cancelled", "failed"]),
  running: Object.freeze(["running", "cancelling", "paused", "cancelled", "completed", "failed", "recovered"]),
  cancelling: Object.freeze(["cancelling", "cancelled", "completed", "failed", "recovered"]),
  paused: Object.freeze(["paused", "running", "cancelling", "cancelled", "failed", "recovered"]),
  recovered: Object.freeze(["recovered", "running", "cancelling", "paused", "cancelled", "completed", "failed"]),
  cancelled: Object.freeze(["cancelled"]),
  completed: Object.freeze(["completed"]),
  failed: Object.freeze(["failed"]),
}) as any;
export function isLegalWorkflowRunStatusTransition(previous: WorkflowRunStatus, next: WorkflowRunStatus): boolean {
  return Object.prototype.hasOwnProperty.call(RUN_STATUS_TRANSITIONS, previous) && RUN_STATUS_TRANSITIONS[previous].includes(next);
}
export function validateWorkflowRunMetadata(value: unknown, ownership?: { readonly runId?: string; readonly workflowId?: string; readonly sessionId?: string }): ValidationResult<WorkflowRunMetadata> {
  const issues = schemaIssues(WorkflowRunMetadataSchema, value); if (issues.length) return { ok: false, issues };
  const metadata = value as WorkflowRunMetadata;
  if (ownership?.runId !== undefined && metadata.runId !== ownership.runId) issues.push(issue("/runId", "artifact ownership mismatch"));
  if (ownership?.workflowId !== undefined && metadata.workflowId !== ownership.workflowId) issues.push(issue("/workflowId", "artifact ownership mismatch"));
  if (ownership?.sessionId !== undefined && metadata.sessionId !== ownership.sessionId) issues.push(issue("/sessionId", "artifact ownership mismatch"));
  if (!isAbsolute(metadata.cwd) || resolve(metadata.cwd) !== metadata.cwd || metadata.cwd.includes("\0")) issues.push(issue("/cwd", "cwd must be absolute and normalized"));
  if (metadata.worktreeRoot !== undefined && (!isAbsolute(metadata.worktreeRoot) || resolve(metadata.worktreeRoot) !== metadata.worktreeRoot || metadata.worktreeRoot.includes("\0"))) issues.push(issue("/worktreeRoot", "worktree root must be absolute and normalized"));
  if (metadata.worktreeRoot !== undefined) { const rel = relative(metadata.worktreeRoot, metadata.cwd); if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)) || (!relative(metadata.cwd, metadata.worktreeRoot).startsWith("..") && !isAbsolute(relative(metadata.cwd, metadata.worktreeRoot)))) issues.push(issue("/worktreeRoot", "worktree root must be disjoint from cwd")); }
  if (metadata.template === "build" && metadata.worktreeRoot === undefined) issues.push(issue("/worktreeRoot", "build runs require an external worktree root"));
  const times = [metadata.startedAt, metadata.updatedAt, metadata.finishedAt];
  if (times.some((time) => time !== undefined && (!Number.isSafeInteger(time) || time < 0))) issues.push(issue("/", "timestamps must be non-negative safe integers"));
  if (metadata.startedAt !== undefined && metadata.updatedAt !== undefined && metadata.updatedAt < metadata.startedAt) issues.push(issue("/updatedAt", "updatedAt cannot precede startedAt"));
  if (metadata.finishedAt !== undefined && metadata.startedAt !== undefined && metadata.finishedAt < metadata.startedAt) issues.push(issue("/finishedAt", "finishedAt cannot precede startedAt"));
  if (metadata.finishedAt !== undefined && metadata.updatedAt !== undefined && metadata.updatedAt > metadata.finishedAt) issues.push(issue("/updatedAt", "updatedAt cannot follow finishedAt"));
  if (metadata.status === "pending" && (metadata.startedAt !== undefined || metadata.finishedAt !== undefined)) issues.push(issue("/status", "pending runs cannot have started or finished timestamps"));
  if (["running", "cancelling", "recovered", "paused"].includes(metadata.status) && (metadata.startedAt === undefined || metadata.finishedAt !== undefined)) issues.push(issue("/status", "active runs require startedAt and cannot have finishedAt"));
  if (metadata.status === "paused" && !metadata.pause) issues.push(issue("/pause", "paused runs require bounded pause details"));
  if (metadata.pause) { if (metadata.status !== "paused") issues.push(issue("/pause", "pause details require paused status")); if (metadata.pause.resetAt !== undefined && metadata.pause.resetAt < metadata.pause.pausedAt) issues.push(issue("/pause/resetAt", "resetAt cannot precede pausedAt")); if (metadata.pause.hintDigest !== sha256(canonical({ reason: metadata.pause.reason, message: metadata.pause.message, ...(metadata.pause.resetAt !== undefined ? { resetAt: metadata.pause.resetAt } : {}), ...(metadata.pause.retryAfterMs !== undefined ? { retryAfterMs: metadata.pause.retryAfterMs } : {}), ...(metadata.pause.callbackId !== undefined ? { callbackId: metadata.pause.callbackId } : {}), pausedAt: metadata.pause.pausedAt }))) issues.push(issue("/pause/hintDigest", "pause hint digest mismatch")); }
  if (metadata.revision !== undefined && metadata.revision > 1 && (!metadata.parentWorkflowId || !metadata.parentRunId || !metadata.parentIntegrity)) issues.push(issue("/revision", "revised runs require immutable parent lineage"));
  if (metadata.topology) { if (metadata.topology.nodeCount !== metadata.topology.order.length || Object.keys(metadata.topology.nodeDigests).length !== metadata.topology.nodeCount || new Set(metadata.topology.order).size !== metadata.topology.nodeCount) issues.push(issue("/topology", "topology summary counts/order mismatch")); const { topologyDigest: _digest, ...topologyBody } = metadata.topology; if (metadata.topology.topologyDigest !== sha256(canonical(topologyBody))) issues.push(issue("/topology/topologyDigest", "topology digest mismatch")); }

  if (RUN_TERMINAL_STATUSES.has(metadata.status) && (metadata.startedAt === undefined || metadata.finishedAt === undefined)) issues.push(issue("/status", "terminal runs require startedAt and finishedAt"));
  return issues.length ? { ok: false, issues } : { ok: true, value: metadata };
}

export const validateRunMetadata = validateWorkflowRunMetadata;
export const validateWorkflowRun = validateWorkflowRunMetadata;
export const WorkflowRunSchema = WorkflowRunMetadataSchema;

export function validateWorkflowSpec(value: unknown, catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): ValidationResult<WorkflowSpec> {
  const issues = schemaIssues(WorkflowSpecSchema, value); if (issues.length) return { ok: false, issues }; const spec = value as WorkflowSpec; const ids = new Set(spec.nodes.map((node) => node.id));
  if (!withinSerializedBytes(spec, MAX_JSON_ARTIFACT_BYTES)) issues.push(issue("$", "serialized workflow specification exceeds artifact bound"));
  if (ids.size !== spec.nodes.length) issues.push(issue("/nodes", "duplicate node ID"));
  if (spec.nodes.length > (spec.bounds?.maxNodes ?? 256)) issues.push(issue("/nodes", "node count exceeds configured bound"));
  for (const capability of spec.capabilities ?? []) if (!Object.prototype.hasOwnProperty.call(catalog, capability)) issues.push(issue("/capabilities", "unknown capability"));
  for (const [i, node] of spec.nodes.entries()) {
    const checked = validateTaskNode(node, catalog); if (!checked.ok) issues.push(...checked.issues.map((x) => ({ ...x, path: `/nodes/${i}${x.path}` })));
    for (const dependency of new Set([...(node.dependsOn ?? []), ...(node.gate?.dependsOn ?? [])])) if (!ids.has(dependency)) issues.push(issue(`/nodes/${i}/dependsOn`, "unknown dependency ID"));
    if (node.sourceNodeId && (!ids.has(node.sourceNodeId) || !node.gate?.dependsOn?.includes(node.sourceNodeId))) issues.push(issue(`/nodes/${i}/sourceNodeId`, "source node must exist and be a gate dependency"));
    if ((node.retries ?? 0) > (spec.bounds?.maxRetries ?? 10)) issues.push(issue(`/nodes/${i}/retries`, "retries exceed bound"));
    try { resolveCombinedModelPolicy({ node: node.model, workflow: spec.policy }); } catch { issues.push(issue(`/nodes/${i}/model`, "contradictory or unsupported model policy")); }
  }
  try { const depths = computeWorkflowDepths(spec.nodes); for (const [i, node] of spec.nodes.entries()) if (depths[node.id] > (spec.bounds?.maxDepth ?? 32)) issues.push(issue(`/nodes/${i}/depth`, "computed depth exceeds bound")); } catch (error) { issues.push(issue("/nodes", error instanceof Error ? error.message : "workflow dependency cycle detected")); }
  return issues.length ? { ok: false, issues: issues.slice(0, 96) } : { ok: true, value: spec };
}
export function validateAgentResultEnvelope(value: unknown): ValidationResult<AgentResultEnvelope> { const issues = schemaIssues(AgentResultEnvelopeSchema, value); if (issues.length) return { ok: false, issues }; const envelope = value as AgentResultEnvelope; if (!withinSerializedBytes(envelope, MAX_JSON_ARTIFACT_BYTES)) issues.push(issue("$", "serialized envelope exceeds artifact bound")); if (envelope.output !== undefined && !withinSerializedBytes(envelope.output)) issues.push(issue("/output", "serialized output exceeds payload bound")); if ((envelope.status === "failed" || envelope.status === "blocked") && !envelope.error) issues.push(issue("/error", `${envelope.status} envelope requires an error`)); if (envelope.status === "succeeded" && envelope.error != null) issues.push(issue("/error", "successful envelope cannot contain an error")); return issues.length ? { ok: false, issues } : { ok: true, value: envelope }; }
export function validateTaskResult(value: unknown): ValidationResult<TaskResult> { const issues = schemaIssues(TaskResultSchema, value); if (issues.length) return { ok: false, issues }; const result = value as TaskResult; if (!withinSerializedBytes(result, MAX_JSON_ARTIFACT_BYTES)) issues.push(issue("$", "serialized task result exceeds artifact bound")); if (result.output !== undefined && !withinSerializedBytes(result.output)) issues.push(issue("/output", "serialized output exceeds payload bound")); if (result.rawEnvelope !== undefined && !withinSerializedBytes(result.rawEnvelope)) issues.push(issue("/rawEnvelope", "serialized envelope exceeds payload bound")); if (result.startedAt !== undefined && result.startedAt > result.finishedAt) issues.push(issue("/startedAt", "start timestamp is after finish timestamp")); if (result.status !== "succeeded" && !result.error) issues.push(issue("/error", "non-success result requires an error")); if (result.status === "succeeded" && result.error !== undefined) issues.push(issue("/error", "successful result cannot contain an error")); if ((result.rawEnvelope === undefined) !== (result.rawEnvelopeDigest === undefined)) issues.push(issue("/rawEnvelope", "raw envelope and digest must appear together")); if (result.rawEnvelope) { if (result.rawEnvelopeDigest !== jsonDigest(result.rawEnvelope)) issues.push(issue("/rawEnvelopeDigest", "raw envelope digest mismatch")); if (result.status !== result.rawEnvelope.status || canonical(result.output) !== canonical(result.rawEnvelope.output) || result.error !== (result.rawEnvelope.error ?? undefined)) issues.push(issue("/rawEnvelope", "task result does not semantically match raw envelope")); } return issues.length ? { ok: false, issues } : { ok: true, value: result }; }
export function validateWorkflowState(value: unknown, ownership?: { workflowId?: string; sessionId?: string; runId?: string }): ValidationResult<WorkflowState> {
  const issues = schemaIssues(WorkflowStateSchema, value); if (issues.length) return { ok: false, issues }; const state = value as WorkflowState;
  if (!withinSerializedBytes(state, MAX_WORKFLOW_STATE_BYTES)) issues.push(issue("$", "serialized workflow state exceeds aggregate bound"));
  if (ownership?.workflowId && state.workflowId !== ownership.workflowId) issues.push(issue("/workflowId", "artifact ownership mismatch")); if (ownership?.sessionId && state.sessionId !== ownership.sessionId) issues.push(issue("/sessionId", "artifact ownership mismatch")); if (ownership?.runId && state.runId !== ownership.runId) issues.push(issue("/runId", "artifact ownership mismatch"));
  if (state.status === "paused" && !state.pause) issues.push(issue("/pause", "paused state requires bounded pause details"));
  if (state.pause && state.status !== "paused") issues.push(issue("/pause", "pause details require paused state"));
  if (state.pause) { const { hintDigest: _digest, ...hintBody } = state.pause; if (state.pause.hintDigest !== sha256(canonical(hintBody))) issues.push(issue("/pause/hintDigest", "pause hint digest mismatch")); }
  for (const [index, item] of (state.telemetry ?? []).entries()) { if (item.workflowId !== state.workflowId || item.runId.length < 1 || item.workflowIntegrity.length !== 64 || item.topologyDigest.length !== 64 || !Object.prototype.hasOwnProperty.call(state.nodes, item.nodeId)) issues.push(issue(`/telemetry/${index}`, "telemetry ownership mismatch")); const { recordDigest: _digest, ...recordBody } = item; if (item.recordDigest !== sha256(canonical(recordBody))) issues.push(issue(`/telemetry/${index}/recordDigest`, "telemetry record digest mismatch")); }
  for (const [index, item] of (state.provenance ?? []).entries()) { if (item.workflowId !== state.workflowId || !Object.prototype.hasOwnProperty.call(state.nodes, item.nodeId ?? "") && item.nodeId !== undefined) issues.push(issue(`/provenance/${index}`, "provenance ownership mismatch")); if (item.kind === "telemetry" && !(state.telemetry ?? []).some((telemetry) => telemetry.nodeId === item.nodeId && telemetry.attempt === item.attempt)) issues.push(issue(`/provenance/${index}`, "telemetry provenance is unavailable")); }
  for (const [key, result] of Object.entries(state.results ?? {})) { const checkedResult = validateTaskResult(result); if (!checkedResult.ok) issues.push(...checkedResult.issues.map((entry) => ({ ...entry, path: `/results/${key}${entry.path}` }))); if (key !== result.nodeId || result.workflowId !== state.workflowId || !Object.prototype.hasOwnProperty.call(state.nodes, key)) issues.push(issue(`/results/${key}`, "result ownership mismatch")); if (state.nodes[key] !== result.status) issues.push(issue(`/results/${key}`, "result status does not match node status")); }
  for (const [key, status] of Object.entries(state.nodes)) if (["succeeded", "failed", "blocked", "cancelled"].includes(status) && !state.results?.[key]) issues.push(issue(`/nodes/${key}`, "terminal node is missing its result"));
  for (const [key, list] of Object.entries(state.attempts ?? {})) {
    const seen = new Set<number>();
    for (const [index, item] of list.entries()) { if (key !== item.nodeId || item.workflowId !== state.workflowId || !Object.prototype.hasOwnProperty.call(state.nodes, key)) issues.push(issue(`/attempts/${key}`, "attempt ownership mismatch")); if (seen.has(item.attempt) || item.attempt !== index + 1) issues.push(issue(`/attempts/${key}/${index}/attempt`, "attempts must be unique, sorted, and consecutive from one")); seen.add(item.attempt); }
    if (!validateAttemptHistory(list)) issues.push(issue(`/attempts/${key}`, "illegal attempt transition or terminal history"));
    const result = state.results?.[key]; if (result?.attempt !== undefined && !list.some((item) => item.attempt === result.attempt && item.status === result.status)) issues.push(issue(`/attempts/${key}`, "result attempt status mismatch"));
  }
  for (const [key, list] of Object.entries(state.gates ?? {})) { if (list.length > 64) issues.push(issue(`/gates/${key}`, "too many gate results")); const evaluations = new Set<string>(); for (const item of list) { if (key !== item.nodeId || item.workflowId !== state.workflowId || !Object.prototype.hasOwnProperty.call(state.nodes, key)) issues.push(issue(`/gates/${key}`, "gate ownership mismatch")); if (evaluations.has(item.evaluationId)) issues.push(issue(`/gates/${key}/evaluationId`, "duplicate gate evaluation identity")); evaluations.add(item.evaluationId); const { gateDigest, ...body } = item; if (gateDigest !== sha256(canonical(body))) issues.push(issue(`/gates/${key}/gateDigest`, "gate digest mismatch")); if (!item.sourceNodeId || !Object.prototype.hasOwnProperty.call(state.nodes, item.sourceNodeId)) issues.push(issue(`/gates/${key}/sourceNodeId`, "gate source is absent")); const sourceResult = item.sourceNodeId ? state.results?.[item.sourceNodeId] : undefined; if (item.kind === "result-schema" && (!item.rawEnvelopeDigest || sourceResult?.rawEnvelopeDigest !== item.rawEnvelopeDigest)) issues.push(issue(`/gates/${key}/rawEnvelopeDigest`, "result-schema gate lacks exact raw-envelope binding")); if (item.evidenceDigest) { const evidence = item.sourceNodeId && item.attempt ? state.worktrees?.[`${item.sourceNodeId}:${item.attempt}`] : undefined; if (!evidence || evidence.evidenceDigest !== item.evidenceDigest) issues.push(issue(`/gates/${key}/evidenceDigest`, "gate evidence binding mismatch")); } if (item.rawEnvelopeDigest && sourceResult?.rawEnvelopeDigest !== item.rawEnvelopeDigest) issues.push(issue(`/gates/${key}/rawEnvelopeDigest`, "gate raw-envelope binding mismatch")); } }
  for (const [key, item] of Object.entries(state.worktrees ?? {})) { if (key !== `${item.nodeId}:${item.attempt}` || item.workflowId !== state.workflowId || !Object.prototype.hasOwnProperty.call(state.nodes, item.nodeId)) issues.push(issue(`/worktrees/${key}`, "worktree ownership mismatch")); validateEvidence(item, `/worktrees/${key}`, issues); }
  return issues.length ? { ok: false, issues } : { ok: true, value: state };
}
export function assertValid<T>(result: ValidationResult<T>): T { if (!result.ok) throw new Error(`Invalid workflow data (${result.issues.length} issue(s))`); return result.value; }
