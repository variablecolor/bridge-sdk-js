import { spawn, type ChildProcess } from "node:child_process";
import {
  DongleClient,
  type DongleClientOptions,
} from "../client/DongleClient.ts";

/**
 * The binary's name for a given bench.
 *
 * macOS ships two builds and the Intel one is what an Apple Silicon machine
 * running under Rosetta needs, which is exactly what `process.arch` reports
 * there - so arch, not CPU, is the right input.
 */
export const resolveBinaryName = (
  platform: NodeJS.Platform,
  arch: string,
): string => {
  if (platform === "win32") return "variable_dongle_server.exe";
  if (platform === "darwin") {
    return arch === "arm64"
      ? "variable_dongle_server"
      : "variable_dongle_server_x86";
  }
  throw new Error(`Unsupported platform: ${platform}`);
};

export interface LaunchOptions {
  /** Absolute path to the binary. The caller owns packaging and lookup. */
  binaryPath: string;
  args?: string[];
  onLog?: (line: string) => void;
  restartOnCrash?: boolean;
  restartDelayMs?: number;
}

export interface DongleServerHandle {
  kill: () => void;
  isRunning: () => boolean;
}

/**
 * Spawn the dongle server and keep it up.
 *
 * No Electron: the caller passes the binary path and wires its own quit hook.
 * A spawn failure is logged rather than thrown, because a missing binary is a
 * condition the caller reports through its own UI, not a crash.
 */
export const launchDongleServer = (
  options: LaunchOptions,
): DongleServerHandle => {
  const { binaryPath, args = ["-verbose"], onLog } = options;
  const restartOnCrash = options.restartOnCrash ?? true;
  const restartDelayMs = options.restartDelayMs ?? 1000;

  let child: ChildProcess | null = null;
  let killed = false;

  const start = () => {
    if (killed) return;

    const next = spawn(binaryPath, args);
    child = next;
    onLog?.(`dongle-server spawned pid=${next.pid}`);

    next.stdout?.setEncoding("utf8");
    next.stderr?.setEncoding("utf8");
    next.stdout?.on("data", (data: string) => onLog?.(data.trimEnd()));
    next.stderr?.on("data", (data: string) =>
      onLog?.(`[stderr] ${data.trimEnd()}`),
    );

    next.on("error", (error) => {
      child = null;
      onLog?.(`dongle-server failed to start: ${error.message}`);
    });

    next.on("close", (code, signal) => {
      child = null;
      onLog?.(
        `dongle-server exited code=${code} signal=${signal} killed=${killed}`,
      );
      if (!killed && restartOnCrash) setTimeout(start, restartDelayMs);
    });
  };

  start();

  return {
    kill: () => {
      killed = true;
      onLog?.(
        `dongle-server kill requested pid=${child?.pid ?? "none"} exitCode=${child?.exitCode ?? "null"}`,
      );
      child?.kill();
      child = null;
    },
    isRunning: () => child !== null && child.exitCode === null,
  };
};

export interface ConnectOrLaunchOptions {
  client?: DongleClient;
  clientOptions?: DongleClientOptions;
  launch: LaunchOptions;
  connectRetries?: number;
  connectRetryDelayMs?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Prefer a server that is already listening, spawn one otherwise.
 *
 * A developer with the demo app open already has a server on 9100; stealing
 * the port or starting a second copy is worse than sharing the first. `server`
 * comes back null in that case, which is the caller's signal not to kill it on
 * quit.
 */
export const connectOrLaunch = async (
  options: ConnectOrLaunchOptions,
): Promise<{ client: DongleClient; server: DongleServerHandle | null }> => {
  const client = options.client ?? new DongleClient(options.clientOptions);
  const retries = options.connectRetries ?? 10;
  const retryDelayMs = options.connectRetryDelayMs ?? 500;

  try {
    await client.connect();
    return { client, server: null };
  } catch {
    // Nothing listening yet - that is the normal bench case.
  }

  const server = launchDongleServer(options.launch);

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    await sleep(retryDelayMs);
    try {
      await client.connect();
      return { client, server };
    } catch {
      if (attempt === retries) {
        server.kill();
        throw new Error(
          `could not reach the dongle server at ${client.host}:${client.port} after ${retries} attempts`,
        );
      }
    }
  }

  throw new Error("unreachable");
};
