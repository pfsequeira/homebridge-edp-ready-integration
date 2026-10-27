# homebridge-edp-ready-integration

> **Unofficial.** Not affiliated with, endorsed by, or supported by EDP. Uses the same cloud endpoints as the EDP mobile app. Use at your own risk.

Homebridge plugin that reads **realtime** energy data from an **EDP Solar / EDP re:dy (r:easy)** account and exposes it to HomeKit — in the spirit of `homebridge-octopus-energy`.

It talks only to the EDP cloud (AWS Cognito + EDP API + AWS IoT MQTT). Nothing on your LAN or on the re:dy box is needed or changed. It is **read‑only**: it never changes account or device settings.

## Accessories

| Accessory | Meaning |
|---|---|
| Consumo casa | House consumption = production + import − export (W) |
| Produção solar | Solar production (W) |
| Rede importação | Power imported from the grid (W) |
| Injeção na rede | Power exported to the grid (W) |

Each one is an **Outlet** with Eve characteristics:
- *Consumption* (W, live, every 2–10 s), *Total Consumption* (kWh, lifetime meter counter, refreshed every 5 min), *Voltage* (V)
- history via `fakegato-history` (Eve graphs)
- *On / In Use* = power above a threshold (default 10 W). Switching it from HomeKit is ignored.

Optional **Light Sensor** per accessory where **lux = watts** — the Apple Home app can use it in automations (e.g. "when *Injeção na rede* lux > 1500, turn on the water heater").

### Apple Home vs Eve
- **Apple Home**: shows outlets on/off and the light sensors (lux = W). It does **not** display watts/kWh on outlets.
- **Eve app** (or Controller for HomeKit, Home+): shows W, kWh, V and history graphs.

## Install

Homebridge UI → Plugins → search `homebridge-edp-ready-integration` (once published), or from GitHub:

```bash
# Homebridge UI → ⋮ → Terminal (Raspberry Pi image), or ssh:
sudo hb-service add github:pfsequeira/homebridge-edp-ready-integration
# or, from a local tarball copied to the Pi:
sudo hb-service add /home/pi/homebridge-edp-ready-integration-0.1.1.tgz
```
(Equivalent: `npm install --prefix /var/lib/homebridge github:pfsequeira/homebridge-edp-ready-integration`.) Then restart Homebridge.

Requirements: Node.js 18, 20, 22 or 24; Homebridge ≥ 1.6 (2.x supported). Pure JavaScript, works on Raspberry Pi (ARM).

## Configuration

Use the plugin **Settings** in Homebridge UI, or:

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
Options `hide_consumed`, `hide_produced`, `hide_fromGrid`, `hide_injected` hide individual accessories.
Credentials are only used to log in to EDP and are never logged.

## Matter mode (optional, iOS 27 Energy)

Homebridge >= 2.3 can publish Matter accessories. With `matter.enabled: true` the plugin additionally publishes (the HAP/Eve accessories stay unchanged):

- **Consumo casa**: Matter On/Off outlet with ElectricalPowerMeasurement (active power, voltage, current) and ElectricalEnergyMeasurement (lifetime consumption as *cumulative energy imported*). Apple Home shows the watts on the tile and counts it in the Energy total. It is "on" while the load is above `threshold`; on/off commands are ignored (reverted).
- **Produção solar** (experimental, `matter.exposeProduction`): reports generation the Matter way: *negative* active power and *cumulative energy exported*, so it is not added to consumption. Apple Home may ignore or display it oddly.

Requirements: run the plugin in a **child bridge with Matter enabled** (Homebridge UI → plugin → Bridge Settings → enable Matter, or `"_bridge": {"username": "...", "port": ..., "matter": {}}`), then pair the child bridge's Matter QR/code in the Home app. On older Homebridge, or without Matter on the bridge, the plugin logs one warning and skips Matter. Bridged Matter devices appear in the Energy total but not per device in the breakdown.

```json
"matter": { "enabled": true, "exposeProduction": false }
```

## How it works
1. Cognito `USER_PASSWORD_AUTH` → Cognito Identity credentials (renewed before expiry, ~1 h).
2. `uiapi.emcp.edp.com/equipment/houses`, `/device`, `/modules` → finds the production and grid meters (+ lifetime totals).
3. MQTT over WebSocket (SigV4) to AWS IoT; subscribes to `<type>/<id>/fromDev/realtime` and sends the same `realtime` stream request as the app every 55 s.
   Fields: `emeter:power_aplus` (grid import, W), `emeter:power_aminus` (export on the grid meter / production on the production meter, W).

Credits: protocol details from the community Home Assistant `edp_solar` integration.

---

## Português

Plugin **não oficial** (sem ligação à EDP) que mostra no HomeKit, em tempo real, a **produção solar**, o **consumo da casa**, a **importação** e a **injeção na rede** da conta EDP Solar / re:dy. Só leitura; fala apenas com a cloud da EDP.

**Instalação no Raspberry Pi (imagem Homebridge):**
1. Homebridge UI → ⋮ → *Terminal*:
   `sudo hb-service add github:pfsequeira/homebridge-edp-ready-integration`
   (ou copie o `.tgz` para o Pi e use `sudo hb-service add /caminho/homebridge-edp-ready-integration-0.1.1.tgz`)
2. Plugins → *EDP Solar re:dy Integration* → *Settings*: email e password da conta EDP Solar.
3. Reinicie o Homebridge.

**O que aparece:** 4 tomadas (Consumo casa, Produção solar, Rede importação, Injeção na rede). Na app **Casa** vê‑se ligado/desligado e os sensores de luz (lux = watts, úteis para automações). Na app **Eve** vê‑se W, kWh, V e o histórico.

### Modo Matter (opcional, Energia do iOS 27)

Com Homebridge >= 2.3 e `matter.enabled: true`, o plugin publica também um outlet Matter **Consumo casa** com potência (W, V, A) e energia acumulada consumida, que o app Casa mostra no bloco e soma no total de Energia. `matter.exposeProduction` (experimental) publica **Produção solar** com potência negativa e energia exportada. É preciso correr o plugin numa child bridge com Matter ativo e emparelhar o código Matter dessa bridge no app Casa. Comandos ligar/desligar são ignorados.
