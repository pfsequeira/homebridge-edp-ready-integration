import { hostname } from 'os';
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, WithUUID } from 'homebridge';
import { EdpClient, Values, Totals } from './edpClient';
import { MatterPublisher } from './matter';
import { PLUGIN_NAME, PLATFORM_NAME, PLUGIN_VERSION, MeterKey, resolveName } from './names';
// fakegato-history ships without type definitions
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fakegato = require('fakegato-history');

const METERS: { key: MeterKey; total: (t: Totals) => number | undefined }[] = [
  { key: 'consumed', total: t => (t.fromGridWh !== undefined && t.injectedWh !== undefined) ? (t.producedWh ?? 0) + t.fromGridWh - t.injectedWh : undefined },
  { key: 'produced', total: t => t.producedWh },
  { key: 'fromGrid', total: t => t.fromGridWh },
  { key: 'injected', total: t => t.injectedWh },
];

const RETRY_START_MS = 5 * 60e3;

export = (api: API) => { api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EdpSolarPlatform); };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

class EdpSolarPlatform implements DynamicPlatformPlugin {
  private cached: PlatformAccessory[] = [];
  private matterCache: unknown[] = [];
  private eve!: { Power: WithUUID<new () => Characteristic>; Total: WithUUID<new () => Characteristic>; Volt: WithUUID<new () => Characteristic> };
  private outlets: Partial<Record<MeterKey, { svc: Service; hist: { addEntry(e: object): void }; lux?: Service }>> = {};
  private client?: EdpClient;
  private matter?: MatterPublisher;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;
  private lastHist: Partial<Record<MeterKey, number>> = {};

  constructor(private readonly log: Logging, private readonly config: PlatformConfig, private readonly api: API) {
    this.makeEve();
    api.on('didFinishLaunching', () => {
      this.launch().catch(e => this.log.error(`Startup failed: ${errMsg(e)}`));
    });
    api.on('shutdown', () => {
      this.stopped = true;
      if (this.retryTimer) { clearTimeout(this.retryTimer); }
      this.client?.stop();
      this.matter?.stop();
    });
  }

  configureAccessory(a: PlatformAccessory) { this.cached.push(a); }

  /** Homebridge >= 2.3: restores cached Matter accessories. */
  configureMatterAccessory(a: unknown) { this.matterCache.push(a); }

