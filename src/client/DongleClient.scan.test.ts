import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DongleClient,
  DongleCommandError,
  ScanThrottleError,
} from "./DongleClient.ts";
import { startMockServer } from "../test-support/mockServer.ts";
import type { ColorScan } from "../protocol/types.ts";

/**
 * A full scan as the server sends one.
 *
 * `gloss` matters: a Spectro 3 calibration is rejected without it, so the
 * fixture carries it and the round-trip test below proves it survives.
 */
const scanFixture = (serial: string): ColorScan => ({
  start: 400,
  step: 10,
  curve: [0.1, 0.2, 0.3],
  batch: "cm2-2",
  hex: "#aabbcc",
  lab: { L: 50, a: 1, b: -2, illuminant: "D65", observer: "TEN_DEGREE" },
  sense_values: [1, 2, 3],
  serial,
  model: "17.1",
  scan_count: 12,
  device_type: "spectro 3",
  gloss: {
    id: "g1",
    ambient_sense_values: [0.5, 0.6],
    raw_value: 42.5,
    gloss: 41.2,
  },
  uv: { sense_values: [7, 8] },
  field_calibration: { sense_values: [9, 10], gloss: null, uv: null },
  created_at: 1_790_000_000,
});

const calibrationOk = (serial: string) => ({
  event: "SetCalibration" as const,
  payload: { serial, calibration_result: "success" as const },
});

test("scan sends D65/TEN_DEGREE and resolves the ColorScan", async () => {
  const server = await startMockServer((command) =>
    command.command === "Scan"
      ? [{ event: "Scan", payload: scanFixture("SP3-0001") }]
      : [],
  );
  const client = new DongleClient({ port: server.port });
  await client.connect();

  const scan = await client.scan("SP3-0001");

  assert.deepEqual(server.received[0], {
    command: "Scan",
    parameters: {
      serial: "SP3-0001",
      lab: { illuminant: "D65", observer: "TEN_DEGREE" },
    },
  });
  assert.equal(scan.hex, "#aabbcc");
  client.close();
  await server.close();
});

test("a second scan inside the 5s window rejects with the remaining wait", async () => {
  const server = await startMockServer((command) =>
    command.command === "Scan"
      ? [{ event: "Scan", payload: scanFixture("SP3-0001") }]
      : [],
  );
  const client = new DongleClient({ port: server.port });
  await client.connect();
  await client.scan("SP3-0001");

  await assert.rejects(
    () => client.scan("SP3-0001"),
    (error: unknown) =>
      error instanceof ScanThrottleError &&
      error.retryInMs > 0 &&
      error.retryInMs <= 5000,
  );
  assert.equal(server.received.length, 1, "the throttled scan is not sent");

  client.close();
  await server.close();
});

test("setCalibration carries all three Spectro 1 placements", async () => {
  const server = await startMockServer((command) =>
    command.command === "SetCalibration" ? [calibrationOk("SP1-0007")] : [],
  );
  const client = new DongleClient({ port: server.port });
  await client.connect();

  const result = await client.setCalibration("SP1-0007", {
    white: scanFixture("SP1-0007"),
    green: scanFixture("SP1-0007"),
    blue: scanFixture("SP1-0007"),
  });

  const sent = server.received[0] as {
    parameters: { calibration_scans: Record<string, unknown> };
  };
  assert.deepEqual(Object.keys(sent.parameters.calibration_scans), [
    "white",
    "green",
    "blue",
  ]);
  assert.equal(result.calibration_result, "success");
  client.close();
  await server.close();
});

test("setCalibration uses white_tile for a Spectro 3", async () => {
  // readme.md:713 - the comprehensive S3 flow is cap + white tile + blue tile,
  // with the second placement under white_tile (not white_tile_verification,
  // which is a Verify parameter).
  const server = await startMockServer(() => [calibrationOk("SP3-0001")]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await client.setCalibration("SP3-0001", {
    white: scanFixture("SP3-0001"),
    white_tile: scanFixture("SP3-0001"),
    blue: scanFixture("SP3-0001"),
  });

  const sent = server.received[0] as {
    parameters: { calibration_scans: Record<string, unknown> };
  };
  assert.deepEqual(Object.keys(sent.parameters.calibration_scans), [
    "white",
    "white_tile",
    "blue",
  ]);
  client.close();
  await server.close();
});

test("setCalibration sends a scan unchanged, gloss and all", async () => {
  // The server re-derives from sense_values/gloss/uv and rejects an S3
  // calibration whose white scan has no gloss, so nothing may be dropped on
  // the way out.
  const server = await startMockServer(() => [calibrationOk("SP3-0001")]);
  const client = new DongleClient({ port: server.port });
  await client.connect();
  const white = scanFixture("SP3-0001");

  await client.setCalibration("SP3-0001", { white });

  const sent = server.received[0] as {
    parameters: { calibration_scans: { white: unknown } };
  };
  assert.deepEqual(sent.parameters.calibration_scans.white, white);
  client.close();
  await server.close();
});

test("a failed calibration rejects with the vi-* code", async () => {
  const server = await startMockServer(() => [
    {
      event: "SetCalibration",
      payload: { serial: "SP1-0007" },
      error_code: "vi-failed-white-tile-calibration",
    },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await assert.rejects(
    () =>
      client.setCalibration("SP1-0007", {
        white: scanFixture("SP1-0007"),
        green: scanFixture("SP1-0007"),
        blue: scanFixture("SP1-0007"),
      }),
    (error: unknown) =>
      error instanceof DongleCommandError &&
      error.code === "vi-failed-white-tile-calibration",
  );

  client.close();
  await server.close();
});

test("verify uses tile parameter names per device type", async () => {
  const server = await startMockServer(() => [
    {
      event: "Verify",
      payload: {
        white: { is_within_tolerance: true, de: 0.2, scan: scanFixture("X") },
      },
    },
  ]);
  const client = new DongleClient({ port: server.port });
  await client.connect();

  await client.verify(
    "SP3-0001",
    "spectro 3",
    scanFixture("SP3-0001"),
    scanFixture("SP3-0001"),
    scanFixture("SP3-0001"),
  );
  const spectro3 = server.received[0] as {
    parameters: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(spectro3.parameters).sort(), [
    "blue_tile_verification",
    "serial",
    "white",
    "white_tile_verification",
  ]);

  await client.verify(
    "SP1-0007",
    "spectro",
    scanFixture("SP1-0007"),
    scanFixture("SP1-0007"),
    scanFixture("SP1-0007"),
  );
  const spectro1 = server.received[1] as {
    parameters: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(spectro1.parameters).sort(), [
    "blue",
    "green",
    "serial",
    "white",
  ]);

  client.close();
  await server.close();
});
