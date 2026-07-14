import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DEFAULT_CAPABILITY_CATALOG, type CapabilityCatalog } from "./capabilities.ts";
import { resolveCombinedModelPolicy } from "./kernels.ts";
import { WORKFLOW_MODELS, WORKFLOW_VERSION, type AgentResultEnvelope, type Gate, type TaskNode, type TaskResult, type WorkflowSpec, type WorkflowState, type ValidationIssue, type ValidationResult } from "./types.ts";

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
const SafeText = Type.String({ minLength: 1, maxLength: 16_384 });
const ShortText = Type.String({ minLength: 1, maxLength: 512 });
const RelativePath = Type.String({ minLength: 1, maxLength: 1024 });
const RelativeGlob = Type.String({ minLength: 1, maxLength: 512 });
const Kernel = Type.Union([Type.Literal("readonly"), Type.Literal("builder"), Type.Literal("validator"), Type.Literal("adjudicator"), Type.Literal("interactive")]);
const Thinking = Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(Type.Literal));
export const ModelRequestSchema = Type.Object({ tier: Type.Union([Type.Literal("luna"), Type.Literal("sol")]), risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")])) }, { additionalProperties: false });
export const GateSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), kind: Type.Union([Type.Literal("all"), Type.Literal("any"), Type.Literal("approval"), Type.Literal("manual")]), dependsOn: Type.Optional(Type.Array(Id, { maxItems: 256, uniqueItems: true })), required: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })), reason: Type.Optional(Type.String({ maxLength: 1024 })) }, { additionalProperties: false });
export const WorkflowBoundsSchema = Type.Object({ maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })), maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })), maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })), maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })), maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000 })) }, { additionalProperties: false });
export const WorkflowPolicySchema = Type.Object({ model: Type.Optional(Type.Union(WORKFLOW_MODELS.map(Type.Literal))), thinking: Type.Optional(Thinking), maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_048_576 })) }, { additionalProperties: false });
export const TaskNodeSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), id: Id, kernel: Kernel, objective: SafeText, expertise: Type.Array(ShortText, { maxItems: 32 }), capabilities: Type.Array(ShortText, { maxItems: 64 }), mode: Type.Union([Type.Literal("read-only"), Type.Literal("mutating")]), requiresWorktree: Type.Boolean(), workspaceRoot: Type.Optional(RelativePath), allowGlobs: Type.Optional(Type.Array(RelativeGlob, { maxItems: 128, uniqueItems: true })), denyGlobs: Type.Optional(Type.Array(RelativeGlob, { maxItems: 128, uniqueItems: true })), dependsOn: Type.Optional(Type.Array(Id, { maxItems: 256, uniqueItems: true })), gate: Type.Optional(GateSchema), input: Type.Optional(Type.Unknown()), model: Type.Optional(ModelRequestSchema), retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }, { additionalProperties: false });
export const WorkflowSpecSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), id: Id, sessionId: Id, objective: SafeText, expertise: Type.Optional(Type.Array(ShortText, { maxItems: 32 })), capabilities: Type.Optional(Type.Array(ShortText, { maxItems: 64, uniqueItems: true })), nodes: Type.Array(TaskNodeSchema, { minItems: 1, maxItems: 256 }), bounds: Type.Optional(WorkflowBoundsSchema), policy: Type.Optional(WorkflowPolicySchema) }, { additionalProperties: false });
export const AgentResultEnvelopeSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("blocked")]), output: Type.Optional(Type.Unknown()), error: Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()])) }, { additionalProperties: false });
export const TaskResultSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, nodeId: Id, status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("cancelled")]), output: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), startedAt: Type.Optional(Type.Integer({ minimum: 0 })), finishedAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const WorkflowStateSchema = Type.Object({ version: Type.Literal(WORKFLOW_VERSION), workflowId: Id, sessionId: Id, status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("recovered")]), nodes: Type.Record(Id, Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("cancelled")])), results: Type.Optional(Type.Record(Id, TaskResultSchema)), updatedAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const schemas = { WorkflowSpecSchema, TaskNodeSchema, GateSchema, AgentResultEnvelopeSchema, TaskResultSchema, WorkflowStateSchema, ModelRequestSchema, WorkflowBoundsSchema, WorkflowPolicySchema } as const;

