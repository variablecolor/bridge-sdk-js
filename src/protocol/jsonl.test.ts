import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameParser, encodeCommand } from "./jsonl.ts";
import type { AnyResponse } from "./types.ts";

test("encodeCommand appends the newline delimiter", () => {
  assert.equal(
    encodeCommand({ command: "Connect", parameters: { serial: "ABC" } }),
    '{"command":"Connect","parameters":{"serial":"ABC"}}\n',
  );
});

test("parses several frames arriving in one chunk", () => {
  const seen: AnyResponse[] = [];
  const feed = createFrameParser((f) => seen.push(f));

  feed('{"event":"GetDongle","payload":{}}\n{"event":"Scan","payload":{}}\n');

  assert.deepEqual(
    seen.map((f) => f.event),
    ["GetDongle", "Scan"],
  );
});

test("buffers a frame split across two chunks", () => {
  const seen: AnyResponse[] = [];
  const feed = createFrameParser((f) => seen.push(f));

  feed('{"event":"GetConfig');
  assert.equal(seen.length, 0, "no frame until the newline arrives");

  feed('uration","payload":{"version":"1.2.3"}}\n');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, "GetConfiguration");
  assert.deepEqual(seen[0].payload, { version: "1.2.3" });
});

test("a malformed line is reported and the stream keeps working", () => {
  const seen: AnyResponse[] = [];
  const errors: string[] = [];
  const feed = createFrameParser(
    (f) => seen.push(f),
    (line) => errors.push(line),
  );

  feed('not json\n{"event":"Scan","payload":{"hex":"#fff"}}\n');

  assert.deepEqual(errors, ["not json"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, "Scan");
});

test("blank lines and bare \\r\\n are ignored", () => {
  const seen: AnyResponse[] = [];
  const errors: string[] = [];
  const feed = createFrameParser(
    (f) => seen.push(f),
    (line) => errors.push(line),
  );

  feed('\n\r\n{"event":"GetDongle","payload":{}}\r\n');

  assert.deepEqual(errors, []);
  assert.equal(seen.length, 1);
});
