import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { keyHint } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createWorkflowHost, type WorkflowHost, type WorkflowPlan } from "./host.ts";
import type { WorkflowRunTemplate, WorkflowRunStatus } from "./types.ts";
import { formatWorkflowStatus, workflowBorderBottom, workflowBorderLine, workflowBorderTop, workflowElapsed, workflowIsActive, workflowNodeRows, workflowStatusDetails, workflowWidgetRight, WORKFLOW_STATUS_WIDGET_KEY, type WorkflowStatusSnapshot } from "./status.ts";
import type { WorkflowNodeLauncher } from "./executor.ts";
import type { WorkflowModelRegistry } from "./models.ts";
import { sanitizeDisplayText } from "../display-safety.ts";

const MAX_JSON = 64 * 1024;
const templates = Type.Union([Type.Literal("research"), Type.Literal("build"), Type.Literal("review")]);
const safeId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
const planParams = Type.Object({ workflowId: safeId, template: templates, recipeId: Type.Optional(safeId), generated: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false });
const reviseParams = Type.Object({ workflowId: safeId, newWorkflowId: safeId, template: Type.Optional(templates), recipeId: Type.Optional(safeId), generated: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false });
const rerunParams = Type.Object({ workflowId: safeId, newWorkflowId: safeId, confirmMutation: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const idParams = Type.Object({ workflowId: safeId }, { additionalProperties: false });
const historyParams = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })), cursor: Type.Optional(safeId) }, { additionalProperties: false });
const nodeParams = Type.Object({ workflowId: safeId, nodeId: safeId, attempt: Type.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false });
const expansionParams = Type.Object({ workflowId: safeId, newWorkflowId: Type.Optional(safeId), upstreamNodeId: safeId, upstreamPath: Type.String({ minLength: 2, maxLength: 512, pattern: "^\\$" }), recipeId: safeId, idPrefix: Type.Optional(safeId) }, { additionalProperties: false });
const webResearchParams = Type.Object({ workflowId: safeId, requests: Type.Array(Type.Object({ url: Type.String({ minLength: 1, maxLength: 2048 }), purpose: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false });
const applyParams = Type.Object({ workflowId: safeId, nodeId: safeId, token: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false });

type AnyCtx = ExtensionContext & { modelRegistry: WorkflowModelRegistry; cwd: string; sessionManager: any };
type Result = { content: Array<{ type: "text"; text: string }>; details?: Record<string, any> };
const textResult = (text: string, details?: Record<string, any>): Result => ({ content: [{ type: "text", text: text.slice(0, 2000) }], ...(details ? { details } : {}) });
const errorResult = (error: unknown): Result => textResult(`Workflow error: ${sanitizeDisplayText(error instanceof Error ? error.message : "operation failed", 500)}`, { error: true });

function parentOf(ctx: AnyCtx) { return { cwd: ctx.cwd, sessionManager: ctx.sessionManager }; }
export const WORKFLOW_CONFIRMATION_OPERATIONS = Object.freeze(["apply"] as const);
function confirmApply(ctx: AnyCtx, message: string, signal?: AbortSignal): Promise<boolean> { return ctx.ui.confirm("Workflow apply confirmation", message, { signal }); }
function rejectPreAborted(signal?: AbortSignal): Result | undefined { return signal?.aborted ? errorResult(new Error("operation aborted before workflow side effects")) : undefined; }
function boundedFiles(files: readonly string[], total = files.length): string { const shown = files.slice(0, 8).map((file) => sanitizeDisplayText(file, 96)); return shown.join(", ") + (total > shown.length ? ` (+${total - shown.length} more)` : ""); }
async function waitForCancellation(operation: Promise<void>, signal?: AbortSignal): Promise<void> { if (!signal) return operation; if (signal.aborted) return; await Promise.race([operation, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]); }
function parseJsonArgs(args: string): any { const raw = args.trim(); if (!raw || raw.length > MAX_JSON) throw new Error("workflow JSON is empty or oversized"); const value = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow JSON must be an object"); return value; }

const WORKFLOW_INTERVAL_KEY = Symbol.for("pi-subagents/workflow-status-interval");
// Keep widget height bounded even when many detached workflows contain large DAGs.
const WORKFLOW_NODE_ROW_BUDGET = 24;
const WORKFLOW_NODE_ROWS_PER_WORKFLOW = 8;
type WorkflowIntervalOwner = { owner: symbol; timer: ReturnType<typeof setInterval> };
function clearWorkflowInterval(value: WorkflowIntervalOwner | ReturnType<typeof setInterval> | undefined): void { if (!value) return; const timer = typeof value === "object" && "timer" in value ? value.timer : value; clearInterval(timer); if ((globalThis as any)[WORKFLOW_INTERVAL_KEY] === value) (globalThis as any)[WORKFLOW_INTERVAL_KEY] = undefined; }
function visibleLines(lines: string[], width: number): string[] { const limit = Math.max(0, Number.isFinite(width) ? Math.floor(width) : 0); return lines.map((line) => truncateToWidth(line, limit)); }
function preview(text: unknown, width = 110): string { const value = typeof text === "string" ? text : ""; const first = value.split("\n").find((line) => line.trim()) ?? ""; return truncateToWidth(sanitizeDisplayText(first, width * 4), width); }
function operationLabel(name: string): string { return name.replace(/^workflow_/, ""); }
function workflowKeyHint(action: string, fallback: string): string { try { return keyHint(action as any, fallback); } catch { return fallback; } }

export function registerWorkflowUI(pi: ExtensionAPI, options: { owner: symbol; launcher: (parent: any, owner: symbol, signal: AbortSignal) => WorkflowNodeLauncher; moduleSignal: AbortSignal; hostFactory?: typeof createWorkflowHost }): { shutdown(): Promise<void> } {
  const previousInterval = (globalThis as any)[WORKFLOW_INTERVAL_KEY] as WorkflowIntervalOwner | ReturnType<typeof setInterval> | undefined;
  if (previousInterval) clearWorkflowInterval(previousInterval);
  type WorkflowBinding = Readonly<{ generation: number; owner: symbol; sessionId: string; workflowId: string; runId: string; host: WorkflowHost }>;
  type ActiveEntry = Readonly<{ binding: WorkflowBinding; snapshot: WorkflowStatusSnapshot }>;
  // Generation one is the initial registration; session_start advances it.
  let generation = 1;
  let host: WorkflowHost | undefined;
  let lastCtx: AnyCtx | undefined;
  const active = new Map<string, ActiveEntry>();
  let interval: WorkflowIntervalOwner | undefined;
  const bindingKey = (binding: Pick<WorkflowBinding, "sessionId" | "workflowId" | "runId">): string => `${binding.sessionId}:${binding.workflowId}:${binding.runId}`;
  const currentSessionId = (ctx: AnyCtx): string => ctx.sessionManager.getSessionId();
  const isCurrentBinding = (binding: WorkflowBinding): boolean => {
    if (!lastCtx) return false;
    try { return binding.generation === generation && binding.owner === options.owner && currentSessionId(lastCtx) === binding.sessionId && host === binding.host; } catch { return false; }
  };
  const entryMatches = (binding: WorkflowBinding): boolean => active.get(bindingKey(binding))?.binding === binding;
  const getHost = (ctx: AnyCtx) => {
    lastCtx = ctx;
    if (!host) host = (options.hostFactory ?? createWorkflowHost)({ parent: { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, sessionDir: ctx.sessionManager.getSessionDir() }, launcher: options.launcher(parentOf(ctx), options.owner, options.moduleSignal), modelRegistry: ctx.modelRegistry, owner: options.owner });
    return host;
  };
  const sanitizeDetails = (value: unknown): unknown => {
    if (typeof value === "string") return sanitizeDisplayText(value, 2000);
    if (Array.isArray(value)) return value.slice(0, 64).map(sanitizeDetails);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 128).map(([key, item]) => [sanitizeDisplayText(key, 128), sanitizeDetails(item)]));
    return value;
  };
  const sendTerminal = (kind: "workflow_result", details: Record<string, unknown>, text: string) => { try { pi.sendMessage({ customType: kind, content: sanitizeDisplayText(`${text}\nContinue the parent task now: inspect the durable workflow results and perform the next required step.`, 2000), display: true, details: sanitizeDetails(details) as Record<string, unknown> }, { triggerTurn: true, deliverAs: "followUp" }); } catch {} };
  const clearWidget = (ctx: AnyCtx | undefined): void => { if (!ctx?.hasUI || typeof ctx.ui.setWidget !== "function") return; try { ctx.ui.setWidget(WORKFLOW_STATUS_WIDGET_KEY, undefined); } catch {} };
  const stopRefresh = (): void => { if (interval) { clearWorkflowInterval(interval); interval = undefined; } };
  const retireGeneration = (): void => { generation += 1; stopRefresh(); active.clear(); clearWidget(lastCtx); };
  pi.on("session_start", async (_event: any, ctx: AnyCtx) => {
    if (!ctx?.sessionManager || typeof ctx.sessionManager.getSessionId !== "function") return;
    const priorHost = host;
    retireGeneration();
    clearWidget(ctx);
    host = undefined;
    lastCtx = ctx;
    // The host registry is owner-scoped. Await prior shutdown before creating a
    // replacement host so an old shutdown cannot cancel a new session's runs.
    if (priorHost) await priorHost.shutdown().catch(() => {});
    getHost(ctx);
  });

  const renderWidget = (width: number, theme: any): string[] => {
    const accent = (text: string) => theme?.fg ? theme.fg("accent", text) : text;
    const statusColor = (status: string): string => {
      const role = status === "succeeded" || status === "✓" ? "success" : status === "failed" || status === "blocked" || status === "✗" || status === "⊘" ? "error" : status === "running" || status === "retrying" || status === "●" || status === "↻" ? "accent" : "dim";
      return theme?.fg ? theme.fg(role, status) : status;
    };
    const rows = [...active.values()].sort((a, b) => a.snapshot.metadata.workflowId.localeCompare(b.snapshot.metadata.workflowId));
    const lines = [workflowBorderTop("Workflows", `${rows.length} active`, width, accent)];
    const priority: Readonly<Record<string, number>> = { failed: 0, blocked: 1, retrying: 2, running: 3, pending: 4, succeeded: 5, cancelled: 6 };
    const candidates = rows.flatMap((entry) => workflowNodeRows(entry.snapshot, WORKFLOW_NODE_ROWS_PER_WORKFLOW).map((node) => ({ ...node, workflowId: entry.snapshot.metadata.workflowId })));
    const selected = new Set(candidates
      .slice().sort((a, b) => priority[a.status] - priority[b.status] || a.workflowId.localeCompare(b.workflowId) || a.nodeId.localeCompare(b.nodeId))
      .slice(0, WORKFLOW_NODE_ROW_BUDGET));
    const globallyOmitted = Math.max(0, candidates.length - selected.size);
    for (const entry of rows) {
      const snapshot = entry.snapshot;
      const left = ` ${workflowElapsed(snapshot)}  ${snapshot.metadata.workflowId} (${snapshot.metadata.template}) `;
      // Keep every workflow summary visible, then show only bounded,
      // actionable, display-safe node identity/state rows. Never render node
      // output, prompts, paths, or credentials in this detached widget.
      lines.push(workflowBorderLine(left, ` ${workflowWidgetRight(snapshot)} `, width, accent));
      const nodeCount = Object.keys(snapshot.nodes ?? {}).length;
      const perWorkflowLimit = Math.min(WORKFLOW_NODE_ROWS_PER_WORKFLOW, nodeCount);
      const nodeRows = candidates.filter((node) => node.workflowId === snapshot.metadata.workflowId && selected.has(node));
      for (const node of nodeRows) {
        const sanitizedNodeId = sanitizeDisplayText(node.nodeId, 128);
        // Durable schemas constrain IDs, but treat persisted/runtime snapshots
        // defensively too: malformed IDs must not become a data exfiltration
        // channel for paths, prompts, or credential-shaped values.
        const nodeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sanitizedNodeId) ? sanitizedNodeId : "[REDACTED]";
        const nodeLabel = `   ${statusColor(node.status === "succeeded" ? "✓" : node.status === "failed" ? "✗" : node.status === "blocked" ? "⊘" : node.status === "running" ? "●" : node.status === "retrying" ? "↻" : node.status === "cancelled" ? "■" : "○")} ${nodeId}`;
        lines.push(workflowBorderLine(nodeLabel, ` ${statusColor(node.status)} `, width, accent));
      }
      const perWorkflowOmitted = Math.max(0, nodeCount - perWorkflowLimit);
      if (perWorkflowOmitted) lines.push(workflowBorderLine(`   … +${perWorkflowOmitted} node rows`, " omitted ", width, accent));
    }
    if (globallyOmitted) lines.push(workflowBorderLine(`   … +${globallyOmitted} node rows`, " omitted globally ", width, accent));
    lines.push(workflowBorderBottom(width, accent));
    return lines;
  };
  const updateWidget = (ctx: AnyCtx): void => {
    if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
    if (active.size === 0) { ctx.ui.setWidget(WORKFLOW_STATUS_WIDGET_KEY, undefined); return; }
    ctx.ui.setWidget(WORKFLOW_STATUS_WIDGET_KEY, (_tui: any, theme: any) => ({ invalidate() {}, render(width: number) { return renderWidget(width, theme); } }), { placement: "aboveEditor" });
  };
  const forget = (binding: WorkflowBinding, ctx: AnyCtx = lastCtx as AnyCtx): void => {
    if (!isCurrentBinding(binding) || !entryMatches(binding)) return;
    active.delete(bindingKey(binding));
    if (active.size === 0) stopRefresh();
    if (ctx) updateWidget(ctx);
  };
  const remember = (ctx: AnyCtx, snapshot: WorkflowStatusSnapshot): void => {
    const sessionId = currentSessionId(ctx);
    if (snapshot.metadata.sessionId !== sessionId) return;
    const workflowHost = getHost(ctx);
    const candidate: WorkflowBinding = { generation, owner: options.owner, sessionId, workflowId: snapshot.metadata.workflowId, runId: snapshot.metadata.runId, host: workflowHost };
    const key = bindingKey(candidate);
    const binding = active.get(key)?.binding ?? candidate;
    if (workflowIsActive(snapshot)) {
      active.set(key, { binding, snapshot });
      ensureRefresh(ctx);
    } else {
      active.delete(key);
      if (active.size === 0) stopRefresh();
    }
    updateWidget(ctx);
  };
  const refresh = (): void => {
    const ctx = lastCtx;
    if (!ctx || active.size === 0 || generation < 1) return;
    const activeHost = getHost(ctx);
    for (const [key, entry] of [...active.entries()]) {
      const binding = entry.binding;
      if (!isCurrentBinding(binding)) { active.delete(key); continue; }
      try {
        const snapshot = activeHost.statusSnapshot(binding.workflowId);
        if (snapshot.metadata.sessionId !== binding.sessionId || snapshot.metadata.runId !== binding.runId) { active.delete(key); continue; }
        if (workflowIsActive(snapshot)) active.set(key, { binding, snapshot }); else active.delete(key);
      } catch { /* Keep the last bounded row until the detached operation reports completion. */ }
    }
    updateWidget(ctx);
    if (active.size === 0) stopRefresh();
  };
  const ensureRefresh = (ctx: AnyCtx): void => {
    if (active.size === 0 || interval) return;
    const timer = setInterval(refresh, 1000);
    (timer as any).unref?.();
    interval = { owner: options.owner, timer };
    (globalThis as any)[WORKFLOW_INTERVAL_KEY] = interval;
  };

  const start = (ctx: AnyCtx, id: string, resumeRun = false): Result => {
    const activeHost = getHost(ctx);
    const execution = resumeRun ? activeHost.resume(id, true) : activeHost.run(id, true);
    const runningSnapshot = activeHost.statusSnapshot(id);
    const sessionId = currentSessionId(ctx);
    if (runningSnapshot.metadata.sessionId !== sessionId) throw new Error("workflow session ownership mismatch");
    const binding: WorkflowBinding = Object.freeze({ generation, owner: options.owner, sessionId, workflowId: id, runId: runningSnapshot.metadata.runId, host: activeHost });
    active.set(bindingKey(binding), { binding, snapshot: runningSnapshot });
    updateWidget(ctx); ensureRefresh(ctx);
    void execution.then((result) => {
      if (!isCurrentBinding(binding) || !entryMatches(binding)) return;
      let snapshot: WorkflowStatusSnapshot;
      try { snapshot = activeHost.statusSnapshot(id); } catch { snapshot = runningSnapshot; }
      if (snapshot.metadata.sessionId !== binding.sessionId || snapshot.metadata.runId !== binding.runId) return;
      const metadata = { ...snapshot.metadata, status: result.state.status as WorkflowRunStatus };
      const finalSnapshot = { metadata, nodes: result.state.nodes } as WorkflowStatusSnapshot;
      const details = { ...workflowStatusDetails(finalSnapshot), template: metadata.template, elapsed: workflowElapsed(finalSnapshot), ...(result.state.results ? { errors: Object.fromEntries(Object.entries(result.state.results).filter(([, value]: any) => value?.error).map(([nodeId, value]: any) => [nodeId, sanitizeDisplayText(value.error, 500)])) } : {}) };
      forget(binding, ctx);
      if (isCurrentBinding(binding)) sendTerminal("workflow_result", details, sanitizeDisplayText(`Workflow ${id}: ${metadata.status}`));
    }, (error) => {
      if (!isCurrentBinding(binding) || !entryMatches(binding)) return;
      let snapshot: WorkflowStatusSnapshot | undefined;
      try { snapshot = activeHost.statusSnapshot(id); } catch {}
      if (snapshot && (snapshot.metadata.sessionId !== binding.sessionId || snapshot.metadata.runId !== binding.runId)) return;
      const status = snapshot?.metadata.status ?? "failed";
      const safeError = sanitizeDisplayText(error instanceof Error ? error.message : "failed", 500);
      forget(binding, ctx);
      if (isCurrentBinding(binding)) sendTerminal("workflow_result", { workflowId: id, runId: binding.runId, template: snapshot?.metadata.template ?? runningSnapshot.metadata.template, elapsed: snapshot ? workflowElapsed(snapshot) : workflowElapsed(runningSnapshot), status, error: safeError }, sanitizeDisplayText(`Workflow ${id}: ${status} (${safeError})`));
    });
    return textResult(`${resumeRun ? "Resumed" : "Started"} workflow ${id}.`, { workflowId: id, runId: runningSnapshot.metadata.runId, template: runningSnapshot.metadata.template, status: runningSnapshot.metadata.status });
  };
  const revise = (ctx: AnyCtx, p: any): Result => { const value = getHost(ctx).revise({ workflowId: p.workflowId, newWorkflowId: p.newWorkflowId, ...(p.template ? { template: p.template } : {}), ...(p.recipeId ? { recipeId: p.recipeId } : {}), generated: p.generated, confirmMutation: p.template === "build" }); return textResult(`Revised ${p.workflowId} as ${p.newWorkflowId}.`, { workflowId: value.metadata.workflowId, parentWorkflowId: value.metadata.parentWorkflowId, runId: value.metadata.runId, revision: value.metadata.revision, topology: { nodeCount: value.workflow.topology.nodeCount, edgeCount: value.workflow.topology.edgeCount, maxDepth: value.workflow.topology.maxDepth, topologyDigest: value.workflow.topology.topologyDigest } }); };
  const rerun = (ctx: AnyCtx, p: any): Result => { const value = getHost(ctx).rerun({ workflowId: p.workflowId, newWorkflowId: p.newWorkflowId, confirmMutation: p.confirmMutation === true }); return textResult(`Rerun ${p.workflowId} as ${p.newWorkflowId}.`, { workflowId: value.metadata.workflowId, parentWorkflowId: value.metadata.parentWorkflowId, runId: value.metadata.runId, revision: value.metadata.revision, topology: { nodeCount: value.workflow.topology.nodeCount, topologyDigest: value.workflow.topology.topologyDigest } }); };
  const plan = (ctx: AnyCtx, p: any): Result => { const build = p.template === "build"; const value = getHost(ctx).plan({ workflowId: p.workflowId, template: p.template as WorkflowRunTemplate, generated: p.generated, ...(p.recipeId ? { recipeId: p.recipeId } : {}), ...(build ? { confirmMutation: true } : {}) }); return textResult(`Planned ${p.workflowId} (${p.template}), ${value.workflow.nodes.length} nodes.`, { workflowId: p.workflowId, runId: value.metadata.runId, template: p.template, nodeCount: value.workflow.nodes.length, status: value.metadata.status, objective: value.workflow.objective, topology: { nodeCount: value.workflow.topology.nodeCount, edgeCount: value.workflow.topology.edgeCount, maxDepth: value.workflow.topology.maxDepth, topologyDigest: value.workflow.topology.topologyDigest } }); };
  const status = (ctx: AnyCtx, id: string): Result => { const snapshot = getHost(ctx).statusSnapshot(id); remember(ctx, snapshot); return textResult(formatWorkflowStatus(snapshot), { ...workflowStatusDetails(snapshot), template: snapshot.metadata.template, elapsed: workflowElapsed(snapshot) }); };
  const cancel = async (ctx: AnyCtx, id: string, signal?: AbortSignal): Promise<Result> => { const operation = getHost(ctx).cancel(id); await waitForCancellation(operation, signal); if (signal?.aborted) return errorResult(new Error("workflow cancellation wait aborted; cancellation remains active")); const snapshot = getHost(ctx).statusSnapshot(id); remember(ctx, snapshot); return textResult(`Cancelled ${id}.`, { ...workflowStatusDetails(snapshot), template: snapshot.metadata.template, elapsed: workflowElapsed(snapshot) }); };
  const resume = (ctx: AnyCtx, id: string): Result => start(ctx, id, true);
  const approve = (ctx: AnyCtx, p: any): Result => { const previewValue = getHost(ctx).previewApproval(p.workflowId, p.nodeId, p.attempt); const value = getHost(ctx).approve(p.workflowId, p.nodeId, p.attempt, true); return textResult(`Approved ${p.workflowId}/${p.nodeId} attempt ${p.attempt}. Changed: ${boundedFiles(previewValue.changedFiles, previewValue.changedFileCount)}. Apply with workflow_apply using token ${value.token} (evidence ${value.evidenceDigest}).`, { ...value, operation: "approve" }); };
  const apply = async (ctx: AnyCtx, p: any, signal?: AbortSignal): Promise<Result> => { const previewValue = getHost(ctx).previewApply(p.workflowId, p.nodeId, p.token); const accepted = await confirmApply(ctx, `Apply token ${previewValue.token} for ${previewValue.workflowId}/${previewValue.nodeId} attempt ${previewValue.attempt} (evidence ${previewValue.evidenceDigest})?`, signal); if (!accepted || signal?.aborted) return errorResult(new Error("confirmation rejected")); const value = getHost(ctx).apply(p.workflowId, p.nodeId, p.token, true); return textResult(`Applied ${p.workflowId}/${p.nodeId} attempt ${value.attempt}.`, { workflowId: value.workflowId, nodeId: value.nodeId, attempt: value.attempt, applied: true, operation: "apply" }); };

  const resultArgs = (result: any, context: any): any => context?.args ?? result?.args ?? {};
  const resultLabel = (name: string, details: any, result: any, args: any = {}): string => {
    if (details?.error === true || typeof details?.error === "string") return "failed";
    switch (name) {
      case "workflow_plan": return "planned";
      case "workflow_run": return "started";
      case "workflow_status": return `status: ${details?.status ?? args?.status ?? "unknown"}`;
      case "workflow_cancel": return "cancelled";
      case "workflow_resume": return "resumed";
      case "workflow_approve": return "token issued";
      case "workflow_apply": return "applied";
      default: return typeof result?.content?.[0]?.text === "string" ? "completed" : "completed";
    }
  };
  const tool = (name: string, parameters: any, execute: (p: any, ctx: AnyCtx, signal?: AbortSignal) => Promise<Result> | Result) => pi.registerTool(({ name, label: name, description: `Strict workflow operation: ${name}`, parameters, async execute(_id: string, p: any, signal: AbortSignal | undefined, _update: any, ctx: AnyCtx) { try { return await execute(p, ctx, signal); } catch (error) { return errorResult(error); } }, renderCall(args: any, theme: any) {
    const value = args as any ?? {};
    const id = typeof value.workflowId === "string" ? value.workflowId : "(workflow)";
    const op = operationLabel(name);
    let text = `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(id))} ${theme.fg("dim", `— ${op}`)}`;
    if (value.template) text += theme.fg("dim", ` (${value.template})`);
    if (value.nodeId) text += theme.fg("dim", ` / ${value.nodeId}${value.attempt ? ` #${value.attempt}` : ""}`);
    if (name === "workflow_plan") { const objective = preview(value.generated?.objective); if (objective) text += `\n${theme.fg("toolOutput", objective)}`; }
    return new Text(text, 0, 0);
  }, renderResult(result: any, _opts: any, theme: any, context: any) {
    const details = result?.details ?? {};
    const args = resultArgs(result, context);
    const id = typeof details.workflowId === "string" ? details.workflowId : typeof args.workflowId === "string" ? args.workflowId : "workflow";
    const nodeId = typeof details.nodeId === "string" ? details.nodeId : typeof args.nodeId === "string" ? args.nodeId : undefined;
    const template = typeof details.template === "string" ? details.template : typeof args.template === "string" ? args.template : undefined;
    const failed = details.error === true || typeof details.error === "string";
    const icon = theme.fg(failed ? "error" : "success", failed ? "✗" : "✓");
    const suffix = resultLabel(name, details, result, args);
    const info = [template, nodeId ? `${nodeId}${details.attempt ?? args.attempt ? ` #${details.attempt ?? args.attempt}` : ""}` : undefined].filter(Boolean).join(" / ");
    return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(id))}${theme.fg(failed ? "error" : "dim", ` — ${suffix}`)}${info ? theme.fg("dim", ` (${info})`) : ""}`, 0, 0);
  } } as any));
  const history = (ctx: AnyCtx, id: string): Result => { const value = getHost(ctx).history(id); return textResult(`Workflow ${id}: ${value.status}`, { ...value }); };
  const historyList = (ctx: AnyCtx, query: any): Result => { const value = getHost(ctx).historyList(query); return textResult(`Workflow history (${value.entries.length})`, { ...value }); };
  const expand = (ctx: AnyCtx, p: any): Result => { const expanded: { readonly manifest: import("./expansion.ts").ExpansionManifest; readonly plan?: WorkflowPlan } = p.newWorkflowId ? getHost(ctx).expandAndPlan(p.workflowId, p.newWorkflowId, p.upstreamNodeId, p.upstreamPath, p.recipeId, p.idPrefix) : { manifest: getHost(ctx).expand(p.workflowId, p.upstreamNodeId, p.upstreamPath, p.recipeId, p.idPrefix) }; const value = expanded.manifest; return textResult(`Expanded ${p.workflowId} into ${value.items.length} items.`, { workflowId: p.workflowId, manifestId: value.manifestId, manifestDigest: value.manifestDigest, itemCount: value.items.length, totalBytes: value.totalBytes, recipeId: value.recipeId, upstreamNodeId: value.upstreamNodeId, ...(expanded.plan ? { newWorkflowId: expanded.plan.metadata.workflowId, newRunId: expanded.plan.metadata.runId } : {}) }); };
  const research = async (ctx: AnyCtx, p: any): Promise<Result> => { const value = await getHost(ctx).research(p.workflowId, p.requests); return textResult(`Web research fetched ${value.provenance.length} bounded source(s).`, { workflowId: p.workflowId, provenance: value.provenance.map((item) => ({ provider: item.provider, domain: item.domain, status: item.status, bytes: item.bytes, contentDigest: item.contentDigest, provenanceDigest: item.provenanceDigest })) }); };
  tool("workflow_plan", planParams, (p, c, signal) => rejectPreAborted(signal) ?? plan(c, p)); tool("workflow_web_research", webResearchParams, (p, c, signal) => rejectPreAborted(signal) ?? research(c, p)); tool("workflow_rerun", rerunParams, (p, c, signal) => rejectPreAborted(signal) ?? rerun(c, p)); tool("workflow_expand", expansionParams, (p, c, signal) => rejectPreAborted(signal) ?? expand(c, p)); tool("workflow_revise", reviseParams, (p, c, signal) => rejectPreAborted(signal) ?? revise(c, p)); tool("workflow_run", idParams, (p, c, signal) => rejectPreAborted(signal) ?? start(c, p.workflowId)); tool("workflow_status", idParams, (p, c) => status(c, p.workflowId)); tool("workflow_history", historyParams, (p, c) => historyList(c, p)); tool("workflow_detail", idParams, (p, c) => history(c, p.workflowId)); tool("workflow_cancel", idParams, (p, c, signal) => cancel(c, p.workflowId, signal)); tool("workflow_resume", idParams, (p, c, signal) => rejectPreAborted(signal) ?? resume(c, p.workflowId)); tool("workflow_approve", nodeParams, (p, c, signal) => rejectPreAborted(signal) ?? approve(c, p)); tool("workflow_apply", applyParams, (p, c, signal) => apply(c, p, signal));

  const notifyResult = (ctx: any, result: Result): void => { ctx.ui.notify(sanitizeDisplayText(result.content?.[0]?.text ?? "Workflow operation completed", 2000), result.details?.error ? "error" : "info"); };
  pi.registerCommand("workflow-plan", { description: "Plan workflow from strict JSON", handler: async (args, ctx) => { try { notifyResult(ctx, await plan(ctx as AnyCtx, parseJsonArgs(args))); } catch (e) { ctx.ui.notify(sanitizeDisplayText(e, 500), "error"); } } });
  pi.registerCommand("workflow-revise", { description: "Create an immutable revised workflow from strict JSON", handler: async (args, ctx) => { try { notifyResult(ctx, await revise(ctx as AnyCtx, parseJsonArgs(args))); } catch (e) { ctx.ui.notify(sanitizeDisplayText(e, 500), "error"); } } });
  pi.registerCommand("workflow-rerun", { description: "Create a fresh immutable rerun workflow from strict JSON", handler: async (args, ctx) => { try { notifyResult(ctx, await rerun(ctx as AnyCtx, parseJsonArgs(args))); } catch (e) { ctx.ui.notify(sanitizeDisplayText(e, 500), "error"); } } });
  const command = (name: string, fn: (ctx: AnyCtx, value: any) => Promise<Result> | Result, plainId = false) => pi.registerCommand(name, { description: `Workflow ${name}`, handler: async (args, ctx) => { try { const raw = args.trim(); const value = plainId && raw.length <= 128 && !raw.startsWith("{") ? { workflowId: raw } : parseJsonArgs(raw); notifyResult(ctx, await fn(ctx as AnyCtx, value)); } catch (e) { ctx.ui.notify(sanitizeDisplayText(e, 500), "error"); } } });
  command("workflow-run", (c, p) => start(c, p.workflowId), true); command("workflow-status", (c, p) => status(c, p.workflowId), true); command("workflow-history", (c, p) => historyList(c, p), false); command("workflow-detail", (c, p) => history(c, p.workflowId), true); command("workflow-cancel", (c, p) => cancel(c, p.workflowId), true); command("workflow-resume", (c, p) => resume(c, p.workflowId), true); command("workflow-approve", approve); command("workflow-apply", apply);

  const boxRenderer = (message: any, options: any, theme: any, statusBox = false) => ({ invalidate() {}, render(width: number): string[] {
    const details = message.details ?? {};
    const failed = details.status === "failed" || details.status === "cancelled" || details.error === true || !!details.error;
    const id = sanitizeDisplayText(details.workflowId ?? "workflow", 128);
    const icon = statusBox ? theme.fg("accent", "•") : theme.fg(failed ? "error" : "success", failed ? "✗" : "✓");
    const status = sanitizeDisplayText(details.status ?? "status", 64);
    const template = details.template ? theme.fg("dim", ` (${sanitizeDisplayText(details.template, 32)})`) : "";
    const elapsed = details.elapsed ? theme.fg("dim", ` (${sanitizeDisplayText(details.elapsed, 32)})`) : "";
    const counts = details.nodeCounts ?? {};
    const activeCount = (counts.running ?? 0) + (counts.retrying ?? 0);
    const retrying = counts.retrying ?? 0;
    const aggregate = counts.total != null ? `${counts.succeeded ?? 0}/${counts.total} nodes${activeCount ? ` · ${activeCount} active` : ""}${retrying ? ` · ${retrying} retrying` : ""}${counts.failed || counts.blocked ? ` · ${(counts.failed ?? 0) + (counts.blocked ?? 0)} failed` : ""}` : "";
    const lines = [`${icon} ${theme.fg("toolTitle", theme.bold(String(id)))} ${theme.fg("dim", `— ${status}`)}${template}${elapsed}`];
    if (aggregate) lines.push(theme.fg("dim", aggregate));
    const errors = details.errors && typeof details.errors === "object" ? Object.entries(details.errors).map(([node, error]) => `${sanitizeDisplayText(node, 128)}: ${sanitizeDisplayText(error, 300)}`) : [];
    const topLevelError = typeof details.error === "string" ? sanitizeDisplayText(details.error, 500) : details.error === true ? sanitizeDisplayText(typeof message.content === "string" ? message.content : "workflow operation failed", 500) : "";
    const failureDetails = [...(topLevelError ? [topLevelError] : []), ...errors];
    if (options.expanded) {
      if (failureDetails.length) { lines.push(""); lines.push(...failureDetails.map((line) => theme.fg("error", truncateToWidth(line, Math.max(1, width - 6))))); }
      const breakdown = ["pending", "running", "retrying", "succeeded", "failed", "blocked", "cancelled"].filter((name) => counts[name]).map((name) => `${name} ${counts[name]}`).join(", ");
      lines.push(""); lines.push(theme.fg("dim", `run ${sanitizeDisplayText(details.runId ?? "?", 128)}`));
      if (breakdown) lines.push(theme.fg("dim", `nodes: ${breakdown}`));
    } else {
      if (failureDetails.length) lines.push(theme.fg("error", truncateToWidth(failureDetails[0], Math.max(1, width - 6))));
      lines.push(theme.fg("muted", workflowKeyHint("app.tools.expand", "to expand")));
    }
    const box = new Box(1, 1, (text: string) => theme.bg(statusBox ? "customMessageBg" : failed ? "toolErrorBg" : "toolSuccessBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return ["", ...visibleLines(box.render(Math.max(0, width)), width)];
  } });
  pi.registerMessageRenderer("workflow_result", (message: any, options: any, theme: any) => boxRenderer(message, options, theme, false) as any);
  pi.registerMessageRenderer("workflow_status", (message: any, options: any, theme: any) => boxRenderer(message, options, theme, true) as any);

  return { async shutdown() {
    // Invalidate bindings before awaiting host shutdown: late detached completions
    // must not deliver into a newer transcript generation.
    generation += 1;
    stopRefresh();
    active.clear();
    const oldHost = host;
    host = undefined;
    clearWidget(lastCtx);
    if (oldHost) await oldHost.shutdown().catch(() => {});
  } };
}
