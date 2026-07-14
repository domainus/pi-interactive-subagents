import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("README makes dynamic workflow identity and compatibility contract discoverable", () => {
  const readme = read("README.md");
  for (const term of ["workflow_plan", "workflow_run", "workflow_status", "workflow_cancel", "workflow_resume", "workflow_approve", "workflow_apply", "research", "build", "review", "PI_WORKFLOW_WORKTREE_ROOT", "PI_WORKFLOW_APPROVAL_SECRET", "generated data", "translator → translator-reviewer → editor", "translator-reviewer is read-only", "subagent_interrupt", "subagents_list", "subagent_resume", "/plan", "/iterate", "/subagent"]) assert.match(readme, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), term);
  assert.match(readme, /no automatic apply/i);
  assert.match(readme, /does not claim real-model end-to-end coverage/i);
});

test("package and settings use canonical domainus metadata", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.repository.url, "https://github.com/domainus/pi-interactive-subagents");
  assert.equal(pkg.author, "HazAT"); assert.equal(pkg.license, "MIT"); assert.match(read("LICENSE"), /Copyright \(c\) 2026 HazAT/);
  assert.match(pkg.description, /policy-constrained dynamic DAG/i);
  assert.match(read(".pi/settings.json"), /git:github\.com\/domainus\/pi-interactive-subagents/);
  assert.match(read(".pi/skills/release/SKILL.md"), /github\.com\/domainus\/pi-interactive-subagents/);
  assert.match(read(".pi/skills/release/SKILL.md"), /Never stage, regenerate, or modify `package-lock\.json`/);
  for (const file of ["package.json", ".pi/settings.json", ".pi/skills/release/SKILL.md", "pi-extension/subagents/index.ts", "pi-extension/subagents/cmux.ts"]) assert.doesNotMatch(read(file), /github\.com\/HazAT\/pi-interactive-subagents/i, file);
});

test("active bundled agent defaults do not use Terra", () => {
  for (const file of readdirSync(join(root, "agents")).filter((name) => name.endsWith(".md"))) assert.doesNotMatch(read(join("agents", file)), /model:\s*.*terra/i, file);
});
