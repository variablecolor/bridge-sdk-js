import net from "node:net";
import { createFrameParser, encodeCommand } from "../protocol/jsonl.ts";
import { DEFAULT_LAB_OPTIONS } from "../protocol/types.ts";
import type {
  AnyResponse,
  APISpectroJSON,
  CalibrationResultPayload,
  CalibrationScans,
  ColorScan,
  Command,
  CommandType,
  ConfigurationPayload,
  DeviceType,
  DiscoveredPeripheral,
  DongleErrorCode,
  DongleStatus,
  EventName,
  LabOptions,
  LicenseInstalled,
  LicensePayload,
  ScanOptions,
  VerifyResult,
} from "../protocol/types.ts";

/**
 * A response the server answered with an `error_code`.
 *
 * The server's richer failures put a `CategorizedError` in the payload -
 * `{error_code, message, error_type, file}` - and the sentence in `message` is
 * usually the only thing that says what to do about it ("invalid file path:
 * stat /Volumes/BRIDGE/X.kpag: no such file or directory"). It is kept on
 * `detail` and folded into `message`, because a caller that sees only the code
 * cannot tell a pulled USB drive from a corrupt licence.
 */
export class DongleCommandError extends Error {
  readonly code: DongleErrorCode;

  /** The server's own explanation, when it sent one. */
  readonly detail?: string;

  constructor(code: DongleErrorCode, command: CommandType, detail?: string) {
    super(
      detail
        ? `${command} failed: ${code}: ${detail}`
        : `${command} failed: ${code}`,
    );
    this.name = "DongleCommandError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * An awaited event that only counts when it carries an `error_code`.
 *
 * Some events are both an acknowledgement and a failure channel: every
 * `Connect` attempt is acked under `Connect` whether or not it works, and a
 * `DeviceDisconnected` is routine on teardown but is also how a failed pair or
 * a dropped link reports itself. Awaiting such an event outright would settle
 * on the ack; awaiting it error-only turns it into a fast failure path without
 * stealing the success case.
 */
export interface ErrorOnlyEvent extends AwaitEvent {
  errorOnly: true;
}

/**
 * An awaited event with conditions on which frames settle it.
 *
 * `serial` matters for device events: `DeviceDisconnected` from one Spectro
 * must not settle a command aimed at another. `ackCodes` covers the server
 * tagging an expected outcome with an error - a requested disconnect arrives
 * as `vi-connection-lost` just like a dropped link.
 */
export interface AwaitEvent {
  event: EventName;
  /** Settle only on a frame carrying an error code. */
  errorOnly?: boolean;
  /** Ignore frames whose `payload.serial` names a different device. */
  serial?: string;
  /** Error codes that resolve instead of reject. */
  ackCodes?: DongleErrorCode[];
}

/** Await `event` only if it arrives carrying an error code. */
export const onError = (event: EventName, serial?: string): ErrorOnlyEvent => ({
  event,
  errorOnly: true,
  serial,
});

export type AwaitSpec = EventName | AwaitEvent;

/** A scan asked for before the device's 5-second recovery window elapsed. */
export class ScanThrottleError extends Error {
  readonly retryInMs: number;

  constructor(retryInMs: number) {
    super(`Scan requested too soon; retry in ${retryInMs}ms`);
    this.name = "ScanThrottleError";
    this.retryInMs = retryInMs;
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
  /**
   * Reopen the socket after it drops unexpectedly. Off by default.
   *
   * Retries back off exponentially from `initialDelayMs` to `maxDelayMs` and
   * keep going until a retry succeeds or `close()` is called. A close you
   * asked for (`close()`, `shutdownServer()`, `requestShutdown()`) never
   * reconnects. Commands that were in flight when the socket dropped still
   * reject - the server cannot answer them on the new socket.
   */
  reconnect?: boolean | ReconnectOptions;
  /** Called each time a reconnect succeeds. */
  onReconnect?: () => void;
}

export interface ReconnectOptions {
  /** Default 500. */
  initialDelayMs?: number;
  /** Default 10000. */
  maxDelayMs?: number;
}

interface Pending {
  command: CommandType;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** This entry's keys that carry settle conditions. */
  specs: Map<EventName, AwaitEvent>;
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

  /** True between connect() and an intentional close; gates reconnects. */
  private wantConnected = false;

  private reconnectTimer: NodeJS.Timeout | null = null;

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
    this.wantConnected = true;
    this.cancelReconnect();
    await this.open();
  }

  private async open(): Promise<void> {
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
    this.wantConnected = false;
    this.cancelReconnect();
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
      if (this.wantConnected && this.options.reconnect) {
        this.scheduleReconnect(0);
      }
    });
  }

