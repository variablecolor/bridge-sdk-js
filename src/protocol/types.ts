export type CommandType =
  | "GetDongle"
  | "GetConfiguration"
  | "CopyLicense"
  | "DeleteLicense"
  | "Scan"
  | "MultiModeScan"
  | "SetCalibration"
  | "Verify"
  | "Connect"
  | "Disconnect"
  | "StartBluetoothDiscovery"
  | "StopBluetoothDiscovery"
  | "Shutdown";

export type EventName =
  | CommandType
  | "ButtonDidPress"
  | "DeviceConnected"
  | "DeviceDisconnected"
  | "DiscoveredPeripheral";

/**
 * Every `error_code` the server can put on a response.
 *
 * Typed as a union with a string fallback: a newer server may add one, and an
 * unknown code must still reach the caller rather than being dropped.
 */
export type DongleErrorCode =
  | "vi-serial-disconnected"
  | "vi-device-disconnected"
  | "vi-bluetooth-device-not-connected"
  | "vi-max-connections"
  | "vi-missing-license"
  | "vi-invalid-license"
  | "vi-license-exists"
  | "vi-failed-license-transfer"
  | "vi-failed-deletion"
  | "vi-failed-white-tile-calibration"
  | "vi-failed-white-tile-verification"
  | "vi-failed-green-verification"
  | "vi-failed-blue-verification"
  | "vi-invalid-parameters"
  | "vi-malformed-request"
  | "vi-unknown-command"
  | "vi-not-implemented"
  | "vi-gloss-internal-one"
  | "vi-insufficient-memory"
  | "vi-connection-timed-out"
  | "vi-connection-lost"
  | "vi-characteristic-missing"
  | "vi-service-discovery-failed"
  | (string & {});

export interface Command<T> {
  command: CommandType;
  parameters?: T;
}

export interface Response<T> {
  event: EventName;
  payload: T;
  error_code?: DongleErrorCode;
}

export type AnyResponse = Response<unknown>;

export type DeviceType =
  | "spectro"
  | "color muse pro"
  | "spectro 3"
  | "color muse 3";

export interface LabJSON {
  L: number;
  a: number;
  b: number;
  illuminant: string;
  observer: string;
}

export interface SpectrumJSON {
  start: number;
  step: number;
  curve: number[];
}

export interface GlossMeasurement {
  id: string;
  ambient_sense_values: number[];
  raw_value: number;
  gloss: number;
}

export interface UVMeasurement {
  sense_values: number[];
}

/** The stored white-tile scan the device is currently calibrated against. */
export interface FieldCalibrationReading {
  sense_values: number[];
  gloss: GlossMeasurement | null;
  uv: UVMeasurement | null;
}

/**
 * A scan, exactly as the server marshals one.
 *
 * Every field is here on purpose. `SetCalibration` and `Verify` take whole
 * scans back and the server re-derives from `sense_values`, `gloss` and `uv`
 * rather than trusting `lab` - a Spectro 3 calibration is rejected
 * (`vi-invalid-parameters`) if `gloss` is missing. Narrowing this type
 * silently breaks Spectro 3.
 *
 * `start`/`step`/`curve` come from the embedded spectral curve and are absent
 * for device types whose curve the server strips (everything except Spectro 1
 * and Spectro 3).
 */
export interface ColorScan extends Partial<SpectrumJSON> {
  batch: string;
  model: string;
  serial: string;
  scan_count?: number;
  lab: LabJSON;
  hex: string;
  sense_values?: number[];
  gloss?: GlossMeasurement | null;
  uv?: UVMeasurement | null;
  device_type: DeviceType;
  measurement_mode?: string;
  field_calibration: FieldCalibrationReading;
  created_at: number;
}

export interface Battery {
  is_charging_complete: boolean;
  is_charging: boolean;
  /** 0 - 100 percent */
  level: number;
  /** 3.30 - 4.20 */
  voltage: number;
}

export interface APISpectroJSON {
  battery?: Battery;
  readonly device_type: DeviceType;
  rssi: number;
  serial: string;
  spectro?: {
    is_calibrated: boolean;
    last_calibration_scan_count: number;
    lifetime_scan_count: number;
  };
  handle: number;
  /** e.g. "60.23" */
  firmware_version: string;
  /** rfc3339 */
  updated_at: string;
}

export interface DongleStatus {
  status: "connected" | "disconnected";
  firmware?: string;
  dongle_id?: string;
  connected_devices?: APISpectroJSON[];
}

export interface ConfigurationPayload {
  keep_alive: boolean;
  verbose: boolean;
  port: number;
  address: string;
  /** Serials the server knows about, sourced from the installed licenses. */
  serials: string[];
  license_dir: string;
  version: string;
  devices: Record<string, { device_type: DeviceType }>;
}

export interface LicensePayload {
  serial: string;
  file?: string;
  delete_all?: boolean;
}

export interface LicenseInstalled {
  serial: string;
  file?: string;
  device_type: DeviceType;
}

export interface ButtonPayload {
  serial: string;
}

/** The only success shape. A failure is an `error_code`, not a false here. */
export interface CalibrationResultPayload {
  serial: string;
  calibration_result: "success";
}

export interface VerificationScanResult {
  is_within_tolerance: boolean;
  de: number;
  scan: ColorScan;
}

/**
 * The `Verify` response.
 *
 * Note the asymmetry: the request fields are `white_tile_verification` and
 * `blue_tile_verification`, but the results come back under `white_tile` and
 * `blue_tile`. Only the tiles present in the request are scored and present
 * here. Spectro 1 uses `green`/`blue`; Spectro 3 uses the tile pair.
 */
export interface VerifyResult {
  white?: VerificationScanResult;
  green?: VerificationScanResult;
  blue?: VerificationScanResult;
  white_tile?: VerificationScanResult;
  blue_tile?: VerificationScanResult;
}

/**
 * Calibration placements.
 *
 * `white` is always required. Which of the rest the server reads depends on
 * the device: Spectro 1 (`"spectro"`) reads `green` (or `white_tile`, which
 * the server prefers when present) and `blue`. For any other device they are
 * accepted and ignored.
 *
 * Spectro 3's comprehensive flow sends `{ white: cap, white_tile, blue }`.
 */
export interface CalibrationScans {
  /** Spectro 1: the white tile. Spectro 3: the shutter-closed cap scan. */
  white: ColorScan;
  white_tile?: ColorScan | null;
  green?: ColorScan | null;
  blue?: ColorScan | null;
}

/** A device found by `StartBluetoothDiscovery`. */
export interface DiscoveredPeripheral {
  serial: string;
  device_type?: DeviceType;
  rssi?: number;
  is_licensed: boolean;
}

export interface LabOptions {
  illuminant: string;
  observer: string;
}

export const DEFAULT_LAB_OPTIONS: LabOptions = {
  illuminant: "D65",
  observer: "TEN_DEGREE",
};
