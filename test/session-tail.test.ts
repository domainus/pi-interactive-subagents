import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capDeliveredResult, findLastAssistantMessageInSession, getSessionBoundary, MAX_DELIVERED_RESULT_BYTES } from "../pi-extension/subagents/session.ts";

const message = (role: string, text: string) => JSON.stringify({ type: "message", id: text.slice(0, 8), message: { role, content: [{ type: "text", text }] } });

describe("bounded session result extraction", () => {
  it("finds the final assistant message in a large fork without reading earlier output", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-tail-"));
    try {
      const file = join(dir, "fork.jsonl");
      writeFileSync(file, `${JSON.stringify({ type: "session", id: "s" })}\n${Array.from({length: 20000}, (_, i) => message("user", `old-${i}-${"x".repeat(200)}`)).join("\n")}\n${message("assistant", "final answer")}\n`);
      assert.equal(findLastAssistantMessageInSession(file), "final answer");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("honors an exact resume boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-boundary-"));
    try {
      const file = join(dir, "resume.jsonl");
      writeFileSync(file, message("assistant", "stale") + "\n");
      const boundary = getSessionBoundary(file);
      assert.equal(findLastAssistantMessageInSession(file, boundary), null);
      appendFileSync(file, message("user", "continue") + "\n" + message("assistant", "fresh") + "\n");
      assert.equal(findLastAssistantMessageInSession(file, boundary), "fresh");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("caps delivered UTF-8 results and identifies the full session", () => {
    const result = capDeliveredResult("🙂".repeat(40000), "/tmp/full.jsonl");
    assert.ok(Buffer.byteLength(result, "utf8") <= MAX_DELIVERED_RESULT_BYTES);
    assert.match(result, /Result truncated from .*Full session: \/tmp\/full\.jsonl/);
    assert.ok(!result.includes("�"));
  });
});