  private scheduleReconnect(attempt: number): void {
    const settings =
      typeof this.options.reconnect === "object" ? this.options.reconnect : {};
    const delay = Math.min(
      (settings.initialDelayMs ?? 500) * 2 ** attempt,
      settings.maxDelayMs ?? 10_000,
    );

    this.options.onLog?.(`reconnecting in ${delay}ms (attempt ${attempt + 1})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open().then(
        () => {
          // close() ran while the connect was pending.
          if (!this.wantConnected) {
            this.close();
            return;
          }
          this.options.onReconnect?.();
        },
        (error: Error) => {
          this.options.onLog?.(`reconnect failed: ${error.message}`);
          if (this.wantConnected) this.scheduleReconnect(attempt + 1);
        },
      );
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
    const spec = entry.specs.get(event);

    if (
      spec?.serial !== undefined &&
      (frame.payload as { serial?: string } | null)?.serial !== spec.serial
    ) {
      return;
    }

    // An error-only key ignores the success case: a bare Connect ack means
    // the attempt started, not that the device is on the air.
    if (!errorCode && spec?.errorOnly) return;

    // entry.resolve/reject clear the timer and every key this entry holds.
    if (errorCode && !spec?.ackCodes?.includes(errorCode)) {
      const detail = (frame.payload as { message?: string } | null)?.message;
      entry.reject(
        new DongleCommandError(errorCode, entry.command, detail),
      );
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
    awaitEvents: AwaitSpec | AwaitSpec[],
    timeoutMs: number,
  ): Promise<TPayload> {
    const specs = Array.isArray(awaitEvents) ? awaitEvents : [awaitEvents];
    const events = specs.map((spec) =>
      typeof spec === "string" ? spec : spec.event,
    );
    const conditions = new Map(
      specs
        .filter((spec): spec is AwaitEvent => typeof spec !== "string")
        .map((spec) => [spec.event, spec]),
    );

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
        specs: conditions,
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
   * Delete every installed license and clear the server's license cache.
   *
   * This is a separate method so a call to `deleteLicense` can never remove
   * all licenses by accident. No device can scan again until its `.kpag` is
   * reinstalled.
   */
  deleteAllLicenses(
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<LicensePayload> {
    return this.request<{ delete_all: true }, LicensePayload>(
      { command: "DeleteLicense", parameters: { delete_all: true } },
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
      [
        "DeviceConnected",
        // A refused Connect answers under Connect with a code; a pair that
        // never completes reports vi-connection-timed-out under
        // DeviceDisconnected. Without both, either one waits out the timeout
        // and loses the code that says why.
        onError("Connect"),
        onError("DeviceDisconnected", serial),
      ],
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
   *
   * The server tags every BLE disconnect except `0202` with
   * `vi-connection-lost`, including the `0216` a requested disconnect
   * produces. While this request is in flight that code on this serial's
   * `DeviceDisconnected` is the ack, not a failure.
   */
  async disconnectSpectro(
    serial: string,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<void> {
    const payload = await this.request<
      { serial: string },
      { serial: string; disconnect_code?: string }
    >(
      { command: "Disconnect", parameters: { serial } },
      [
        {
          event: "DeviceDisconnected",
          serial,
          ackCodes: ["vi-connection-lost"],
        },
        "Disconnect",
      ],
      timeoutMs,
    );
    this.options.onLog?.(
      `disconnected ${serial} (disconnect_code ${payload?.disconnect_code ?? "none"})`,
    );
  }

  async scan(
    serial: string,
    timeoutMs = this.defaultTimeoutMs,
    lab: LabOptions = DEFAULT_LAB_OPTIONS,
    options: ScanOptions = {},
  ): Promise<ColorScan> {
    // The type already forbids this; plain JS callers get the same check.
    if (options.measurement_mode && options.specular_mode) {
      throw new TypeError(
        "scan(): measurement_mode and specular_mode are mutually exclusive",
      );
    }

    const cooldown = this.scanCooldownMs();
    if (cooldown > 0) throw new ScanThrottleError(cooldown);

    this.lastScanAt = Date.now();
    return this.request<
      ScanOptions & { serial: string; lab: LabOptions },
      ColorScan
    >(
      { command: "Scan", parameters: { ...options, serial, lab } },
      ["Scan", onError("DeviceDisconnected", serial)],
      timeoutMs,
    );
  }

  async multiModeScan(
    serial: string,
    timeoutMs = this.defaultTimeoutMs,
    lab: LabOptions = DEFAULT_LAB_OPTIONS,
  ): Promise<ColorScan[]> {
    const cooldown = this.scanCooldownMs();
    if (cooldown > 0) throw new ScanThrottleError(cooldown);

    this.lastScanAt = Date.now();
    return this.request<{ serial: string; lab: LabOptions }, ColorScan[]>(
      { command: "MultiModeScan", parameters: { serial, lab } },
      ["MultiModeScan", onError("DeviceDisconnected", serial)],
      timeoutMs,
    );
  }

  /**
   * Apply a calibration from scans the caller collected.
   *
   * The server does not drive the placements. Spectro 1 sends white, green and
   * blue; Spectro 3 sends the shutter-closed cap scan as `white` plus
   * `white_tile` and `blue`. Scans go out exactly as they came back from
   * `scan()` - the server re-derives from `sense_values`, `gloss` and `uv`.
   *
   * Resolves only on `calibration_result: "success"`. A rejected calibration
   * arrives as an `error_code` and surfaces here as a `DongleCommandError`
   * (`vi-failed-white-tile-calibration`, `vi-failed-green-verification`,
   * `vi-failed-blue-verification`, `vi-failed-white-tile-verification`).
   */
  setCalibration(
    serial: string,
    scans: CalibrationScans,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<CalibrationResultPayload> {
    return this.request<
      { serial: string; calibration_scans: CalibrationScans },
      CalibrationResultPayload
    >(
      {
        command: "SetCalibration",
        parameters: { serial, calibration_scans: scans },
      },
      ["SetCalibration", onError("DeviceDisconnected", serial)],
      timeoutMs,
    );
  }

  /**
   * Run the verification routine against scans of the reference tiles.
   *
   * Spectro 3 names its tile parameters differently from Spectro 1, so the
   * device type picks the parameter spelling. Both answer under `Verify`, but
   * the results come back under `white_tile`/`blue_tile` for Spectro 3.
   */
  verify(
    serial: string,
    deviceType: DeviceType,
    white: ColorScan | null,
    second: ColorScan | null,
    third: ColorScan | null,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<VerifyResult> {
    const parameters =
      deviceType === "spectro 3"
        ? {
            serial,
            white,
            white_tile_verification: second,
            blue_tile_verification: third,
          }
        : { serial, white, green: second, blue: third };

    return this.request<typeof parameters, VerifyResult>(
      { command: "Verify", parameters },
      ["Verify", onError("DeviceDisconnected", serial)],
      timeoutMs,
    );
  }

  /**
   * Start a Bluetooth sweep.
   *
   * The response only acknowledges the start; each instrument found arrives
   * later as an unsolicited `DiscoveredPeripheral` carrying `is_licensed`
   * (wire it with `onDiscoveredPeripheral`). Note that the dongle cannot
   * connect while a sweep is running, which is why `Connect` stops discovery
   * server-side.
   */
  startBluetoothDiscovery(timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    return this.request<never, unknown>(
      { command: "StartBluetoothDiscovery" },
      "StartBluetoothDiscovery",
      timeoutMs,
    );
  }

  stopBluetoothDiscovery(timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    return this.request<never, unknown>(
      { command: "StopBluetoothDiscovery" },
      "StopBluetoothDiscovery",
      timeoutMs,
    );
  }

  /** Ask the server to exit. Fire and forget - it answers by closing. */
  shutdownServer(): void {
    if (!this.socket) return;
    this.wantConnected = false;
    this.socket.write(encodeCommand({ command: "Shutdown" }));
  }

  /**
   * Ask the server to exit and wait until it has.
   *
   * `Shutdown` is the one command with no response: the server disconnects
   * whatever it is holding, exits, and the socket closing is the only
   * acknowledgement. Prefer this over `shutdownServer()` when you need to
   * know it actually happened - destroying your own end right after writing
   * can drop the command before it is flushed, which looks like success and
   * leaves the server running.
   *
   * Rejects if the server is still there when `timeoutMs` elapses.
   */
  requestShutdown(timeoutMs = this.defaultTimeoutMs): Promise<void> {
    const socket = this.socket;
    if (!this.isConnected() || !socket) {
      return Promise.reject(
        new Error(
          `DongleClient is not connected to ${this.host}:${this.port}; call connect() first`,
        ),
      );
    }

    this.wantConnected = false;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("close", onClose);
        reject(
          new Error(
            `dongle server did not close the connection within ${timeoutMs}ms of Shutdown`,
          ),
        );
      }, timeoutMs);

      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };

      socket.once("close", onClose);
      // Written, not ended: the server's own exit closes the socket.
      socket.write(encodeCommand({ command: "Shutdown" }));
    });
  }
}