function schemaIssues(schema: TSchema, value: unknown): ValidationIssue[] {
  if (Value.Check(schema, value)) return [];
  return [...Value.Errors(schema, value)].slice(0, 64).map((e) => ({ path: e.path || "$", message: e.message }));
}
const issue = (path: string, message: string): ValidationIssue => ({ path, message });
const unsafeRelativePath = (value: string): boolean => value.includes("\0") || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).some((part) => part === "..");
const hasDuplicate = (items: readonly string[] | undefined): boolean => Boolean(items && new Set(items).size !== items.length);

export function validateTaskNode(value: unknown, catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): ValidationResult<TaskNode> {
  const issues = schemaIssues(TaskNodeSchema, value);
  if (issues.length) return { ok: false, issues };
  const node = value as TaskNode;
  if (node.mode === "mutating" && node.kernel !== "builder") issues.push(issue("/mode", "only the builder kernel may mutate"));
  if (node.mode === "mutating" && !node.requiresWorktree) issues.push(issue("/requiresWorktree", "mutating builder nodes require a worktree"));
  if (node.workspaceRoot && unsafeRelativePath(node.workspaceRoot)) issues.push(issue("/workspaceRoot", "unsafe ownership path"));
  for (const [field, values] of [["allowGlobs", node.allowGlobs], ["denyGlobs", node.denyGlobs]] as const) if (values?.some(unsafeRelativePath)) issues.push(issue(`/${field}`, "unsafe relative ownership glob"));
  if (hasDuplicate(node.dependsOn)) issues.push(issue("/dependsOn", "duplicate dependency IDs"));
  if (node.gate && hasDuplicate(node.gate.dependsOn)) issues.push(issue("/gate/dependsOn", "duplicate gate dependency IDs"));
  if (node.gate && node.gate.required !== undefined && node.gate.required > (node.gate.dependsOn?.length ?? 0)) issues.push(issue("/gate/required", "gate required count exceeds dependency count"));
  if (catalog) for (const capability of node.capabilities) if (!Object.prototype.hasOwnProperty.call(catalog, capability)) issues.push(issue("/capabilities", "unknown capability"));
  return issues.length ? { ok: false, issues } : { ok: true, value: node };
}

function hasCycle(nodes: readonly TaskNode[]): boolean {
  const graph = new Map(nodes.map((node) => [node.id, [...(node.dependsOn ?? []), ...(node.gate?.dependsOn ?? [])]]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const dep of graph.get(id) ?? []) if (visit(dep)) return true; visiting.delete(id); visited.add(id); return false; };
  return nodes.some((node) => visit(node.id));
}

