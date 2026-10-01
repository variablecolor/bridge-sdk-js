import net from "node:net";
import type { AnyResponse } from "../protocol/types.ts";

export interface MockServerHandle {
  port: number;
  /** Every command line the server received, parsed. */
  received: Array<Record<string, unknown>>;
  /** Push a frame to the connected client. */
  send: (frame: AnyResponse) => void;
  /**
   * Drop the client socket without closing the server.
   *
   * Awaits the accept callback first: a client's `connect` resolving does not
   * mean this server has captured the socket yet, and under load it has not -
   * destroying a socket we do not hold yet is a silent no-op.
   */
  dropClient: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A newline-delimited JSON echo server whose replies the test chooses.
 *
 * `onCommand` returns the frames to send back, so a test can answer, stay
 * silent (to exercise a timeout), or reply with an error_code.
 */
export const startMockServer = async (
  onCommand: (
    command: Record<string, unknown>,
    handle: MockServerHandle,
  ) => AnyResponse[] | void = () => [],
): Promise<MockServerHandle> => {
  const received: Array<Record<string, unknown>> = [];
  let client: net.Socket | null = null;
  let markConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve;
  });

  const server = net.createServer((socket) => {
    client = socket;
    markConnected();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const command = JSON.parse(line) as Record<string, unknown>;
        received.push(command);
        for (const frame of onCommand(command, handle) ?? []) {
          handle.send(frame);
        }
      }
    });
    socket.on("error", () => {
      /* a test dropping the socket is not a failure */
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server did not bind a TCP port");
  }

  const handle: MockServerHandle = {
    port: address.port,
    received,
    send: (frame) => client?.write(`${JSON.stringify(frame)}\n`),
    dropClient: async () => {
      await connected;
      client?.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy();
        server.close(() => resolve());
      }),
  };

  return handle;
};
