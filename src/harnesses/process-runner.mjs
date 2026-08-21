import { spawn, spawnSync } from "node:child_process";

export function commandExists(command) {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [command], { stdio: "ignore" }).status === 0;
}

export async function runProcess({
  command,
  args = [],
  cwd,
  env = process.env,
  input,
  timeoutMs = 15 * 60_000,
  maxOutputBytes = 8 * 1024 * 1024,
  onSpawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    onSpawn?.(child);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const failForSize = () => {
      child.kill("SIGTERM");
      finish(reject, new Error(`${command} exceeded the ${maxOutputBytes}-byte output limit`));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) return failForSize();
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) return failForSize();
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) finish(resolve, result);
      else {
        // Harness output can contain meeting context, repository content, or
        // provider diagnostics. Keep it attached for adapter parsing without
        // copying it into logs, spoken errors, or the public meeting timeline.
        const outcome = signal ? `signal ${signal}` : `exit ${code}`;
        finish(reject, Object.assign(new Error(`${command} failed (${outcome})`), { result }));
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