export function validateWorkflowSpec(value: unknown, catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): ValidationResult<WorkflowSpec> {
  const issues = schemaIssues(WorkflowSpecSchema, value);
  if (issues.length) return { ok: false, issues };
  const spec = value as WorkflowSpec;
  const ids = new Set<string>(); const maxNodes = spec.bounds?.maxNodes ?? 256;
  if (spec.nodes.length > maxNodes) issues.push(issue("/nodes", "node count exceeds configured bound"));
  if (spec.capabilities) for (const capability of spec.capabilities) if (!Object.prototype.hasOwnProperty.call(catalog, capability)) issues.push(issue("/capabilities", "unknown capability"));
  for (let i = 0; i < spec.nodes.length; i++) {
    const node = spec.nodes[i];
    if (ids.has(node.id)) issues.push(issue(`/nodes/${i}/id`, "duplicate node ID"));
    ids.add(node.id);
    const checked = validateTaskNode(node, catalog); if (!checked.ok) issues.push(...checked.issues.map((x) => ({ ...x, path: `/nodes/${i}${x.path}` })));
    for (const dependency of [...(node.dependsOn ?? []), ...(node.gate?.dependsOn ?? [])]) if (!spec.nodes.some((candidate) => candidate.id === dependency)) issues.push(issue(`/nodes/${i}/dependsOn`, "unknown dependency ID"));
    if ((node.depth ?? 1) > (spec.bounds?.maxDepth ?? 32)) issues.push(issue(`/nodes/${i}/depth`, "depth exceeds bound"));
    if ((node.retries ?? 0) > (spec.bounds?.maxRetries ?? 10)) issues.push(issue(`/nodes/${i}/retries`, "retries exceed bound"));
  }
  if (hasCycle(spec.nodes)) issues.push(issue("/nodes", "workflow dependency cycle detected"));
  for (const [i, node] of spec.nodes.entries()) try { resolveCombinedModelPolicy({ node: node.model, workflow: spec.policy }); } catch { issues.push(issue(`/nodes/${i}/model`, "contradictory or unsupported model policy")); }
  return issues.length ? { ok: false, issues: issues.slice(0, 96) } : { ok: true, value: spec };
}

export function validateAgentResultEnvelope(value: unknown): ValidationResult<AgentResultEnvelope> {
  const issues = schemaIssues(AgentResultEnvelopeSchema, value); if (issues.length) return { ok: false, issues };
  const envelope = value as AgentResultEnvelope;
  if (envelope.status === "failed" && !envelope.error) issues.push(issue("/error", "failed envelope requires an error"));
  if (envelope.status === "succeeded" && envelope.error !== undefined && envelope.error !== null) issues.push(issue("/error", "successful envelope cannot contain an error"));
  return issues.length ? { ok: false, issues } : { ok: true, value: envelope };
}
export function validateTaskResult(value: unknown): ValidationResult<TaskResult> {
  const issues = schemaIssues(TaskResultSchema, value); if (issues.length) return { ok: false, issues };
  const result = value as TaskResult;
  if (result.startedAt !== undefined && result.startedAt > result.finishedAt) issues.push(issue("/startedAt", "start timestamp is after finish timestamp"));
  if (result.status === "failed" && !result.error) issues.push(issue("/error", "failed result requires an error"));
  if (result.status === "succeeded" && result.error !== undefined) issues.push(issue("/error", "successful result cannot contain an error"));
  return issues.length ? { ok: false, issues } : { ok: true, value: result };
}
export function validateWorkflowState(value: unknown, ownership?: { workflowId?: string; sessionId?: string }): ValidationResult<WorkflowState> {
  const issues = schemaIssues(WorkflowStateSchema, value); if (issues.length) return { ok: false, issues };
  const state = value as WorkflowState;
  if (ownership?.workflowId && state.workflowId !== ownership.workflowId) issues.push(issue("/workflowId", "artifact ownership mismatch"));
  if (ownership?.sessionId && state.sessionId !== ownership.sessionId) issues.push(issue("/sessionId", "artifact ownership mismatch"));
  if (state.results) for (const [key, result] of Object.entries(state.results)) { if (key !== result.nodeId) issues.push(issue(`/results/${key}`, "result key does not match node ID")); if (result.workflowId !== state.workflowId) issues.push(issue(`/results/${key}/workflowId`, "result ownership mismatch")); if (!Object.prototype.hasOwnProperty.call(state.nodes, key)) issues.push(issue(`/results/${key}`, "result node is absent from state")); }
  return issues.length ? { ok: false, issues } : { ok: true, value: state };
}
export function assertValid<T>(result: ValidationResult<T>): T { if (!result.ok) throw new Error(`Invalid workflow data (${result.issues.length} issue(s))`); return result.value; }