  private makeEve() {
    const { Characteristic: C, Formats, Perms } = this.api.hap;
    const mk = (name: string, uuid: string, unit: string) => {
      const K = class extends C {
        static readonly UUID = uuid;
        constructor() {
          super(name, uuid, { format: Formats.FLOAT, unit, minValue: 0, maxValue: 1e9, minStep: 0.1, perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
          this.value = this.getDefaultValue();
        }
      };
      return K as unknown as WithUUID<new () => Characteristic>;
    };
    this.eve = {
      Power: mk('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52', 'W'),
      Total: mk('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', 'kWh'),
      Volt: mk('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', 'V'),
    };
  }

  private async launch() {
    const email = typeof this.config.email === 'string' ? this.config.email.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';
    if (!email || !password) {
      this.log.warn('Not configured: set the EDP Solar account email and password in the plugin settings. The plugin will not start.');
      return;
    }
    const { Service: S, Characteristic: C } = this.api.hap;
    const FakeGato = fakegato(this.api);
    const host = hostname().split('.')[0];
    const wanted = new Set<string>();
    const names = (this.config.names ?? {}) as Partial<Record<MeterKey, unknown>>;
    for (const m of METERS) {
      if (this.config[`hide_${m.key}`]) { continue; }
      // UUIDs are seeded from the platform and meter key only, never from the name,
      // so renaming never breaks existing HomeKit pairings.
      const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${m.key}`);
      wanted.add(uuid);
      let a = this.cached.find(x => x.UUID === uuid);
      const isNew = !a;
      const name = resolveName(m.key, names[m.key], a?.displayName);
      if (!a) { a = new this.api.platformAccessory(name, uuid); }
      // Pin the Eve history file to the name the accessory had when history started,
      // so later renames do not lose history.
      a.context.historyFile ??= `${host}_${a.displayName}_persist.json`;
      a.getService(S.AccessoryInformation)!
        .setCharacteristic(C.Manufacturer, 'EDP').setCharacteristic(C.Model, 're:dy / EDP Solar')
        .setCharacteristic(C.SerialNumber, `edp-${m.key}`).setCharacteristic(C.FirmwareRevision, PLUGIN_VERSION);
      const svc = a.getService(S.Outlet) ?? a.addService(S.Outlet, name);
      for (const ch of [this.eve.Power, this.eve.Total, this.eve.Volt]) {
        if (!svc.testCharacteristic(ch as unknown as WithUUID<typeof Characteristic>)) { svc.addCharacteristic(ch); }
      }
      // Read-only: switching from HomeKit is ignored and reverted
      svc.getCharacteristic(C.On).onSet(() => {
        setTimeout(() => svc.updateCharacteristic(C.On, (this.client?.values[m.key] ?? 0) > this.threshold), 300);
      });
      let lux: Service | undefined = a.getService(S.LightSensor);
      if (this.config.luxSensors !== false) {
        lux = lux ?? a.addService(S.LightSensor, `${name} watts`);
      } else if (lux) { a.removeService(lux); lux = undefined; }
      const hist = new FakeGato('energy', a, { storage: 'fs', path: this.api.user.storagePath(), filename: a.context.historyFile, log: this.log, disableTimer: false });
      svc.setCharacteristic(C.Name, name);
      lux?.setCharacteristic(C.Name, `${name} watts`);
      if (a.displayName !== name) {
        a.displayName = name;
        a.getService(S.AccessoryInformation)!.setCharacteristic(C.Name, name);
      }
      this.outlets[m.key] = { svc, hist, lux };
      if (isNew) { this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [a]); } else { this.api.updatePlatformAccessories([a]); }
    }
    const stale = this.cached.filter(a => !wanted.has(a.UUID));
    if (stale.length) { this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale); }

    if (MatterPublisher.available(this.api, this.log, this.config)) {
      const matter = new MatterPublisher(this.api, this.log, this.config);
      for (const a of this.matterCache) { matter.addCached(a); }
      try { await matter.start(); this.matter = matter; } catch (e) { this.log.error(`Matter: failed to publish accessories: ${errMsg(e)}`); }
    }

    const client = new EdpClient(email, password, this.log);
    this.client = client;
    client.on('values', (v: Values) => { this.onValues(v); this.matter?.onValues(v); });
    client.on('totals', (t: Totals) => { this.onTotals(t); this.matter?.onTotals(t); });
    const start = async () => {
      if (this.stopped) { return; }
      try {
        await client.start();
        this.log.debug(`Discovered ${Object.keys(client.devices).length} EDP device(s)`);
      } catch (e) {
        this.log.error(`Could not connect to EDP: ${errMsg(e)}. Retrying in 5 minutes.`);
        this.retryTimer = setTimeout(() => { void start(); }, RETRY_START_MS);
      }
    };
    await start();
  }

  private get threshold(): number {
    const t = Number(this.config.threshold);
    return Number.isFinite(t) ? t : 10;
  }

  private onValues(v: Values) {
    const { Characteristic: C } = this.api.hap;
    const thr = this.threshold;
    for (const k of Object.keys(this.outlets) as MeterKey[]) {
      const w = v[k]; const o = this.outlets[k]!; if (w === undefined) { continue; }
      o.svc.updateCharacteristic(this.eve.Power, w);
      o.svc.updateCharacteristic(C.On, w > thr);
      o.svc.updateCharacteristic(C.OutletInUse, w > thr);
      o.lux?.updateCharacteristic(C.CurrentAmbientLightLevel, Math.min(100000, Math.max(0.0001, w)));
      const now = Date.now();
      const last = this.lastHist[k];
      if (!last || now - last > 60e3) {
        try { o.hist.addEntry({ time: Math.round(now / 1000), power: w }); } catch (e) { this.log.debug(`History write failed: ${errMsg(e)}`); }
        this.lastHist[k] = now;
      }
    }
  }

  private onTotals(t: Totals) {
    for (const m of METERS) {
      const o = this.outlets[m.key]; if (!o) { continue; }
      const wh = m.total(t); if (wh !== undefined) { o.svc.updateCharacteristic(this.eve.Total, Math.round(wh / 100) / 10); }
      if (t.voltage !== undefined) { o.svc.updateCharacteristic(this.eve.Volt, t.voltage); }
    }
    this.log.debug(`Lifetime totals (kWh): production=${(t.producedWh ?? 0) / 1000} import=${(t.fromGridWh ?? 0) / 1000} export=${(t.injectedWh ?? 0) / 1000}`);
  }
}
