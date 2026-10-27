import { API, APIEvent, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, WithUUID } from 'homebridge';
import { EdpClient, Values, Totals } from './edpClient';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fakegato = require('fakegato-history');

const PLUGIN = 'homebridge-edp-ready-integration';
const PLATFORM = 'EdpSolar';

type Key = 'consumed' | 'produced' | 'fromGrid' | 'injected';
const METERS: { key: Key; name: string; total: (t: Totals) => number | undefined }[] = [
  { key: 'consumed', name: 'Consumo casa', total: t => (t.fromGridWh !== undefined && t.injectedWh !== undefined) ? (t.producedWh ?? 0) + t.fromGridWh - t.injectedWh : undefined },
  { key: 'produced', name: 'Produção solar', total: t => t.producedWh },
  { key: 'fromGrid', name: 'Rede (importação)', total: t => t.fromGridWh },
  { key: 'injected', name: 'Injeção na rede', total: t => t.injectedWh },
];

export = (api: API) => { api.registerPlatform(PLUGIN, PLATFORM, EdpSolarPlatform); };

class EdpSolarPlatform implements DynamicPlatformPlugin {
  private cached: PlatformAccessory[] = [];
  private eve!: { Power: WithUUID<new () => Characteristic>; Total: WithUUID<new () => Characteristic>; Volt: WithUUID<new () => Characteristic> };
  private outlets: Partial<Record<Key, { svc: Service; hist: any; lux?: Service }>> = {};
  private client?: EdpClient;

  constructor(private log: Logging, private config: PlatformConfig, private api: API) {
    this.makeEve();
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.launch());
    api.on(APIEvent.SHUTDOWN, () => this.client?.stop());
  }

  configureAccessory(a: PlatformAccessory) { this.cached.push(a); }

  private makeEve() {
    const { Characteristic: C, Formats, Perms } = this.api.hap;
    const mk = (name: string, uuid: string, unit: string) => {
      const K = class extends C { static readonly UUID = uuid;
        constructor() { super(name, uuid, { format: Formats.FLOAT, unit, minValue: 0, maxValue: 1e9, minStep: 0.1, perms: [Perms.PAIRED_READ, Perms.NOTIFY] }); this.value = this.getDefaultValue(); } };
      return K as unknown as WithUUID<new () => Characteristic>;
    };
    this.eve = {
      Power: mk('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52', 'W'),
      Total: mk('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', 'kWh'),
      Volt: mk('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', 'V'),
    };
  }

  private async launch() {
    const email = this.config.email ?? process.env.EDP_SOLAR_EMAIL;
    const password = this.config.password ?? process.env.EDP_SOLAR_PASSWORD;
    if (!email || !password) { this.log.error('Configure email e password da conta EDP Solar.'); return; }
    const { Service: S, Characteristic: C } = this.api.hap;
    const FakeGato = fakegato(this.api);
    const wanted = new Set<string>();
    for (const m of METERS) {
      if (this.config[`hide_${m.key}`]) { continue; }
      const uuid = this.api.hap.uuid.generate(`${PLATFORM}:${m.key}`);
      wanted.add(uuid);
      let a = this.cached.find(x => x.UUID === uuid);
      const isNew = !a;
      if (!a) { a = new this.api.platformAccessory(m.name, uuid); }
      a.getService(S.AccessoryInformation)!
        .setCharacteristic(C.Manufacturer, 'EDP').setCharacteristic(C.Model, 'r:easy / EDP Solar')
        .setCharacteristic(C.SerialNumber, `edp-${m.key}`).setCharacteristic(C.FirmwareRevision, '0.1.0');
      const svc = a.getService(S.Outlet) ?? a.addService(S.Outlet, m.name);
      for (const ch of [this.eve.Power, this.eve.Total, this.eve.Volt]) { if (!svc.testCharacteristic(ch as any)) { svc.addCharacteristic(ch); } }
      // Read-only: switching from HomeKit is ignored and reverted
      svc.getCharacteristic(C.On).onSet(() => { setTimeout(() => svc.updateCharacteristic(C.On, (this.client?.values[m.key] ?? 0) > (this.config.threshold ?? 10)), 300); });
      let lux: Service | undefined = a.getService(S.LightSensor);
      if (this.config.luxSensors !== false) {
        lux = lux ?? a.addService(S.LightSensor, `${m.name} (W)`);
      } else if (lux) { a.removeService(lux); lux = undefined; }
      const hist = new FakeGato('energy', a, { storage: 'fs', path: this.api.user.storagePath(), log: this.log, disableTimer: false });
      this.outlets[m.key] = { svc, hist, lux };
      if (isNew) { this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [a]); }
    }
    const stale = this.cached.filter(a => !wanted.has(a.UUID));
    if (stale.length) { this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, stale); }

    this.client = new EdpClient(email, password, this.log);
    this.client.on('values', (v: Values) => this.onValues(v));
    this.client.on('totals', (t: Totals) => this.onTotals(t));
    const start = async () => {
      try { await this.client!.start(); this.log.debug(`EDP: dispositivos ${JSON.stringify(this.client!.devices)}`); }
      catch (e: any) { this.log.error(`EDP: arranque falhou: ${e.message}; nova tentativa em 5 min`); setTimeout(start, 300e3); }
    };
    start();
  }

  private lastHist: Partial<Record<Key, number>> = {};
  private onValues(v: Values) {
    const { Characteristic: C } = this.api.hap;
    const thr = this.config.threshold ?? 10;
    for (const k of Object.keys(this.outlets) as Key[]) {
      const w = v[k]; const o = this.outlets[k]!; if (w === undefined) { continue; }
      o.svc.updateCharacteristic(this.eve.Power, w);
      o.svc.updateCharacteristic(C.On, w > thr);
      o.svc.updateCharacteristic(C.OutletInUse, w > thr);
      o.lux?.updateCharacteristic(C.CurrentAmbientLightLevel, Math.min(100000, Math.max(0.0001, w)));
      const now = Date.now();
      if (!this.lastHist[k] || now - this.lastHist[k]! > 60e3) { o.hist.addEntry({ time: Math.round(now / 1000), power: w }); this.lastHist[k] = now; }
    }
    this.log.debug(`EDP: ${JSON.stringify(v)}`);
  }

  private onTotals(t: Totals) {
    for (const m of METERS) {
      const o = this.outlets[m.key]; if (!o) { continue; }
      const wh = m.total(t); if (wh !== undefined) { o.svc.updateCharacteristic(this.eve.Total, Math.round(wh / 100) / 10); }
      if (t.voltage !== undefined) { o.svc.updateCharacteristic(this.eve.Volt, t.voltage); }
    }
    this.log.debug(`EDP: totais (kWh) produção=${(t.producedWh ?? 0) / 1000} importação=${(t.fromGridWh ?? 0) / 1000} injeção=${(t.injectedWh ?? 0) / 1000}`);
  }
}
