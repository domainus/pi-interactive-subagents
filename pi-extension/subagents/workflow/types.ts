/** Versioned, data-only contracts for dynamic workflows. */
export const WORKFLOW_VERSION = 1 as const;
export const WORKFLOW_MODELS = Object.freeze(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"] as const);
export type WorkflowModel = (typeof WORKFLOW_MODELS)[number];
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type KernelName = "readonly" | "builder" | "validator" | "adjudicator" | "interactive";
export type NodeStatus = "pending" | "running" | "retrying" | "succeeded" | "failed" | "blocked" | "cancelled";
export type WorkflowStatus = "pending" | "running" | "paused" | "retrying" | "gated" | "completed" | "succeeded" | "failed" | "cancelled" | "recovered";
/** Durable run lifecycle. This deliberately does not include adapter-specific states. */
export type WorkflowRunStatus = "pending" | "running" | "cancelling" | "paused" | "cancelled" | "completed" | "failed" | "recovered";
export type WorkflowPauseReason = "usage-limit" | "provider-unavailable" | "manual";
export interface WorkflowPauseInfo { readonly reason: WorkflowPauseReason; readonly message: string; readonly resetAt?: number; readonly retryAfterMs?: number; readonly callbackId?: string; readonly hintDigest: string; readonly pausedAt: number; }
export interface WorkflowTopologySummary { readonly nodeCount: number; readonly edgeCount: number; readonly maxDepth: number; readonly order: readonly string[]; readonly nodeDigests: Readonly<Record<string, string>>; readonly topologyDigest: string; }
export type WorkflowRunTemplate = "research" | "build" | "review";
export type GateKind = "result-schema" | "dependency-success" | "diff-scope" | "command";
export type NodeMode = "read-only" | "mutating";

export interface ModelRequest { readonly tier: "luna" | "sol"; readonly risk?: "low" | "medium" | "high" | "critical"; }
export interface ModelSelection { readonly model: WorkflowModel; readonly thinking: ThinkingLevel; }
export interface WorkflowPolicy { readonly model?: WorkflowModel; readonly thinking?: ThinkingLevel; readonly maxOutputBytes?: number; }
export interface WorkflowBounds { readonly maxNodes?: number; readonly maxConcurrency?: number; readonly maxRetries?: number; readonly maxDepth?: number; readonly maxRuntimeMs?: number; }
export interface Gate {
  readonly version: typeof WORKFLOW_VERSION;
  readonly kind: GateKind;
  readonly dependsOn?: readonly string[];
  readonly reason?: string;
  /** Data-only requested argv. Authorization is supplied separately by the trusted host. */
  readonly argv?: readonly string[];
  readonly allowGlobs?: readonly string[];
  readonly denyGlobs?: readonly string[];
}
export interface TaskNode {
  readonly version: typeof WORKFLOW_VERSION;
  readonly id: string;
  readonly kernel: KernelName;
  readonly objective: string;
  readonly expertise: readonly string[];
  readonly capabilities: readonly string[];
  readonly mode: NodeMode;
  readonly requiresWorktree: boolean;
  readonly workspaceRoot?: string;
  readonly allowGlobs?: readonly string[];
  readonly denyGlobs?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly gate?: Gate;
  /** Binds generated validation/gate nodes to the builder workspace and evidence. */
  readonly sourceNodeId?: string;
  readonly input?: unknown;
  readonly model?: ModelRequest;
  readonly retries?: number;
  /** Supplied depth is informational; the compiler always replaces it. */
  readonly depth?: number;
}
export interface WorkflowSpec {
  readonly version: typeof WORKFLOW_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly expertise?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly nodes: readonly TaskNode[];
  readonly bounds?: WorkflowBounds;
  readonly policy?: WorkflowPolicy;
}
/** Host-owned durable identity and lifecycle for one workflow execution. No handles, secrets, or adapter state belong here. */
export interface WorkflowRunMetadata {
  readonly version: typeof WORKFLOW_VERSION;
  readonly runId: string;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly cwd: string;
  /** Required for the mutating build template; read-only templates may omit it. */
  readonly worktreeRoot?: string;
  readonly workflowIntegrity: string;
  readonly template: WorkflowRunTemplate;
  readonly status: WorkflowRunStatus;
  readonly startedAt?: number;
  readonly updatedAt?: number;
  readonly finishedAt?: number;
  readonly topology?: WorkflowTopologySummary;
  readonly pause?: WorkflowPauseInfo;
  readonly revision?: number;
  readonly parentWorkflowId?: string;
  readonly parentRunId?: string;
  readonly parentIntegrity?: string;
  readonly invalidatedNodeIds?: readonly string[];
}
export interface AgentResultEnvelope { readonly version: typeof WORKFLOW_VERSION; readonly status: "succeeded" | "failed" | "blocked"; readonly output?: unknown; readonly error?: string | null; readonly retryable?: boolean; }
export interface HostPolicyArtifact {
  readonly version: typeof WORKFLOW_VERSION;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
  /** Required on executor-created artifacts; binds child policy to the immutable compiled plan. */
  readonly workflowIntegrity?: string;
  readonly topologyDigest?: string;
  readonly kernel: KernelName;
  readonly mode: NodeMode;
  readonly cwd: string;
  readonly worktreeRoot?: string;
  readonly allowGlobs: readonly string[];
  readonly denyGlobs: readonly string[];
  readonly allowedTools: readonly string[];
  readonly allowedArgv: readonly (readonly string[])[];
  /** HMAC-SHA-256 over every other field. The secret is delivered separately. */
  readonly signature: string;
}
export interface NodeAttempt {
  readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly status: NodeStatus;
  readonly startedAt?: number; readonly finishedAt?: number; readonly error?: string; readonly classification?: "retryable" | "permanent" | "cancelled" | "malformed" | "usage-limit" | "imported";
}
export interface GateResult {
  readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly nodeId: string; readonly workflowIntegrity?: string; readonly topologyDigest?: string; readonly kind: GateKind; readonly passed: boolean; readonly checkedAt: number;
  readonly sourceNodeId?: string; readonly attempt?: number; readonly evidenceDigest?: string; readonly rawEnvelopeDigest?: string;
  /** Stable identity of the gate inputs, used for idempotent crash recovery. */
  readonly evaluationId: string; readonly gateDigest: string; readonly error?: string;
}
export interface WorktreeEvidence {
  readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly nodeId: string; readonly workflowIntegrity?: string; readonly topologyDigest?: string; readonly attempt: number; readonly mode: NodeMode; readonly cwd: string; readonly path?: string;
  readonly base: string; readonly head: string; readonly diffHash: string; readonly changedFiles: readonly string[]; readonly evidenceDigest: string;
  readonly capturedAt: number; readonly preserved: boolean;
}
/** Full diff/status live only in their bounded sidecar artifact, never workflow state. */
export interface WorktreeMetadata extends WorktreeEvidence { readonly status: string; readonly diff: string; }
export type ApprovalState = "approved" | "applying" | "applied" | "consumed";
/** Durable, evidence-bound apply transaction journal record. */
export interface ApplyApprovalRecord {
  readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly nonce: string; readonly token: string;
  readonly state: ApprovalState; readonly evidenceDigest: string; readonly patchDigest: string; readonly parentBase: string; readonly gateResultDigests: readonly string[];
  readonly approvedAt: number; readonly updatedAt: number; readonly allowGlobs: readonly string[]; readonly denyGlobs: readonly string[];
  /** Host-owned MAC over the complete journal identity; never supplied by task data. */
  readonly signature: string;
}
export interface TaskResult {
  readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly nodeId: string; readonly workflowIntegrity?: string; readonly topologyDigest?: string; readonly status: Exclude<NodeStatus, "pending" | "running" | "retrying">;
  readonly output?: unknown; readonly error?: string; readonly startedAt?: number; readonly finishedAt: number; readonly attempt?: number;
  /** The exact parsed host-boundary envelope, never reconstructed from TaskResult. */
  readonly rawEnvelope?: AgentResultEnvelope; readonly rawEnvelopeDigest?: string;
}
export interface WorkflowState {
  readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly sessionId: string; readonly runId?: string; readonly status: WorkflowStatus; readonly nodes: Readonly<Record<string, NodeStatus>>;
  readonly results?: Readonly<Record<string, TaskResult>>; readonly attempts?: Readonly<Record<string, readonly NodeAttempt[]>>; readonly gates?: Readonly<Record<string, readonly GateResult[]>>;
  /** Keyed by `${nodeId}:${attempt}`; full diffs remain in bounded sidecars. */
  readonly worktrees?: Readonly<Record<string, WorktreeEvidence>>; readonly pause?: WorkflowPauseInfo;
  readonly telemetry?: readonly WorkflowTelemetryRecord[];
  readonly provenance?: readonly WorkflowArtifactProvenance[];
  readonly updatedAt: number;
}
export interface WorkflowTelemetryRecord { readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly runId: string; readonly workflowIntegrity: string; readonly topologyDigest: string; readonly nodeId: string; readonly attempt: number; readonly model: WorkflowModel; readonly requestId: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number; readonly runtimeMs: number; readonly capturedAt: number; readonly providerSignature: string; readonly recordDigest: string; }
export interface WorkflowArtifactProvenance { readonly version: typeof WORKFLOW_VERSION; readonly workflowId: string; readonly runId: string; readonly workflowIntegrity: string; readonly topologyDigest: string; readonly kind: "result" | "gate" | "worktree" | "telemetry" | "manifest"; readonly nodeId?: string; readonly attempt?: number; readonly artifactId: string; readonly artifactDigest: string; readonly capturedAt: number; readonly importedFromWorkflowId?: string; readonly importedFromRunId?: string; readonly importedFromArtifactDigest?: string; }
export type ValidationIssue = { readonly path: string; readonly message: string };
export type ValidationResult<T> = { readonly ok: true; readonly value: T; readonly issues?: readonly ValidationIssue[] } | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
