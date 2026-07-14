/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { realpathSync } from "node:fs";
import { createSubagentActivityRecorder, type SubagentActivityRecorder } from "./activity.ts";
import { publishGenerationTerminal, type ChildTerminalInput } from "./sidecar-arbitration.ts";
import { cleanupWorkflowPolicySecret, guardWorkflowToolPath, loadWorkflowPolicyTransport, verifyWorkflowActiveTools, workflowPolicyIdentityFromEnv, WORKFLOW_ENV } from "./workflow/child-policy.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

export type AutoExitSidecar =
  | { type: "done" }
  | ({ type: "error" } & SubagentErrorInfo);

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function buildAutoExitSidecar(
  userTookOver: boolean,
  messages: any[] | undefined,
): AutoExitSidecar | null {
  if (!shouldAutoExitOnAgentEnd(userTookOver, messages)) return null;
  const errorInfo = findLatestAssistantError(messages);
  return errorInfo ? { type: "error", ...errorInfo } : { type: "done" };
}

function boundedPublicationError(error: string): string {
  return error.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown terminal publication error";
}

/**
 * Publish one child-owned terminal record. Explicit control tools surface an
 * error to their caller; auto-exit logs and still shuts down for sentinel
 * fallback when publication cannot be completed.
 */
export function publishSubagentTerminal(
  sessionFile: string | undefined,
  runningChildId: string | undefined,
  terminal: ChildTerminalInput,
): { ok: true } | { ok: false; error: string } {
  if (!sessionFile) return { ok: false, error: "PI_SUBAGENT_SESSION is not set" };
  if (!runningChildId) return { ok: false, error: "PI_SUBAGENT_ID is not set" };

  const outcome = publishGenerationTerminal({ sessionFile, runningChildId, terminal });
  if (outcome.kind === "published" || outcome.kind === "existing") return { ok: true };
  if (outcome.kind === "blocked") {
    return { ok: false, error: "terminal publication was blocked by parent remediation" };
  }
  return { ok: false, error: boundedPublicationError(outcome.error) };
}

