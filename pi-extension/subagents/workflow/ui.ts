import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createWorkflowHost, type WorkflowHost } from "./host.ts";
import type { WorkflowRunTemplate } from "./types.ts";
import { formatWorkflowStatus, workflowStatusDetails, WORKFLOW_STATUS_WIDGET_KEY, type WorkflowStatusSnapshot } from "./status.ts";
import type { WorkflowNodeLauncher } from "./executor.ts";
import type { WorkflowModelRegistry } from "./models.ts";

const MAX_JSON = 64 * 1024;
const templates = Type.Union([Type.Literal("research"), Type.Literal("build"), Type.Literal("review")]);
const safeId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
const planParams = Type.Object({ workflowId: safeId, template: templates, generated: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false });
const idParams = Type.Object({ workflowId: safeId }, { additionalProperties: false });
const nodeParams = Type.Object({ workflowId: safeId, nodeId: safeId, attempt: Type.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false });
const applyParams = Type.Object({ workflowId: safeId, nodeId: safeId, token: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false });

type AnyCtx = ExtensionContext & { modelRegistry: WorkflowModelRegistry; cwd: string; sessionManager: any };
type Result = { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };
const textResult = (text: string, details?: Record<string, unknown>): Result => ({ content: [{ type: "text", text: text.slice(0, 2000) }], ...(details ? { details } : {}) });
const errorResult = (error: unknown): Result => textResult(`Workflow error: ${error instanceof Error ? error.message.slice(0, 500) : "operation failed"}`, { error: true });

