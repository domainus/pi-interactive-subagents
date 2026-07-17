import { createHash } from "node:crypto";
import type { WorkflowPauseInfo } from "./types.ts";

export interface UsageLimitSignal { readonly message?: string; readonly resetAt?: number; readonly retryAfterMs?: number; }
/** Extract only an explicitly structured provider quota signal; free-form text is
 * intentionally not enough to pause a workflow. */
export function detectUsageLimit(value: unknown): UsageLimitSignal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const hasNested = item.usageLimit !== undefined;
  if (hasNested && (!item.usageLimit || typeof item.usageLimit !== "object" || Array.isArray(item.usageLimit))) return undefined;
  const nested = hasNested ? item.usageLimit as Record<string, unknown> : item;
  const code = nested.code ?? nested.type ?? nested.reason ?? item.code ?? item.type;
  const status = nested.status ?? item.status;
  const structuredNested = hasNested && (code !== undefined || status !== undefined || nested.message !== undefined || nested.resetAt !== undefined || nested.retryAfterMs !== undefined || nested.reset_at !== undefined || nested.retry_after_ms !== undefined);
  const explicit = code === "usage-limit" || code === "rate_limit_exceeded" || code === "quota_exceeded" || status === 429 || structuredNested;
  if (!explicit) return undefined;
  const resetAt = typeof nested.resetAt === "number" ? nested.resetAt : typeof nested.reset_at === "number" ? nested.reset_at : undefined;
  const retryAfterMs = typeof nested.retryAfterMs === "number" ? nested.retryAfterMs : typeof nested.retry_after_ms === "number" ? nested.retry_after_ms : undefined;
  const message = typeof nested.message === "string" ? nested.message : typeof item.message === "string" ? item.message : undefined;
  return Object.freeze({ ...(message ? { message } : {}), ...(resetAt !== undefined ? { resetAt } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
}
export interface UsagePauseAttempt { readonly attempt: number; readonly pausedAt: number; readonly hint: WorkflowPauseInfo; readonly callbackId: string; readonly resumedAt?: number; }
export interface UsageCoordinator { readonly schedule: (callbackId: string, at: number, callback: () => void) => void; readonly cancel?: (callbackId: string) => void; }
export interface UsagePauseLifecycle { readonly status: "paused" | "resumed"; readonly attempts: readonly UsagePauseAttempt[]; readonly callbackId: string; }

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
};
const digestHint = (hint: Omit<WorkflowPauseInfo, "hintDigest">): string => createHash("sha256").update(canonical(hint)).digest("hex");

export function sanitizeUsageHint(signal: UsageLimitSignal, now = Date.now, callbackId?: string): WorkflowPauseInfo {
  const pausedAt = now();
  const resetAt = signal.resetAt !== undefined && Number.isSafeInteger(signal.resetAt) && signal.resetAt >= pausedAt ? signal.resetAt : undefined;
  const retryAfterMs = signal.retryAfterMs !== undefined && Number.isSafeInteger(signal.retryAfterMs) && signal.retryAfterMs > 0 && signal.retryAfterMs <= 86_400_000 ? signal.retryAfterMs : undefined;
  const message = typeof signal.message === "string" ? signal.message.replace(/[\r\n\t]/g, " ").slice(0, 256) : "Provider usage limit reached";
  const body = { reason: "usage-limit" as const, message: message || "Provider usage limit reached", ...(resetAt !== undefined ? { resetAt } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(callbackId ? { callbackId } : {}), pausedAt };
  return Object.freeze({ ...body, hintDigest: digestHint(body) });
}

export function pauseForUsage(previous: UsagePauseLifecycle | undefined, signal: UsageLimitSignal, coordinator: UsageCoordinator | undefined, resume: (callbackId: string) => void, now = Date.now): UsagePauseLifecycle {
  const attempt = (previous?.attempts.length ?? 0) + 1;
  if (attempt > 8) throw new Error("usage-limit pause attempts exceeded");
  const pausedAt = now();
  const callbackId = `usage-${pausedAt}-${attempt}`;
  const hint = sanitizeUsageHint(signal, () => pausedAt, callbackId);
  const at = hint.resetAt ?? hint.pausedAt + (hint.retryAfterMs ?? 60_000);
  const attempts = [...(previous?.attempts ?? []), Object.freeze({ attempt, pausedAt: hint.pausedAt, hint, callbackId })];
  if (coordinator) coordinator.schedule(callbackId, at, () => resume(callbackId));
  return Object.freeze({ status: "paused", attempts: Object.freeze(attempts), callbackId });
}

export function acceptUsageResume(lifecycle: UsagePauseLifecycle, callbackId: string, resume: () => void): UsagePauseLifecycle {
  if (lifecycle.status !== "paused" || callbackId !== lifecycle.callbackId) return lifecycle;
  const attempts = lifecycle.attempts.map((item) => item.callbackId === callbackId ? Object.freeze({ ...item, resumedAt: Date.now() }) : item);
  resume();
  return Object.freeze({ status: "resumed", attempts: Object.freeze(attempts), callbackId });
}
