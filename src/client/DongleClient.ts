import net from "node:net";
import { createFrameParser, encodeCommand } from "../protocol/jsonl.ts";
import type {
  AnyResponse,
  APISpectroJSON,
  Command,
  CommandType,
  ConfigurationPayload,
  DiscoveredPeripheral,
  DongleErrorCode,
  DongleStatus,
  EventName,
  LicenseInstalled,
  LicensePayload,
} from "../protocol/types.ts";

/** A response the server answered with an `error_code`. */
export class DongleCommandError extends Error {
  readonly code: DongleErrorCode;

  constructor(code: DongleErrorCode, command: CommandType) {
    super(`${command} failed: ${code}`);
    this.name = "DongleCommandError";
    this.code = code;
  }
}

export interface DongleClientOptions {
  host?: string;
  port?: number;
  /** Used by any command method called without an explicit timeout. */
  defaultTimeoutMs?: number;
  onLog?: (message: string) => void;
  onError?: (error: Error) => void;
  onButtonPress?: (serial: string) => void;
  onDongleStatus?: (status: DongleStatus) => void;
  onDeviceConnected?: (device: APISpectroJSON) => void;
  onDeviceDisconnected?: (serial: string) => void;
  onDiscoveredPeripheral?: (device: DiscoveredPeripheral) => void;
  onClose?: () => void;
}

interface Pending {
  command: CommandType;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_PORT = 9100;
export const DEFAULT_HOST = "127.0.0.1";

/** The device needs this long between scans; the server rejects faster ones. */
export const SCAN_INTERVAL_MS = 5_000;

/**
 * A client for one `variable_dongle_server` instance.
 *
 * Correlation is by event name, which is all the protocol offers: there is no
 * request id on the wire. One command of a given type may be in flight at a
 * time; a second rejects rather than silently stealing the first one's reply.
 */
export class DongleClient {
  private readonly options: DongleClientOptions;

  private socket: net.Socket | null = null;

  private readonly pending = new Map<EventName, Pending>();

  protected lastScanAt = 0;

  constructor(options: DongleClientOptions = {}) {
    this.options = options;
  }

  get host(): string {
    return this.options.host ?? DEFAULT_HOST;
  }

  get port(): number {
    return this.options.port ?? DEFAULT_PORT;
  }