function parentOf(ctx: AnyCtx) { return { cwd: ctx.cwd, sessionManager: ctx.sessionManager }; }
export const WORKFLOW_CONFIRMATION_OPERATIONS = Object.freeze(["apply"] as const);
function confirmApply(ctx: AnyCtx, message: string, signal?: AbortSignal): Promise<boolean> { return ctx.ui.confirm("Workflow apply confirmation", message, { signal }); }
function rejectPreAborted(signal?: AbortSignal): Result | undefined { return signal?.aborted ? errorResult(new Error("operation aborted before workflow side effects")) : undefined; }
function boundedFiles(files: readonly string[], total = files.length): string { const shown = files.slice(0, 8).map((file) => file.slice(0, 96)); return shown.join(", ") + (total > shown.length ? ` (+${total - shown.length} more)` : ""); }
async function waitForCancellation(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return operation;
  if (signal.aborted) return;
  await Promise.race([operation, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
}
function parseJsonArgs(args: string): any {
  const raw = args.trim();
  if (!raw || raw.length > MAX_JSON) throw new Error("workflow JSON is empty or oversized");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow JSON must be an object");
  return value;
}

export function registerWorkflowUI(pi: ExtensionAPI, options: { owner: symbol; launcher: (parent: any, owner: symbol, signal: AbortSignal) => WorkflowNodeLauncher; moduleSignal: AbortSignal; hostFactory?: typeof createWorkflowHost }): { shutdown(): Promise<void> } {
  let host: WorkflowHost | undefined;
  let lastCtx: AnyCtx | undefined;
  const getHost = (ctx: AnyCtx) => {
    lastCtx = ctx;
    if (!host) host = (options.hostFactory ?? createWorkflowHost)({ parent: { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, sessionDir: ctx.sessionManager.getSessionDir() }, launcher: options.launcher(parentOf(ctx), options.owner, options.moduleSignal), modelRegistry: ctx.modelRegistry, owner: options.owner });
    return host;
  };
  pi.on("session_start", (_event: any, ctx: AnyCtx) => { if (!ctx?.sessionManager || typeof ctx.sessionManager.getSessionId !== "function") return; host = undefined; getHost(ctx); });
  const sendTerminal = (kind: "workflow_result", details: Record<string, unknown>, text: string) => {
    try { pi.sendMessage({ customType: kind, content: text.slice(0, 2000), display: true, details }, { triggerTurn: false }); } catch {}
  };
  const setWidget = (ctx: AnyCtx, snapshot: WorkflowStatusSnapshot | undefined) => {
    if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
    if (!snapshot) { ctx.ui.setWidget(WORKFLOW_STATUS_WIDGET_KEY, undefined); return; }
    ctx.ui.setWidget(WORKFLOW_STATUS_WIDGET_KEY, (_tui: any, _theme: any) => ({ invalidate() {}, render(width: number) { return [formatWorkflowStatus(snapshot, width)]; } }), { placement: "aboveEditor" });
  };
  const start = (ctx: AnyCtx, id: string, resumeRun = false): Result => {
    // The global workflow UI is the trusted standing authorization boundary for
    // plan/run/resume/approval. The host still requires explicit booleans from
    // direct callers; only final apply remains interactively confirmed here.
    const activeHost = getHost(ctx); const execution = resumeRun ? activeHost.resume(id, true) : activeHost.run(id, true); const runningSnapshot = activeHost.statusSnapshot(id); setWidget(ctx, runningSnapshot);
    void execution.then((result) => { const snapshot = activeHost.statusSnapshot(id); setWidget(ctx, snapshot); sendTerminal("workflow_result", { workflowId: id, runId: snapshot.metadata.runId, status: result.state.status }, `Workflow ${id}: ${result.state.status}`); }, (error) => { let status = "failed"; let runId: string | undefined; try { const snapshot = activeHost.statusSnapshot(id); status = snapshot.metadata.status; runId = snapshot.metadata.runId; setWidget(ctx, snapshot); } catch {} sendTerminal("workflow_result", { workflowId: id, ...(runId ? { runId } : {}), status }, `Workflow ${id}: ${status} (${error instanceof Error ? error.message.slice(0, 200) : "failed"})`); });
    return textResult(`${resumeRun ? "Resumed" : "Started"} workflow ${id}.`, { workflowId: id, runId: runningSnapshot.metadata.runId, status: runningSnapshot.metadata.status });
  };
  const plan = (ctx: AnyCtx, p: any): Result => {
    const build = p.template === "build";
    const value = getHost(ctx).plan({ workflowId: p.workflowId, template: p.template as WorkflowRunTemplate, generated: p.generated, ...(build ? { confirmMutation: true } : {}) });
    setWidget(ctx, { metadata: value.metadata }); return textResult(`Planned ${p.workflowId} (${p.template}), ${value.workflow.nodes.length} nodes.`, { workflowId: p.workflowId, runId: value.metadata.runId, template: p.template, nodeCount: value.workflow.nodes.length, status: value.metadata.status });
  };
  const status = (ctx: AnyCtx, id: string): Result => { const snapshot = getHost(ctx).statusSnapshot(id); setWidget(ctx, snapshot); const details = workflowStatusDetails(snapshot); return textResult(formatWorkflowStatus(snapshot), details); };
  const cancel = async (ctx: AnyCtx, id: string, signal?: AbortSignal): Promise<Result> => { const operation = getHost(ctx).cancel(id); await waitForCancellation(operation, signal); if (signal?.aborted) return errorResult(new Error("workflow cancellation wait aborted; cancellation remains active")); const snapshot = getHost(ctx).statusSnapshot(id); setWidget(ctx, snapshot); return textResult(`Cancelled ${id}.`, { workflowId: id, runId: snapshot.metadata.runId, status: snapshot.metadata.status }); };
  const resume = (ctx: AnyCtx, id: string): Result => start(ctx, id, true);
  const approve = (ctx: AnyCtx, p: any): Result => { const preview = getHost(ctx).previewApproval(p.workflowId, p.nodeId, p.attempt); const value = getHost(ctx).approve(p.workflowId, p.nodeId, p.attempt, true); return textResult(`Approved ${p.workflowId}/${p.nodeId} attempt ${p.attempt}. Changed: ${boundedFiles(preview.changedFiles, preview.changedFileCount)}. Apply with workflow_apply using token ${value.token} (evidence ${value.evidenceDigest}).`, { ...value }); };
  const apply = async (ctx: AnyCtx, p: any, signal?: AbortSignal): Promise<Result> => { const preview = getHost(ctx).previewApply(p.workflowId, p.nodeId, p.token); const accepted = await confirmApply(ctx, `Apply token ${preview.token} for ${preview.workflowId}/${preview.nodeId} attempt ${preview.attempt} (evidence ${preview.evidenceDigest})?`, signal); if (!accepted || signal?.aborted) return errorResult(new Error("confirmation rejected")); const value = getHost(ctx).apply(p.workflowId, p.nodeId, p.token, true); return textResult(`Applied ${p.workflowId}/${p.nodeId} attempt ${value.attempt}.`, { workflowId: value.workflowId, nodeId: value.nodeId, attempt: value.attempt, applied: true }); };
  const tool = (name: string, parameters: any, execute: (p: any, ctx: AnyCtx, signal?: AbortSignal) => Promise<Result> | Result) => pi.registerTool({ name, label: name, description: `Strict workflow operation: ${name}`, parameters, async execute(_id: string, p: any, signal: AbortSignal | undefined, _update: any, ctx: AnyCtx) { try { return await execute(p, ctx, signal); } catch (error) { return errorResult(error); } }, renderCall(args: any, theme: any) { return new Text(theme.fg("toolTitle", `▸ ${name} ${truncateToWidth(JSON.stringify(args ?? {}), 120)}`), 0, 0); }, renderResult(result: any, _opts: any, theme: any) { return new Text(theme.fg(result.details?.error ? "error" : "dim", truncateToWidth(result.content?.[0]?.text ?? "Workflow operation", 180)), 0, 0); } });
  tool("workflow_plan", planParams, (p, c, signal) => rejectPreAborted(signal) ?? plan(c, p)); tool("workflow_run", idParams, (p, c, signal) => rejectPreAborted(signal) ?? start(c, p.workflowId)); tool("workflow_status", idParams, (p, c) => status(c, p.workflowId)); tool("workflow_cancel", idParams, (p, c, signal) => cancel(c, p.workflowId, signal)); tool("workflow_resume", idParams, (p, c, signal) => rejectPreAborted(signal) ?? resume(c, p.workflowId)); tool("workflow_approve", nodeParams, (p, c, signal) => rejectPreAborted(signal) ?? approve(c, p)); tool("workflow_apply", applyParams, (p, c, signal) => apply(c, p, signal));
  const notifyResult = (ctx: any, result: Result): void => { ctx.ui.notify(result.content?.[0]?.text ?? "Workflow operation completed", result.details?.error ? "error" : "info"); };
  pi.registerCommand("workflow-plan", { description: "Plan workflow from strict JSON", handler: async (args, ctx) => { try { notifyResult(ctx, await plan(ctx as AnyCtx, parseJsonArgs(args))); } catch (e) { ctx.ui.notify(String(e), "error"); } } });
  const command = (name: string, fn: (ctx: AnyCtx, value: any) => Promise<Result> | Result, plainId = false) => pi.registerCommand(name, { description: `Workflow ${name}`, handler: async (args, ctx) => { try { const raw = args.trim(); const value = plainId && raw.length <= 128 && !raw.startsWith("{") ? { workflowId: raw } : parseJsonArgs(raw); notifyResult(ctx, await fn(ctx as AnyCtx, value)); } catch (e) { ctx.ui.notify(String(e), "error"); } } });
  command("workflow-run", (c, p) => start(c, p.workflowId), true); command("workflow-status", (c, p) => status(c, p.workflowId), true); command("workflow-cancel", (c, p) => cancel(c, p.workflowId), true); command("workflow-resume", (c, p) => resume(c, p.workflowId), true); command("workflow-approve", approve); command("workflow-apply", apply);
  const messageRenderer = (message: any, theme: any, color: string) => ({ render(width: number) { return [truncateToWidth(theme.fg(color, typeof message.content === "string" ? message.content : "Workflow"), Math.max(1, width))]; } });
  // Only completion is sent as a transcript message; retain the renderer for
  // legacy transcript records without producing new status messages.
  pi.registerMessageRenderer("workflow_result", (message: any, _options: any, theme: any) => messageRenderer(message, theme, "accent"));
  pi.registerMessageRenderer("workflow_status", (message: any, _options: any, theme: any) => messageRenderer(message, theme, "dim"));
  return { async shutdown() { if (host) { await host.shutdown(); host = undefined; } if (lastCtx) setWidget(lastCtx, undefined); } };
}