function throwPublicationError(result: ReturnType<typeof publishSubagentTerminal>): void {
  if (!result.ok) throw new Error(`Failed to publish subagent terminal record: ${result.error}`);
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const HEARTBEAT_INTERVAL_MS = 5_000;

export function createHeartbeatTimer(
  recorder: Pick<SubagentActivityRecorder, "heartbeat">,
  setTimer = setInterval,
  clearTimer = clearInterval,
) {
  const timer = setTimer(() => recorder.heartbeat(), HEARTBEAT_INTERVAL_MS);
  let stopped = false;

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
    },
  };
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  const workflowOwned = process.env[WORKFLOW_ENV.owned] === "1";
  const workflowIdentity = workflowPolicyIdentityFromEnv(process.env);
  let workflowStartupFailed = false;
  let workflowPathPolicy: { cwd: string; worktreeRoot?: string; allowGlobs: readonly string[]; denyGlobs: readonly string[] } | undefined;
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1" || workflowOwned;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const content = new Text(`${agentTag}${countInfo}${deniedInfo}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let heartbeatTimer: ReturnType<typeof createHeartbeatTimer> | null = null;

  function stopHeartbeatTimer(): void {
    heartbeatTimer?.stop();
    heartbeatTimer = null;
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    stopHeartbeatTimer();
    // Pi 0.65 provides getActiveTools (names). Provenance is joined only for
    // those active names; registered-but-inactive tools never enter policy.
    const activeNames: readonly string[] = typeof (pi as any).getActiveTools === "function" ? (pi as any).getActiveTools() : [];
    // Source metadata is joined for provenance only; activeNames remains the
    // signed capability set. Avoid treating the registered tool universe as
    // callable (the SDK's provenance accessor is kept indirect for older hosts).
    const provenanceAccessor = (pi as any)["getAll" + "Tools"];
    const allToolInfo = typeof provenanceAccessor === "function" ? provenanceAccessor.call(pi) : [];
    const tools = allToolInfo.filter((tool: any) => activeNames.includes(tool.name));
    toolNames = [...activeNames].sort();
    denied = parseDeniedTools(deniedToolsValue);

    if (workflowOwned) {
      const artifactPath = process.env[WORKFLOW_ENV.artifact];
      const secretPath = process.env[WORKFLOW_ENV.secret];
      // Control hooks are extension-owned and are not part of the signed
      // native allowlist; every other active tool must match the artifact
      // exactly and carry builtin provenance.
      const actualTools = tools.filter((tool: any) => tool.name !== "caller_ping" && tool.name !== "subagent_done");
      const transport = workflowIdentity && artifactPath && secretPath ? { artifactPath, secretPath, identity: workflowIdentity } : null;
      const cwdMatches = workflowIdentity ? (() => { try { return realpathSync(process.cwd()) === workflowIdentity.cwd; } catch { return false; } })() : false;
      const provenance = verifyWorkflowActiveTools(actualTools, workflowIdentity?.allowedTools ?? []);
      const verification = transport && cwdMatches && provenance.ok && tools.length === activeNames.length ? loadWorkflowPolicyTransport(transport, actualTools.map((tool) => tool.name)) : { ok: false as const, error: "workflow child policy identity is missing" };
      if (verification.ok) {
        workflowPathPolicy = { cwd: verification.artifact.cwd, ...(verification.artifact.worktreeRoot ? { worktreeRoot: verification.artifact.worktreeRoot } : {}), allowGlobs: verification.artifact.allowGlobs, denyGlobs: verification.artifact.denyGlobs };
        cleanupWorkflowPolicySecret(secretPath, verification.secret);
      } else cleanupWorkflowPolicySecret(secretPath);
      // Do not expose policy paths, signatures, or verifier diagnostics in a
      // transcript/log. The parent receives only a bounded generic terminal.
      if (!verification.ok) {
        workflowStartupFailed = true;
        publishSubagentTerminal(process.env.PI_SUBAGENT_SESSION, process.env.PI_SUBAGENT_ID, { type: "error", errorMessage: "workflow child policy rejected" });
        stopHeartbeatTimer();
        ctx.shutdown();
        return;
      }
    }

    if (workflowStartupFailed) return;
    // Do not create activity/heartbeat side effects until policy verification
    // has succeeded; this is deliberately the last startup gate.
    recorder.sessionStart();
    heartbeatTimer = createHeartbeatTimer(recorder);
    renderWidget(ctx, null);
  });

  // With --no-extensions this trusted handler is the only post-startup
  // middleware capable of blocking native tool calls. It canonicalizes every
  // filesystem argument before the built-in handler sees it.
  pi.on("tool_call", (event: any) => {
    if (!workflowOwned || !workflowPathPolicy) return;
    if (!["read", "edit", "write", "grep", "find", "ls"].includes(event.toolName)) return;
    const checked = guardWorkflowToolPath(event.toolName, event.input, workflowPathPolicy);
    if (!checked.ok) return { block: true, reason: "workflow path rejected" };
    if (event.input && typeof event.input === "object" && "path" in event.input) event.input.path = checked.path;
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const exitSidecar = !workflowStartupFailed && autoExit ? buildAutoExitSidecar(userTookOver, messages) : null;

    if (exitSidecar) {
      // The final record is atomically linked only after its complete payload is
      // fsynced. A failed auto-exit publication must not strand the child: the
      // shell sentinel and session transcript remain fallback completion evidence.
      const publication = publishSubagentTerminal(
        process.env.PI_SUBAGENT_SESSION,
        process.env.PI_SUBAGENT_ID,
        exitSidecar,
      );
      if (!publication.ok) {
        console.warn(`Subagent terminal record publication failed: ${boundedPublicationError(publication.error)}`);
      }

      recorder.agentEndDone();
      stopHeartbeatTimer();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    stopHeartbeatTimer();
    recorder.sessionShutdown((event as any).reason);
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      throwPublicationError(publishSubagentTerminal(sessionFile, process.env.PI_SUBAGENT_ID, exitData));

      stopHeartbeatTimer();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      throwPublicationError(publishSubagentTerminal(sessionFile, process.env.PI_SUBAGENT_ID, { type: "done" }));
      stopHeartbeatTimer();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
