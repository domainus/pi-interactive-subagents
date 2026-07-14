/** Versioned, data-only contracts for dynamic workflows. */
export const WORKFLOW_VERSION = 1 as const;
export const WORKFLOW_MODELS = Object.freeze(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"] as const);
export type WorkflowModel = (typeof WORKFLOW_MODELS)[number];
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type KernelName = "readonly" | "builder" | "validator" | "adjudicator" | "interactive";
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type WorkflowStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "recovered";
export type GateKind = "all" | "any" | "approval" | "manual";
export type NodeMode = "read-only" | "mutating";

export interface ModelRequest { readonly tier: "luna" | "sol"; readonly risk?: "low" | "medium" | "high" | "critical"; }
export interface ModelSelection { readonly model: WorkflowModel; readonly thinking: ThinkingLevel; }
export interface WorkflowPolicy {
  readonly model?: WorkflowModel;
  readonly thinking?: ThinkingLevel;
  readonly maxOutputBytes?: number;
}
export interface WorkflowBounds {
  readonly maxNodes?: number;
  readonly maxConcurrency?: number;
  readonly maxRetries?: number;
  readonly maxDepth?: number;
  readonly maxRuntimeMs?: number;
}
export interface Gate {
  readonly version: typeof WORKFLOW_VERSION;
  readonly kind: GateKind;
  readonly dependsOn?: readonly string[];
  readonly required?: number;
  readonly reason?: string;
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
  readonly input?: unknown;
  readonly model?: ModelRequest;
  readonly retries?: number;
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
export interface AgentResultEnvelope {
  readonly version: typeof WORKFLOW_VERSION;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly output?: unknown;
  readonly error?: string | null;
}
export interface TaskResult {
  readonly version: typeof WORKFLOW_VERSION;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly status: Exclude<NodeStatus, "pending" | "running">;
  readonly output?: unknown;
  readonly error?: string;
  readonly startedAt?: number;
  readonly finishedAt: number;
}
export interface WorkflowState {
  readonly version: typeof WORKFLOW_VERSION;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly status: WorkflowStatus;
  readonly nodes: Readonly<Record<string, NodeStatus>>;
  readonly results?: Readonly<Record<string, TaskResult>>;
  readonly updatedAt: number;
}
export type ValidationIssue = { readonly path: string; readonly message: string };
export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
