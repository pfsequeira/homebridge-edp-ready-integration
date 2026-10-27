# Changelog

## 0.2.0 – 2026-10-27
- Optional Matter mode (Homebridge >= 2.3, Matter enabled on the plugin's child bridge): "Consumo casa" outlet with ElectricalPowerMeasurement / ElectricalEnergyMeasurement for the iOS 27 Home Energy view.
- Experimental `matter.exposeProduction`: "Produção solar" with negative active power and cumulative exported energy.
- Power updates throttled to 2 s, energy every 60 s; on/off commands are ignored.
- HAP/Eve accessories unchanged.

## 0.1.1 – 2026-10-27
- Node.js 24 support in engines.
- HomeKit-valid accessory names (no parentheses): "Rede importação", light sensors "<name> watts".


## 0.1.0 – 2026-10-27
- Initial release: dynamic platform `EdpSolar`.
- Four accessories (house consumption, solar production, grid import, grid export) as Outlets with Eve power (W), total energy (kWh), voltage (V) and fakegato history.
- Optional light sensors (lux = watts) for Apple Home automations.
- AWS Cognito login, EDP API discovery, AWS IoT MQTT (WebSocket + SigV4) realtime stream, auto re-login and reconnect. Read-only.
