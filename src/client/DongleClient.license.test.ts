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
