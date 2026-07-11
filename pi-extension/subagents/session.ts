import { appendFileSync, closeSync, copyFileSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export const MAX_DELIVERED_RESULT_BYTES = 64 * 1024;

/** Byte offset that can be saved before a resume and used as an exact JSONL boundary. */
export function getSessionBoundary(sessionFile: string): number {
  const fd = openSync(sessionFile, "r");
  try { return fstatSync(fd).size; } finally { closeSync(fd); }
}

/**
 * Find the last assistant message after a byte boundary by scanning backwards.
 * Only one bounded chunk and one JSONL record are materialized at a time.
 */
export function findLastAssistantMessageInSession(
  sessionFile: string,
  afterByte = 0,
): string | null {
  const fd = openSync(sessionFile, "r");
  try {
    const end = fstatSync(fd).size;
    let position = end;
    let suffix = Buffer.alloc(0);
    const chunkSize = 64 * 1024;
    while (position > afterByte) {
      const size = Math.min(chunkSize, position - afterByte);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      readSync(fd, chunk, 0, size, position);
      const combined = Buffer.concat([chunk, suffix]);
      const parts: Buffer[] = [];
      let lineEnd = combined.length;
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] === 10) {
          parts.push(combined.subarray(i + 1, lineEnd));
          lineEnd = i;
        }
      }
      suffix = combined.subarray(0, lineEnd);
      for (const part of parts) {
        const line = part.toString("utf8");
        if (!line.trim()) continue;
        try {
          const result = findLastAssistantMessage([JSON.parse(line) as SessionEntry]);
          if (result !== null) return result;
        } catch { /* preserve malformed-line tolerance while scanning */ }
      }
    }
    if (suffix.length > 0) {
      try { return findLastAssistantMessage([JSON.parse(suffix.toString("utf8")) as SessionEntry]); } catch {}
    }
    return null;
  } finally { closeSync(fd); }
}

export function capDeliveredResult(text: string, sessionFile: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_DELIVERED_RESULT_BYTES) return text;
  const notice = `\n\n[Result truncated from ${bytes} bytes to 64 KiB. Full session: ${sessionFile}]`;
  const budget = MAX_DELIVERED_RESULT_BYTES - Buffer.byteLength(notice, "utf8");
  const source = Buffer.from(text, "utf8");
  let end = Math.max(0, budget);
  let body = "";
  while (end >= 0) {
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, end)); break; }
    catch { end--; }
  }
  return body + notice;
}

export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}
