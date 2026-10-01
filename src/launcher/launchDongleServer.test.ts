import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectOrLaunch,
  launchDongleServer,
  resolveBinaryName,
} from "./launchDongleServer.ts";
import { startMockServer } from "../test-support/mockServer.ts";

test("resolveBinaryName maps the supported bench platforms", () => {
  assert.equal(resolveBinaryName("win32", "x64"), "variable_dongle_server.exe");
  assert.equal(resolveBinaryName("darwin", "arm64"), "variable_dongle_server");
  assert.equal(resolveBinaryName("darwin", "x64"), "variable_dongle_server_x86");
  assert.throws(() => resolveBinaryName("linux", "x64"), /Unsupported platform/);
});

test("connectOrLaunch attaches to a listening server without spawning", async () => {
  const server = await startMockServer(() => [
    { event: "GetDongle", payload: { status: "connected" } },
  ]);

  const result = await connectOrLaunch({
    clientOptions: { port: server.port },
    launch: { binaryPath: "/nonexistent/variable_dongle_server" },
  });

  assert.equal(result.server, null, "attached, so nothing was spawned");
  assert.equal(result.client.isConnected(), true);
  result.client.close();
  await server.close();
});

test("launchDongleServer reports a missing binary instead of throwing", async () => {
  const logs: string[] = [];
  const handle = launchDongleServer({
    binaryPath: "/nonexistent/variable_dongle_server",
    onLog: (line) => logs.push(line),
    restartOnCrash: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(handle.isRunning(), false);
  assert.ok(
    logs.some((line) => line.includes("ENOENT")),
    `expected an ENOENT log, got ${JSON.stringify(logs)}`,
  );
  handle.kill();
});

test("connectOrLaunch rejects with a readable message when nothing answers", async () => {
  await assert.rejects(
    () =>
      connectOrLaunch({
        clientOptions: { port: 1 },
        launch: {
          binaryPath: "/nonexistent/variable_dongle_server",
          restartOnCrash: false,
        },
        connectRetries: 2,
        connectRetryDelayMs: 10,
      }),
    /could not reach the dongle server at 127\.0\.0\.1:1 after 2 attempts/,
  );
});

test("a spawned echo binary is killed by the handle", async () => {
  const handle = launchDongleServer({
    binaryPath: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    restartOnCrash: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(handle.isRunning(), true);

  handle.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(handle.isRunning(), false);
});
