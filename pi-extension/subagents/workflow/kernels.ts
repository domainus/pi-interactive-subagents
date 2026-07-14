import { KERNEL_POLICIES, getKernelPolicy, type KernelPolicy } from "./capabilities.ts";
import { THINKING_LEVELS, WORKFLOW_MODELS, type KernelName, type ModelRequest, type ModelSelection, type ThinkingLevel, type WorkflowModel, type WorkflowPolicy } from "./types.ts";

export { KERNEL_POLICIES, getKernelPolicy } from "./capabilities.ts";
export type { KernelPolicy } from "./capabilities.ts";
export const ALLOWED_WORKFLOW_MODELS: readonly WorkflowModel[] = Object.freeze([...WORKFLOW_MODELS]);
export function isAllowedWorkflowModel(model: unknown): model is WorkflowModel { return typeof model === "string" && (WORKFLOW_MODELS as readonly string[]).includes(model); }
export function assertAllowedWorkflowModel(model: unknown): WorkflowModel { if (!isAllowedWorkflowModel(model)) throw new Error("Unsupported workflow model"); return model; }
export interface RequestedTierRisk { readonly tier: "luna" | "sol"; readonly risk?: "low" | "medium" | "high" | "critical"; }
function thinkingForRisk(risk: ModelRequest["risk"]): ThinkingLevel { return risk === "low" || risk === undefined ? "low" : risk === "medium" ? "medium" : "high"; }
function modelForTier(tier: "luna" | "sol"): WorkflowModel { return tier === "sol" ? "openai-codex/gpt-5.6-sol" : "openai-codex/gpt-5.6-luna"; }
export interface CombinedModelPolicyInput { readonly node?: ModelRequest; readonly workflow?: WorkflowPolicy; }
/** Resolve node and workflow policy centrally; no registry or generated text participates. */
export function resolveCombinedModelPolicy(input: CombinedModelPolicyInput = {}): ModelSelection {
  const node = input.node; const workflow = input.workflow;
  if (node && node.tier !== "luna" && node.tier !== "sol") throw new Error("Unsupported workflow model tier");
  if (node?.risk !== undefined && !["low", "medium", "high", "critical"].includes(node.risk)) throw new Error("Unsupported workflow risk tier");
  if (workflow?.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(workflow.thinking)) throw new Error("Unsupported workflow thinking level");
  const nodeModel = node ? modelForTier(node.tier) : undefined;
  if (workflow?.model !== undefined && !isAllowedWorkflowModel(workflow.model)) throw new Error("Unsupported workflow model");
  if (nodeModel && workflow?.model && nodeModel !== workflow.model) throw new Error("Workflow model contradicts node tier");
  const model = workflow?.model ?? nodeModel ?? "openai-codex/gpt-5.6-luna";
  assertAllowedWorkflowModel(model);
  const requestedThinking = workflow?.thinking ?? thinkingForRisk(node?.risk);
  // Managed workflows are bounded automation: neither model may auto-escalate
  // beyond high. Exceptional Luna xhigh/max remains a manual raw-subagent path.
  const thinking = requestedThinking === "xhigh" || requestedThinking === "max" ? "high" : requestedThinking;
  return { model, thinking };
}
export function resolveWorkflowModel(request: RequestedTierRisk | ModelRequest): ModelSelection { return resolveCombinedModelPolicy({ node: request }); }
export const resolveModelPolicy = resolveCombinedModelPolicy;
export const resolveModelForRequest = resolveWorkflowModel;
export const IMMUTABLE_KERNELS: Readonly<Record<KernelName, KernelPolicy>> = Object.freeze({ ...KERNEL_POLICIES });
export const KERNELS = IMMUTABLE_KERNELS;
export const KERNEL_DEFINITIONS = IMMUTABLE_KERNELS;
export function validateKernel(kernel: unknown): kernel is KernelName { return typeof kernel === "string" && Object.prototype.hasOwnProperty.call(IMMUTABLE_KERNELS, kernel); }
