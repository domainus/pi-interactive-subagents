import type { KernelName, NodeMode, ThinkingLevel, WorkflowBounds, WorkflowModel, WorkflowRunTemplate } from "./types.ts";

/** Host policy selected before generated workflow data is interpreted. */
export interface HostWorkflowTemplate {
  readonly template: WorkflowRunTemplate;
  readonly kernel: KernelName;
  readonly mode: NodeMode;
  readonly requiresWorktree: boolean;
  readonly capabilities: readonly string[];
  readonly allowGlobs: readonly string[];
  readonly denyGlobs: readonly string[];
  readonly model: WorkflowModel;
  readonly thinking: ThinkingLevel;
  readonly retries: number;
  readonly bounds: WorkflowBounds;
  readonly allowedTools: readonly string[];
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

const make = (value: Omit<HostWorkflowTemplate, "template"> & { readonly template: WorkflowRunTemplate }): HostWorkflowTemplate => deepFreeze({
  ...value,
  capabilities: [...value.capabilities], allowGlobs: [...value.allowGlobs], denyGlobs: [...value.denyGlobs],
  bounds: { ...value.bounds }, allowedTools: [...value.allowedTools],
});

/** These are host-owned ceilings. No generated node may replace any field. */
export const WORKFLOW_TEMPLATES: Readonly<Record<WorkflowRunTemplate, HostWorkflowTemplate>> = deepFreeze({
  research: make({
    template: "research", kernel: "readonly", mode: "read-only", requiresWorktree: false,
    // Pi 0.65 exposes only these built-in filesystem tools in the trusted child;
    // web adapters are intentionally not part of the research capability.
    capabilities: ["read-files", "search-files"], allowGlobs: ["**"], denyGlobs: [],
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", retries: 1,
    bounds: { maxNodes: 64, maxConcurrency: 4, maxRetries: 1, maxDepth: 16, maxRuntimeMs: 1_800_000 },
    allowedTools: ["read", "grep", "find", "ls"],
  }),
  build: make({
    template: "build", kernel: "builder", mode: "mutating", requiresWorktree: true,
    capabilities: ["read-files", "search-files", "write-files"], allowGlobs: ["**"], denyGlobs: ["package-lock.json", "**/package-lock.json"],
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", retries: 2,
    bounds: { maxNodes: 64, maxConcurrency: 1, maxRetries: 2, maxDepth: 16, maxRuntimeMs: 1_800_000 },
    allowedTools: ["read", "grep", "find", "ls", "edit", "write"],
  }),
  review: make({
    template: "review", kernel: "validator", mode: "read-only", requiresWorktree: false,
    capabilities: ["read-files", "search-files"], allowGlobs: ["**"], denyGlobs: [],
    model: "openai-codex/gpt-5.6-sol", thinking: "high", retries: 1,
    bounds: { maxNodes: 64, maxConcurrency: 2, maxRetries: 1, maxDepth: 16, maxRuntimeMs: 900_000 },
    allowedTools: ["read", "grep", "find", "ls"],
  }),
});

/** Alias with an explicit host-policy name for callers and reviewers. */
export const HOST_WORKFLOW_TEMPLATES = WORKFLOW_TEMPLATES;
export const HOST_TEMPLATES = WORKFLOW_TEMPLATES;
export const WORKFLOW_TEMPLATE_POLICIES = WORKFLOW_TEMPLATES;
export type HostWorkflowPolicy = HostWorkflowTemplate;

const TEMPLATE_NAMES = new Set<WorkflowRunTemplate>(["research", "build", "review"]);
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const policyByTemplate = new Map<WorkflowRunTemplate, HostWorkflowTemplate>(Object.entries(WORKFLOW_TEMPLATES) as [WorkflowRunTemplate, HostWorkflowTemplate][]);

/** Resolve only a host allowlisted template; neither object properties nor generated text are used as policy. */
export function selectHostWorkflowTemplate(template: unknown, generatedNodeId?: unknown): HostWorkflowTemplate {
  if (typeof template !== "string" || !TEMPLATE_NAMES.has(template as WorkflowRunTemplate)) throw new Error("unknown workflow template");
  if (generatedNodeId !== undefined && (typeof generatedNodeId !== "string" || !NODE_ID.test(generatedNodeId))) throw new Error("unsafe generated node ID");
  const selected = policyByTemplate.get(template as WorkflowRunTemplate);
  if (!selected) throw new Error("unknown workflow template");
  return selected;
}

export const getWorkflowTemplate = selectHostWorkflowTemplate;
export const resolveHostWorkflowTemplate = selectHostWorkflowTemplate;
export const hostPolicyForGeneratedNode = selectHostWorkflowTemplate;

/** Return a frozen policy map keyed without a prototype, so IDs such as __proto__ cannot alter lookup. */
export function mapGeneratedNodeIdsToHostPolicy(template: unknown, generatedNodeIds: readonly unknown[]): Readonly<Record<string, HostWorkflowTemplate>> {
  const policy = selectHostWorkflowTemplate(template);
  const result: Record<string, HostWorkflowTemplate> = Object.create(null) as Record<string, HostWorkflowTemplate>;
  for (const nodeId of generatedNodeIds) {
    if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) throw new Error("unsafe generated node ID");
    result[nodeId] = policy;
  }
  return deepFreeze(result);
}
