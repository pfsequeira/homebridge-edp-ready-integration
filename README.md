# homebridge-edp-ready-integration

[![npm](https://img.shields.io/npm/v/homebridge-edp-ready-integration)](https://www.npmjs.com/package/homebridge-edp-ready-integration)
[![Build and Lint](https://github.com/pfsequeira/homebridge-edp-ready-integration/actions/workflows/build.yml/badge.svg)](https://github.com/pfsequeira/homebridge-edp-ready-integration/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by EDP. It uses the same cloud services as the EDP mobile app. Use at your own risk.

A [Homebridge](https://homebridge.io) plugin that reads **realtime** energy data from an **EDP Solar / EDP re:dy** account and shows it in Apple HomeKit: solar production, home consumption, grid import and grid export, with Eve power and history graphs and optional Matter energy reporting for the iOS Home app.

The plugin only talks to the EDP cloud (AWS Cognito, the EDP API and AWS IoT MQTT). Nothing on your local network or on the re:dy box is needed or changed. It is **read-only**: it never changes account or device settings.

## Accessories

| Default name | Meaning |
|---|---|
| Home Consumption | Home consumption = production + import − export (W) |
| Solar Production | Solar production (W) |
| Grid Import | Power imported from the grid (W) |
| Grid Export | Power exported to the grid (W) |

Each accessory is an **Outlet** with Eve characteristics:

- *Consumption* (W, live, every 2–10 s), *Total Consumption* (kWh, lifetime meter counter, refreshed every 5 min) and *Voltage* (V)
- history through `fakegato-history` (Eve graphs)
- *On / In Use* = power above a threshold (default 10 W). Switching it from HomeKit is ignored.

Optionally, each accessory also gets a **Light Sensor** where **lux = watts**, so the Apple Home app can use the power in automations (for example, "when *Grid Export* is above 1500 lux, turn on the water heater").

### Apple Home vs Eve

- **Apple Home** shows the outlets on/off and the light sensors (lux = W). It does **not** show watts or kWh on outlets (use Matter mode for that).
- The **Eve app** (or Controller for HomeKit, Home+) shows W, kWh, V and history graphs.

## Installation

Search for **EDP Solar re:dy** in the Homebridge UI Plugins tab and install it, or run:

```bash
npm install -g homebridge-edp-ready-integration
```

Requirements: Node.js 20, 22, 24 or 26 and Homebridge 1.8 or later (2.x supported). Pure JavaScript, so it works on a Raspberry Pi. Running the plugin in a [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges) is recommended.

## Configuration

Use the plugin **Settings** in the Homebridge UI, or add the platform to `config.json`:

```json
{
  "platform": "EdpSolar",
  "name": "EDP Solar",
  "email": "you@example.com",
  "password": "********",
  "threshold": 10,
  "luxSensors": true
}
```

| Option | Default | Description |
|---|---|---|
| `email`, `password` | – | Your EDP Solar account. Required; the plugin does not start without them. |
| `threshold` | `10` | Power (W) above which an outlet shows as on / in use. |
| `luxSensors` | `true` | Add a light sensor (lux = W) to each accessory for Apple Home automations. |
| `hide_consumed`, `hide_produced`, `hide_fromGrid`, `hide_injected` | `false` | Hide individual accessories. |
| `names.consumed`, `names.produced`, `names.fromGrid`, `names.injected` | – | Optional custom names. When empty, existing accessories keep their current name and new ones use the default names above. |
| `matter.enabled` | `false` | Enable Matter mode (see below). |
| `matter.exposeProduction` | `false` | Experimental: also publish solar production over Matter. |

Your credentials are only sent to EDP's login service and are never logged. The plugin only writes files (Eve history) inside the Homebridge storage directory and contains no analytics or tracking.

## Matter mode (optional, iOS 27 Energy)

Homebridge 2.3 or later can publish Matter accessories. With `matter.enabled: true`, the plugin also publishes the following (the HomeKit/Eve accessories stay unchanged):

- **Home Consumption**: a Matter On/Off outlet with ElectricalPowerMeasurement (active power, voltage, current) and ElectricalEnergyMeasurement (lifetime consumption as *cumulative energy imported*). Apple Home shows the watts on the tile and counts it in the Energy total. It is on while the load is above `threshold`; on/off commands are ignored.
- **Solar Production** (experimental, `matter.exposeProduction`): reports generation the Matter way, with *negative* active power and *cumulative energy exported*, so it is not added to consumption. Apple Home may ignore it or display it oddly.

Requirements: run the plugin in a **child bridge with Matter enabled** (Homebridge UI → plugin → Bridge Settings → enable Matter), then pair the child bridge's Matter code in the Home app. On older Homebridge versions, or without Matter on the bridge, the plugin logs one warning and skips Matter. Bridged Matter devices count towards the Energy total but are not listed per device in the breakdown.

```json
"matter": { "enabled": true, "exposeProduction": false }
```

## How it works

1. Cognito `USER_PASSWORD_AUTH`, then Cognito Identity credentials (renewed before they expire, about every hour).
2. `uiapi.emcp.edp.com/equipment/houses`, `/device` and `/modules` to find the production and grid meters and their lifetime totals.
3. MQTT over WebSocket (SigV4) to AWS IoT: subscribes to `<type>/<id>/fromDev/realtime` and sends the same read-only `realtime` stream request as the app every 55 s.
   Fields: `emeter:power_aplus` (grid import, W) and `emeter:power_aminus` (export on the grid meter, production on the production meter, W).

If the EDP cloud is unreachable or the login fails, the plugin logs the error and retries; it never crashes Homebridge.

## Upgrading from 0.x

Version 1.0.0 switched the default accessory names to English. Accessories you already have **keep their current names**, UUIDs and Eve history, so nothing changes in the Home app. To rename them, use the `names` options. The `EDP_SOLAR_EMAIL` / `EDP_SOLAR_PASSWORD` environment variables are no longer read; set the credentials in the plugin settings.

## Credits

Protocol details come from the community Home Assistant [`edp_solar`](https://github.com/RodrigoAzevedo/edpSolarIntegration) integration.

## License

[MIT](LICENSE)
