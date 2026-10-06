import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

test("local preview serves the app but blocks secrets, git files and sibling traversal", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
      child.on("error", reject);
      child.on("exit", code => reject(new Error(`Preview exited before readiness: ${code}`)));
    });
    assert.equal((await fetch(origin)).status, 200);
    for (const path of ["/.dev.vars", "/.env", "/.git/config", "/%2egit/config", "/%2e%2e%2fposter-template-service-other/secrets.txt"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 403, path);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
