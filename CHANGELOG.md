# Changelog

All notable changes to this project are documented here.

## 1.0.0 – 2026-11-13
- First public release, prepared for Homebridge verification.
- Everything is now in English: log messages, Homebridge UI settings, documentation.
- New accessories get English default names: Home Consumption, Solar Production, Grid Import, Grid Export.
  **Existing accessories keep their current names** (names are never changed on upgrade). Accessory UUIDs are unchanged, so HomeKit and Matter pairings are kept.
- New optional `names` setting to choose the name of each accessory.
- Eve history is pinned to the file it started with, so renaming an accessory no longer loses its history.
- Credentials are read only from the plugin configuration (removed the `EDP_SOLAR_EMAIL` / `EDP_SOLAR_PASSWORD` environment variable fallback).
- The plugin does not start (and logs one warning) until email and password are configured.
- More robust error handling: HTTP timeouts, no unhandled promise rejections, timers cleared on shutdown, clearer error messages.
- Device serial numbers are no longer written to the debug log; per-update debug logging reduced.
- Firmware revision shown in HomeKit/Matter now follows the plugin version.
- ESLint (typescript-eslint flat config) added and enforced in CI; CI runs on Node.js 20, 22, 24 and 26.
- `engines`: Node.js `^20.19.0 || ^22.13.0 || ^24 || ^26`, Homebridge `^1.8.0 || ^2.0.0`.

## 0.2.0 – 2026-10-27
- Optional Matter mode (Homebridge >= 2.3, Matter enabled on the plugin's child bridge): home consumption outlet with ElectricalPowerMeasurement / ElectricalEnergyMeasurement for the iOS 27 Home Energy view.
- Experimental `matter.exposeProduction`: solar production with negative active power and cumulative exported energy.
- Power updates throttled to 2 s, energy every 60 s; on/off commands are ignored.
- HAP/Eve accessories unchanged.

## 0.1.1 – 2026-10-27
- Node.js 24 support in engines.
- HomeKit-valid accessory names (no parentheses); light sensors are named "<name> watts".

## 0.1.0 – 2026-10-27
- Initial release: dynamic platform `EdpSolar`.
- Four accessories (house consumption, solar production, grid import, grid export) as Outlets with Eve power (W), total energy (kWh), voltage (V) and fakegato history.
- Optional light sensors (lux = watts) for Apple Home automations.
- AWS Cognito login, EDP API discovery, AWS IoT MQTT (WebSocket + SigV4) realtime stream, auto re-login and reconnect. Read-only.
