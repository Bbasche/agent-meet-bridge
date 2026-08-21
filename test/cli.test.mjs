import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/cli.mjs");

for (const flag of ["--no-announce", "--no-open-sidecar"]) {
  test(`CLI accepts ${flag}`, () => {
    const result = spawnSync(process.execPath, [cli, "help", flag], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Agent Meet Bridge/);
  });
}