  protected get defaultTimeoutMs(): number {
    return this.options.defaultTimeoutMs ?? 10_000;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Milliseconds until a scan is allowed, 0 when one is allowed now. */
  scanCooldownMs(): number {
    return Math.max(0, SCAN_INTERVAL_MS - (Date.now() - this.lastScanAt));
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setEncoding("utf8");

      const onConnectError = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.off("error", onConnectError);
        this.socket = socket;
        this.attach(socket);
        this.options.onLog?.(`connected to ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.rejectAll(new Error("DongleClient connection closed"));
  }

  private attach(socket: net.Socket): void {
    const feed = createFrameParser(
      (frame) => this.handleFrame(frame),
      (line, error) =>
        this.options.onLog?.(`unparseable frame (${error.message}): ${line}`),
    );

    socket.on("data", (chunk: string) => feed(chunk));
    socket.on("error", (error) => this.options.onError?.(error));
    socket.on("close", () => {
      this.socket = null;
      this.rejectAll(new Error("DongleClient connection closed"));
      this.options.onClose?.();
    });
  }

  private rejectAll(error: Error): void {
    // One entry can be registered under several event names, and rejecting it
    // clears its own keys - so snapshot the unique entries before iterating.
    const entries = new Set(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private handleFrame(frame: AnyResponse): void {
    const { event, error_code: errorCode } = frame;

    // Unsolicited pushes have no caller waiting on them.
    if (event === "ButtonDidPress") {
      this.options.onButtonPress?.((frame.payload as { serial: string }).serial);
      return;
    }
    if (event === "DiscoveredPeripheral") {
      this.options.onDiscoveredPeripheral?.(
        frame.payload as DiscoveredPeripheral,
      );
      return;
    }
    if (event === "DeviceConnected") {
      this.options.onDeviceConnected?.(frame.payload as APISpectroJSON);
    }
    if (event === "DeviceDisconnected") {
      this.options.onDeviceDisconnected?.(
        (frame.payload as { serial: string }).serial,
      );
    }
    if (event === "GetDongle") {
      this.options.onDongleStatus?.(frame.payload as DongleStatus);
    }

    const entry = this.pending.get(event);
    if (!entry) return;

    // entry.resolve/reject clear the timer and every key this entry holds.
    if (errorCode) {
      entry.reject(new DongleCommandError(errorCode, entry.command));
      return;
    }
    entry.resolve(frame.payload);
  }

  /**
   * Send one command and wait for the first frame whose `event` matches.
   *
   * Usually that is the command name, but not always. `Connect` is only an
   * ack - the link is live at `DeviceConnected`. `Disconnect` answers *only*
   * on failure; success is signalled by the unsolicited `DeviceDisconnected`.
   * So the awaited set is a list and the first frame under any of those names
   * settles the promise.
   */
  protected request<TParams, TPayload>(
    command: Command<TParams>,
    awaitEvents: EventName | EventName[],
    timeoutMs: number,
  ): Promise<TPayload> {
    const events = Array.isArray(awaitEvents) ? awaitEvents : [awaitEvents];

    if (!this.isConnected() || !this.socket) {
      return Promise.reject(
        new Error(
          `DongleClient is not connected to ${this.host}:${this.port}; call connect() first`,
        ),
      );
    }
    if (events.some((event) => this.pending.has(event))) {
      return Promise.reject(new Error(`${command.command} is already in flight`));
    }

    return new Promise<TPayload>((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        for (const event of events) this.pending.delete(event);
      };

      const timer = setTimeout(() => {
        clear();
        reject(new Error(`${command.command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const entry: Pending = {
        command: command.command,
        resolve: (payload) => {
          clear();
          (resolve as (value: unknown) => void)(payload);
        },
        reject: (error) => {
          clear();
          reject(error);
        },
        timer,
      };

      for (const event of events) this.pending.set(event, entry);

      this.options.onLog?.(`TX ${JSON.stringify(command)}`);
      this.socket?.write(encodeCommand(command));
    });
  }

  getDongle(timeoutMs = this.defaultTimeoutMs): Promise<DongleStatus> {
    return this.request<never, DongleStatus>(
      { command: "GetDongle" },
      "GetDongle",
      timeoutMs,
    );
  }

  getConfiguration(
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<ConfigurationPayload> {
    return this.request<never, ConfigurationPayload>(
      { command: "GetConfiguration" },
      "GetConfiguration",
      timeoutMs,
    );
  }

  /**
   * Install a `.kpag` into the server's license directory.
   *
   * The command carries no serial - the response reports which serial the file
   * turned out to be for, so a caller that expected a particular unit must
   * compare it. The path must be absolute; the server rejects anything else.
   */
  installLicense(
    filePath: string,
    overwrite = true,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<LicenseInstalled> {
    return this.request<{ file: string; overwrite: boolean }, LicenseInstalled>(
      { command: "CopyLicense", parameters: { file: filePath, overwrite } },
      "CopyLicense",
      timeoutMs,
    );
  }

  deleteLicense(
    serial: string,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<LicensePayload> {
    return this.request<{ serial: string }, LicensePayload>(
      { command: "DeleteLicense", parameters: { serial } },
      "DeleteLicense",
      timeoutMs,
    );
  }

  /**
   * Open a Bluetooth link to a licensed device.
   *
   * `Connect` is only an acknowledgement; the link is live at
   * `DeviceConnected`, so that is the frame this waits for. A device the
   * server already holds short-circuits - it re-labels its reply
   * `DeviceConnected` - so both paths land here.
   */
  connectSpectro(
    serial: string,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<APISpectroJSON> {
    return this.request<{ serial: string }, APISpectroJSON>(
      { command: "Connect", parameters: { serial } },
      "DeviceConnected",
      timeoutMs,
    );
  }

  /**
   * Close the Bluetooth link.
   *
   * The server writes nothing on success - the unsolicited
   * `DeviceDisconnected` is the ack. It *does* answer on failure, under event
   * `Disconnect` with an error code, so both names are awaited; otherwise a
   * real failure would sit until the timeout.
   */
  async disconnectSpectro(
    serial: string,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<void> {
    await this.request<{ serial: string }, { serial: string }>(
      { command: "Disconnect", parameters: { serial } },
      ["DeviceDisconnected", "Disconnect"],
      timeoutMs,
    );
  }
}
