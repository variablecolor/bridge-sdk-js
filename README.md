# @variablecolor/bridge-sdk-js

A dependency-free TypeScript client for the **Bridge by Variable** dongle
server (`variable_dongle_server`). The server is a local process that speaks
newline-delimited JSON over TCP on port 9100 and owns the USB dongle and its
Bluetooth link to a Spectro instrument. This library speaks that protocol so
your app does not have to.

Protocol documentation: <https://bridge.vrbl.cloud>

## What is and is not included

**Included:** the wire protocol types, a promise-per-command client, and a
helper that launches the server process (or attaches to one already running).

**Not included:** the `variable_dongle_server` binary itself. You obtain it
with your Bridge dongle and ship it with your application; this library only
needs the path to it.

## Install

```bash
npm install github:variablecolor/bridge-sdk-js#v0.1.0
```

Node 20 or newer. Both ESM and CommonJS builds are published.

## Quickstart

```js
import { connectOrLaunch, resolveBinaryName } from "@variablecolor/bridge-sdk-js";
import path from "node:path";

const { client, server } = await connectOrLaunch({
  clientOptions: { onLog: (line) => console.log("[sdk]", line) },
  launch: {
    binaryPath: path.join(
      "/path/to/bin",
      resolveBinaryName(process.platform, process.arch),
    ),
    onLog: (line) => console.log("[server]", line),
  },
});

// Is the dongle plugged in?
console.log(await client.getDongle());

// Which instruments have a license installed?
const config = await client.getConfiguration();
console.log(config.serials);

// Connect one and scan.
const serial = config.serials[0];
await client.connectSpectro(serial);
const scan = await client.scan(serial);
console.log(scan.hex, scan.lab);

await client.disconnectSpectro(serial);
client.close();
// null when we attached to a server someone else started - do not kill it.
server?.kill();
```

`connectOrLaunch` tries to connect first and only spawns the server if nothing
answers on the port. When it returns `server: null` it attached to an existing
process; killing that is not yours to do.

## API

Every command method returns a promise that settles when the matching response
arrives, and takes an optional per-call timeout in milliseconds.

| Method | Command | Resolves when |
|---|---|---|
| `getDongle()` | `GetDongle` | `GetDongle` — dongle status, firmware, id |
| `getConfiguration()` | `GetConfiguration` | `GetConfiguration` — licensed serials and their device types |
| `installLicense(path, overwrite?)` | `CopyLicense` | `CopyLicense` — reports which serial the file was for |
| `deleteLicense(serial)` | `DeleteLicense` | `DeleteLicense` |
| `connectSpectro(serial)` | `Connect` | `DeviceConnected` — not the `Connect` ack |
| `disconnectSpectro(serial)` | `Disconnect` | `DeviceDisconnected`, or rejects on an errored `Disconnect` |
| `scan(serial)` | `Scan` | `Scan` — one reading |
| `multiModeScan(serial)` | `MultiModeScan` | `MultiModeScan` — one reading per measurement mode |
| `setCalibration(serial, scans)` | `SetCalibration` | `calibration_result: "success"` |
| `verify(serial, deviceType, white, second, third)` | `Verify` | `Verify` — per-tile `de` and `is_within_tolerance` |
| `startBluetoothDiscovery()` / `stopBluetoothDiscovery()` | discovery | the acknowledgement |
| `shutdownServer()` | `Shutdown` | nothing — the server answers by closing |

Unsolicited events are callbacks on the constructor options, not promises:
`onButtonPress`, `onDongleStatus`, `onDeviceConnected`, `onDeviceDisconnected`,
`onDiscoveredPeripheral`, `onError`, `onClose`, `onLog`.

### Errors

A command that fails rejects with a `DongleCommandError` whose `code` is the
server's `error_code` — for example `vi-missing-license`,
`vi-bluetooth-device-not-connected`, `vi-invalid-parameters`. There is no
success boolean to inspect: a resolved promise means the command succeeded.

### Pass scans around whole

`setCalibration` and `verify` take back the scan objects `scan()` returned. The
server re-derives colour from `sense_values`, `gloss` and `uv` rather than
trusting the `lab` you send, and a Spectro 3 calibration is rejected with
`vi-invalid-parameters` if the white scan's `gloss` is missing. Do not reshape
or trim a scan before handing it back.

### Calibration differs by instrument

Calibration is driven by your app: you collect the scans, the server judges
them.

**Spectro 1** (`device_type: "spectro"`) — three placements on the tiles that
ship with the instrument:

```js
await client.setCalibration(serial, { white, green, blue });
```

**Spectro 3** (`device_type: "spectro 3"`) — close the shutter for the first
scan, then the two reference tiles:

```js
await client.setCalibration(serial, {
  white: capScan,      // shutter closed
  white_tile: whiteTileScan,
  blue: blueTileScan,
});
```

A quick Spectro 3 calibration is the cap scan alone: `{ white: capScan }`.

`verify` names its tiles differently again — Spectro 1 uses `green`/`blue`
while Spectro 3 uses `white_tile_verification`/`blue_tile_verification` — so
pass the device type and the method picks the spelling:

```js
const result = await client.verify(serial, "spectro 3", capScan, whiteTileScan, blueTileScan);
// result.white, result.white_tile, result.blue_tile → { de, is_within_tolerance, scan }
```

### The five-second scan window

An instrument needs about five seconds between scans. `scan()` and
`multiModeScan()` throw `ScanThrottleError` — before anything is sent —when
called inside that window, and `client.scanCooldownMs()` tells you how long is
left, which is what you want for a countdown in your UI.

## License

MIT. See [LICENSE](LICENSE).
