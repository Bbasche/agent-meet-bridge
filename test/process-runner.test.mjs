import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/harnesses/process-runner.mjs";

test("failed harness output stays out of surfaced error messages", async () => {
  const secretShapedOutput = "private-meeting-context-123";
  let failure;
  try {
    await runProcess({
      command: process.execPath,
      args: ["-e", `process.stderr.write(${JSON.stringify(secretShapedOutput)}); process.exit(2)`],
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.match(failure.message, /failed \(exit 2\)/);
  assert.doesNotMatch(failure.message, new RegExp(secretShapedOutput));
  assert.equal(failure.result.stderr, secretShapedOutput);
});
