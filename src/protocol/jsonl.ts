import type { AnyResponse, Command } from "./types.ts";

/** One command per line - the server's framing is newline-delimited JSON. */
export const encodeCommand = <T>(command: Command<T>): string =>
  `${JSON.stringify(command)}\n`;

/**
 * Build a stateful chunk handler.
 *
 * `net` makes no line guarantees: a frame can arrive split in half, and two
 * frames can arrive glued together. Anything after the last newline is held
 * until the rest of it shows up.
 */
export const createFrameParser = (
  onFrame: (frame: AnyResponse) => void,
  onParseError?: (line: string, error: Error) => void,
): ((chunk: string) => void) => {
  let buffer = "";

  return (chunk: string) => {
    buffer += chunk;

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (!line) continue;

      try {
        onFrame(JSON.parse(line) as AnyResponse);
      } catch (error) {
        // One bad frame must not take the connection down with it.
        onParseError?.(line, error as Error);
      }
    }
  };
};
