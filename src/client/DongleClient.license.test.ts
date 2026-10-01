import { test } from "node:test";
import assert from "node:assert/strict";
import { DongleClient, DongleCommandError } from "./DongleClient.ts";
import { startMockServer } from "../test-support/mockServer.ts";

test("installLicense sends CopyLicense with file and overwrite", async () => {
  const server = await startMockServer((command) =>
    command.command === "CopyLicense"
      ? [
          {
            event: "CopyLicense",
            payload: {
              serial: "SP3-0001",
              file: "/Volumes/BRIDGE/SP3-0001.kpag",
              device_type: "spectro 3",
            },
          },
        ]
      : [],
  );
  const client = new DongleClient({ port: server.port });
  await client.connect();

  const installed = await client.installLicense("/Volumes/BRIDGE/SP3-0001.kpag");

  assert.deepEqual(server.received[0], {
    command: "CopyLicense",
    parameters: { file: "/Volumes/BRIDGE/SP3-0001.kpag", overwrite: true },
  });
  assert.equal(installed.serial, "SP3-0001");
  assert.equal(installed.device_type, "spectro 3");
  client.close();
  await server.close();
});

test("connectSpectro resolves on DeviceConnected, not on the Connect ack", async () => {
  const server = await startMockServer((command, handle) => {
    if (command.command !== "Connect") return [];
    // The server acks first and reports the real connection afterwards.
    setTimeout(
      () =>
        handle.send({
          event: "DeviceConnected",
          payload: {
            serial: "SP1-0007",
            device_type: "spectro",
            rssi: -54,
            handle: 1,
            firmware_version: "60.67",
            updated_at: "2026-10-01T00:00:00Z",
          },
        }),
      20,
    );
    return [{ event: "Connect", payload: { serial: "SP1-0007" } }];
  });
  const client = new DongleClient({ port: server.port });
  await client.connect();

  const device = await client.connectSpectro("SP1-0007", 1000);

  assert.equal(device.serial, "SP1-0007");
  assert.equal(device.device_type, "spectro");
  assert.equal(device.firmware_version, "60.67");
  client.close();
  await server.close();
});

test("connectSpectro rejects when the device never connects", async () => {
  const server = await startMockServer(() => [
    { event: "Connect", payload: { serial: "SP1-0007" } },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.connectSpectro("SP1-0007", 60),
    /Connect timed out after 60ms/,
  );

  client.close();
  await server.close();
});

test("disconnectSpectro rejects on an errored Disconnect reply", async () => {
  // The server only answers Disconnect when it fails - awaiting just
  // DeviceDisconnected would turn this into a timeout.
  const server = await startMockServer(() => [
    {
      event: "Disconnect",
      payload: { serial: "SP1-0007" },
      error_code: "vi-device-disconnected",
    },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.disconnectSpectro("SP1-0007", 5000),
    (error: unknown) =>
      error instanceof DongleCommandError &&
      error.code === "vi-device-disconnected",
  );

  client.close();
  await server.close();
});

test("disconnectSpectro resolves on DeviceDisconnected", async () => {
  const server = await startMockServer((command) =>
    command.command === "Disconnect"
      ? [{ event: "DeviceDisconnected", payload: { serial: "SP1-0007" } }]
      : [],
  );
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await client.disconnectSpectro("SP1-0007", 1000);

  assert.deepEqual(server.received[0], {
    command: "Disconnect",
    parameters: { serial: "SP1-0007" },
  });
  client.close();
  await server.close();
});

test("an error payload's message reaches the caller", async () => {
  // WithError on a CategorizedError puts {error_code, message, error_type,
  // file} in the payload and the code in error_code. Reading only the code
  // throws away the one sentence that says what to do - here, that the drive
  // is gone.
  const server = await startMockServer(() => [
    {
      event: "CopyLicense",
      payload: {
        error_code: "vi-invalid-parameters",
        message:
          "invalid file path: stat /Volumes/BRIDGE/SP3-0001.kpag: no such file or directory",
        error_type: "file_error",
        file: "/Volumes/BRIDGE/SP3-0001.kpag",
      },
      error_code: "vi-invalid-parameters",
    },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.installLicense("/Volumes/BRIDGE/SP3-0001.kpag"),
    (error: unknown) =>
      error instanceof DongleCommandError &&
      error.code === "vi-invalid-parameters" &&
      error.detail ===
        "invalid file path: stat /Volumes/BRIDGE/SP3-0001.kpag: no such file or directory" &&
      /invalid file path/.test(error.message),
  );

  client.close();
  await server.close();
});

test("a plain error_code with no payload message still rejects cleanly", async () => {
  const server = await startMockServer(() => [
    { event: "CopyLicense", payload: {}, error_code: "vi-invalid-license" },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.installLicense("/Volumes/BRIDGE/X.kpag"),
    (error: unknown) =>
      error instanceof DongleCommandError &&
      error.code === "vi-invalid-license" &&
      error.detail === undefined &&
      error.message === "CopyLicense failed: vi-invalid-license",
  );

  client.close();
  await server.close();
});

test("a Connect rejected by the server fails fast with its code", async () => {
  // The server answers a refused Connect under event "Connect" with a code,
  // while every accepted attempt also gets an errorless "Connect" ack. Only
  // the errored one may settle the promise.
  const server = await startMockServer(() => [
    { event: "Connect", payload: { serial: "SP1-0007" } },
    {
      event: "Connect",
      payload: { serial: "SP1-0007" },
      error_code: "vi-missing-license",
    },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.connectSpectro("SP1-0007", 5000),
    (error: unknown) =>
      error instanceof DongleCommandError &&
      error.code === "vi-missing-license",
  );

  client.close();
  await server.close();
});

test("a Connect that times out on the air fails fast too", async () => {
  // A BLE attempt that never pairs arrives as DeviceDisconnected carrying
  // vi-connection-timed-out, not as a Connect failure.
  const server = await startMockServer(() => [
    { event: "Connect", payload: { serial: "SP1-0007" } },
    {
      event: "DeviceDisconnected",
      payload: { serial: "SP1-0007", disconnect_code: "0202" },
      error_code: "vi-connection-timed-out",
    },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.connectSpectro("SP1-0007", 5000),
    (error: unknown) =>
      error instanceof DongleCommandError &&
      error.code === "vi-connection-timed-out",
  );

  client.close();
  await server.close();
});

test("an errorless Connect ack does not settle connectSpectro", async () => {
  // The ack means "attempt started", not "connected". Settling on it would
  // report a connected device that is not connected.
  const server = await startMockServer(() => [
    { event: "Connect", payload: { serial: "SP1-0007" } },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.connectSpectro("SP1-0007", 60),
    /Connect timed out after 60ms/,
  );

  client.close();
  await server.close();
});

test("a link lost mid-scan fails the scan instead of waiting out the timeout", async () => {
  const server = await startMockServer((command) =>
    command.command === "Scan"
      ? [
          {
            event: "DeviceDisconnected",
            payload: { serial: "SP3-0001" },
            error_code: "vi-connection-lost",
          },
        ]
      : [],
  );
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.scan("SP3-0001", 30_000),
    (error: unknown) =>
      error instanceof DongleCommandError && error.code === "vi-connection-lost",
  );

  client.close();
  await server.close();
});
