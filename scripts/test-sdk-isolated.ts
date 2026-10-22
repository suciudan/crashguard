import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type ManagedProcess = {
  child: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function start(
  args: string[],
  env: NodeJS.ProcessEnv,
  output: (chunk: Buffer) => void,
): ManagedProcess {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", output);
  child.stderr!.on("data", output);
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", (error) => {
      output(Buffer.from(`${error.message}\n`));
      resolve({ code: 1, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}

async function stop(process: ManagedProcess | undefined) {
  if (
    !process ||
    process.child.exitCode !== null ||
    process.child.signalCode !== null ||
    !process.child.pid
  )
    return;
  process.child.kill("SIGTERM");
  const stopped = await Promise.race([
    process.done.then(() => true),
    delay(5000, false, { ref: false }),
  ]);
  if (!stopped) {
    process.child.kill("SIGKILL");
    await process.done;
  }
}

async function availablePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function ready(
  base: string,
  server: ManagedProcess,
  signal: AbortSignal,
) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error("SDK test server exited before becoming ready");
    }
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {
      // Connection failures are expected until Next has started listening.
    }
    await delay(250, undefined, { signal });
  }
  throw new Error("SDK test server did not become healthy within 30 seconds");
}

async function main() {
  assert.ok(
    existsSync(".next/BUILD_ID"),
    "Run npm run build before the isolated SDK test",
  );
  mkdirSync("test-results", { recursive: true });
  const temp = mkdtempSync(resolve("test-results/sdk-"));
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error(`SDK test interrupted by ${signal}`));
  };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  const timeout = setTimeout(
    () => controller.abort(new Error("SDK test exceeded 90 seconds")),
    90000,
  );
  let server: ManagedProcess | undefined;
  let smoke: ManagedProcess | undefined;
  let serverLog = "";
  try {
    const port = await availablePort();
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      APP_URL: base,
      AUTH_ORIGIN: base,
      DATABASE_PATH: join(temp, "test.sqlite"),
      TEST_BASE_URL: base,
      TEST_DATABASE_PATH: join(temp, "test.sqlite"),
    };
    server = start(
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      env,
      (chunk) => {
        serverLog = (serverLog + chunk).slice(-16000);
      },
    );
    await ready(base, server, controller.signal);
    controller.signal.throwIfAborted();
    smoke = start(["--import", "tsx", "scripts/test-sdk.ts"], env, (chunk) =>
      process.stdout.write(chunk),
    );
    const result = await Promise.race([
      smoke.done,
      server.done.then(() => {
        throw new Error(
          "SDK test server exited while the SDK test was running",
        );
      }),
      once(controller.signal, "abort").then(() => {
        throw controller.signal.reason;
      }),
    ]);
    assert.equal(
      result.code,
      0,
      `SDK smoke failed (exit ${result.code}, signal ${result.signal})`,
    );
  } catch (error) {
    if (serverLog) console.error("SDK test server output:\n" + serverLog);
    throw error;
  } finally {
    clearTimeout(timeout);
    await stop(smoke);
    await stop(server);
    rmSync(temp, { recursive: true, force: true });
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode ||= 1;
});
