import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { composeTaskPrompt } from "./prompt.ts";
import { workflowArtifactRoot } from "./storage.ts";
import { cleanupWorkflowPolicySecret, writeWorkflowPolicyTransport, type WorkflowPolicyTransport } from "./child-policy.ts";
import { parseAgentResultEnvelope, WorkflowLaunchError, type WorkflowNodeLaunch, type WorkflowNodeLaunchContext, type WorkflowNodeLauncher } from "./executor.ts";

export interface WorkflowAdapterParentContext {
  readonly cwd: string;
  readonly sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
}
export interface WorkflowAdapterRunning {
  readonly id: string;
  readonly sessionFile: string;
  readonly surface: string;
  readonly name: string;
  readonly task: string;
  readonly startTime: number;
  abortController?: AbortController;
  workflowOwned?: boolean;
}
export interface WorkflowAdapterWatchResult {
  readonly kind: "delivered" | "suppressed";
  readonly result?: { readonly summary: string; readonly exitCode: number; readonly elapsed: number; readonly error?: string; readonly errorMessage?: string; readonly usageLimit?: { readonly message?: string; readonly resetAt?: number; readonly retryAfterMs?: number }; readonly providerRequestId?: string; readonly sessionFile?: string };
}
export interface WorkflowAdapterLaunchOptions {
  readonly agentDefs: null;
  readonly effectiveThinking: string;
  readonly modelResolution: null;
  readonly resolvedModel: string;
  readonly effectiveTools: string;
  readonly systemPrompt: string;
  readonly autoExit: true;
  readonly workflowOwned: true;
  readonly upstreamResults?: Readonly<Record<string, unknown>>;
  readonly policyTransport: WorkflowPolicyTransport & { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly cwd: string; readonly worktreeRoot?: string; readonly allowedTools: readonly string[]; readonly workflowIntegrity: string; readonly topologyDigest: string };
  readonly sessionMode: "lineage-only" | "fork";
}
export interface WorkflowAdapterRuntime {
  readonly parent: WorkflowAdapterParentContext;
  readonly owner: symbol;
  readonly moduleSignal: AbortSignal;
  readonly launch: (params: { name: string; task: string; cwd: string }, parent: WorkflowAdapterParentContext, owner: symbol, options: WorkflowAdapterLaunchOptions) => Promise<WorkflowAdapterRunning>;
  readonly watch: (running: WorkflowAdapterRunning, signal: AbortSignal, moduleSignal: AbortSignal) => Promise<WorkflowAdapterWatchResult>;
}

function providerFailure(message: string): WorkflowLaunchError {
  return new WorkflowLaunchError(`workflow child provider failure: ${message}`, "retryable");
}

/**
 * Adapt the existing mux launch/watcher lifecycle to the workflow executor.
 * This module deliberately owns no panes, timers, or terminal records itself.
 */
