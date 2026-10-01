import { test } from "node:test";
import assert from "node:assert/strict";
import { DongleClient, DongleCommandError } from "./DongleClient.ts";
import { startMockServer } from "../test-support/mockServer.ts";
import type { DongleStatus } from "../protocol/types.ts";

test("getDongle resolves with the GetDongle payload", async () => {
  const server = await startMockServer((command) =>
    command.command === "GetDongle"
      ? [
          {
            event: "GetDongle",
            payload: { status: "connected", firmware: "1.4.2" },
          },
        ]
      : [],
  );
  const client = new DongleClient({ port: server.port });

  await client.connect();
  const status = await client.getDongle();

  assert.equal(status.status, "connected");
  assert.equal(status.firmware, "1.4.2");
  client.close();
  await server.close();
});

test("getConfiguration resolves with serials and device types", async () => {
  const server = await startMockServer(() => [
    {
      event: "GetConfiguration",
      payload: {
        keep_alive: true,
        verbose: true,
        port: 9100,
        address: "127.0.0.1",
        serials: ["SP3-0001"],
        license_dir: "/licenses",
        version: "2.0.0",
        devices: { "SP3-0001": { device_type: "spectro 3" } },
      },
    },
  ]);
  const client = new DongleClient({ port: server.port });

  await client.connect();
  const config = await client.getConfiguration();

  assert.deepEqual(config.serials, ["SP3-0001"]);
  assert.equal(config.devices["SP3-0001"].device_type, "spectro 3");
  client.close();
  await server.close();
});

test("a response carrying error_code rejects with that code", async () => {
  const server = await startMockServer(() => [
    { event: "GetDongle", payload: {}, error_code: "vi-dongle-missing" },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.getDongle(),
    (error: unknown) =>
      error instanceof DongleCommandError && error.code === "vi-dongle-missing",
  );

  client.close();
  await server.close();
});

test("a silent server rejects on the per-command timeout", async () => {
  const server = await startMockServer(() => []);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () => client.getDongle(60),
    /GetDongle timed out after 60ms/,
  );

  client.close();
  await server.close();
});

test("the socket closing rejects every in-flight command", async () => {
  const server = await startMockServer(() => []);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  const pending = assert.rejects(
    () => client.getDongle(5000),
    /connection closed/i,
  );
  await server.dropClient();

  await pending;
  await server.close();
});

test("a command before connect rejects instead of throwing from net", async () => {
  const client = new DongleClient({ port: 9 });

  await assert.rejects(() => client.getDongle(), /not connected/i);
});

test("connect rejects when nothing is listening", async () => {
  // Port 1 is privileged and unbound in CI; nothing will answer.
  const client = new DongleClient({ port: 1, defaultTimeoutMs: 500 });

  await assert.rejects(() => client.connect());
  assert.equal(client.isConnected(), false);
});

test("unsolicited frames reach the callbacks, not a pending promise", async () => {
  const buttons: string[] = [];
  const statuses: DongleStatus[] = [];
  const server = await startMockServer(() => []);
  const client = new DongleClient({
    port: server.port,
    onButtonPress: (serial) => buttons.push(serial),
    onDongleStatus: (status) => statuses.push(status),
  });
  await client.connect();

  server.send({ event: "ButtonDidPress", payload: { serial: "SP1-9" } });
  server.send({ event: "GetDongle", payload: { status: "disconnected" } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(buttons, ["SP1-9"]);
  assert.equal(statuses.at(-1)?.status, "disconnected");
  client.close();
  await server.close();
});