export function createWorkflowNodeAdapter(runtime: WorkflowAdapterRuntime): WorkflowNodeLauncher {
  return {
    launch(context: WorkflowNodeLaunchContext): WorkflowNodeLaunch {
      const parent = runtime.parent;
      const sessionFile = parent.sessionManager.getSessionFile();
      if (!sessionFile) throw new WorkflowLaunchError("workflow parent has no session file", "permanent");
      const selection = context.resolvedModel;
      const allowedTools = [...context.policyArtifact.allowedTools].sort();
      const root = workflowArtifactRoot(parent.sessionManager.getSessionDir(), parent.sessionManager.getSessionId(), context.workflow.id);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      let transport: WorkflowPolicyTransport;
      try {
        transport = writeWorkflowPolicyTransport({
          root,
          artifact: context.policyArtifact,
          secret: context.policySecret,
          identity: {
            workflowId: context.workflow.id,
            nodeId: context.node.id,
            attempt: context.attempt,
            workflowIntegrity: context.workflow.integrity,
            topologyDigest: context.workflow.topology.topologyDigest,
            cwd: context.cwd,
            ...(context.policyArtifact.worktreeRoot ? { worktreeRoot: context.policyArtifact.worktreeRoot } : {}),
            allowedTools,
          },
          id: `${context.node.id}-${context.attempt}`,
        });
      } finally { context.policySecret.fill(0); }
      const task = "Execute the workflow task and return only the required AgentResultEnvelope JSON.";
      let running: Promise<WorkflowAdapterRunning>;
      try {
        const systemPrompt = composeTaskPrompt({
          workflow: context.workflow,
          node: context.node,
          nativeTools: allowedTools,
          approvedCapabilities: context.workflow.capabilities ?? context.node.capabilities,
          upstreamResults: context.upstreamResults,
        });
        running = runtime.launch(
        { name: `workflow-${context.node.id}`, task, cwd: context.cwd },
        parent,
        runtime.owner,
        {
          agentDefs: null,
          effectiveThinking: selection.thinking,
          modelResolution: null,
          resolvedModel: selection.model,
          effectiveTools: allowedTools.join(","),
          systemPrompt,
          autoExit: true,
          workflowOwned: true,
          sessionMode: "lineage-only",
          policyTransport: { ...transport, workflowId: context.workflow.id, nodeId: context.node.id, attempt: context.attempt, cwd: context.cwd, ...(context.policyArtifact.worktreeRoot ? { worktreeRoot: context.policyArtifact.worktreeRoot } : {}), allowedTools, workflowIntegrity: context.workflow.integrity, topologyDigest: context.workflow.topology.topologyDigest },
        },
        );
      } catch (error) {
        cleanupWorkflowPolicySecret(transport.secretPath);
        throw error;
      }
      let watcherAbort: AbortController | undefined;
      let watchPromise: Promise<WorkflowAdapterWatchResult> | undefined;
      const startWatch = (): Promise<WorkflowAdapterWatchResult> => {
        if (!watchPromise) {
          watcherAbort = new AbortController();
          watchPromise = running.then((child) => {
            child.abortController = watcherAbort;
            return runtime.watch(child, watcherAbort!.signal, runtime.moduleSignal);
          }).catch((error) => {
            if (error instanceof WorkflowLaunchError) throw error;
            throw new WorkflowLaunchError("workflow child launch failed", "permanent");
          }).finally(() => cleanupWorkflowPolicySecret(transport.secretPath));
        }
        return watchPromise;
      };
      const settled = startWatch().then(() => undefined, () => undefined);
      let providerRequestId: string | undefined;
      const result = startWatch().then((outcome) => {
        if (outcome.kind === "suppressed" || !outcome.result) throw new WorkflowLaunchError("workflow child watcher was suppressed", "permanent");
        const child = outcome.result;
        providerRequestId = child.providerRequestId;
        if (child.error === "cancelled") throw new WorkflowLaunchError("workflow cancelled", "cancelled");
        if (child.usageLimit) throw new WorkflowLaunchError(child.usageLimit.message ?? "provider usage limit reached", "usage-limit", child.usageLimit);
        if (child.errorMessage) {
          if (child.errorMessage === "workflow child policy rejected") throw new WorkflowLaunchError("workflow child policy rejected", "permanent");
          throw providerFailure(child.errorMessage);
        }
        if (child.exitCode !== 0) throw new WorkflowLaunchError(`workflow child exited with code ${child.exitCode}`, "permanent");
        try { return parseAgentResultEnvelope(child.summary); }
        catch { throw new WorkflowLaunchError("malformed workflow agent result envelope", "permanent"); }
      });
      let cancelled = false;
      const cancel = async (_reason?: string): Promise<void> => {
        if (cancelled) return;
        cancelled = true;
        const promise = startWatch();
        watcherAbort?.abort();
        await promise.catch(() => undefined);
      };
      // The executor supplies the signal as part of the context. Aborting the
      // watcher here makes adapter cancellation wait for the existing watcher.
      if (context.signal.aborted) void cancel("workflow cancelled");
      else context.signal.addEventListener("abort", () => { void cancel("workflow cancelled"); }, { once: true });
      return { result, cancel, settled, get providerRequestId() { return providerRequestId; } };
    },
  };
}

export const createWorkflowAdapter = createWorkflowNodeAdapter;
export const createWorkflowLauncher = createWorkflowNodeAdapter;
