import type { API, Logging, PlatformConfig } from 'homebridge';
import type { Values, Totals } from './edpClient';
import { PLUGIN_NAME as PLUGIN, PLATFORM_NAME as PLATFORM, PLUGIN_VERSION, resolveName } from './names';

/**
 * Optional Matter publisher (Homebridge >= 2.3 with Matter enabled on this plugin's bridge).
 * - Home consumption: Matter On/Off outlet + ElectricalPowerMeasurement (activePower mW, voltage mV)
 *   + ElectricalEnergyMeasurement (cumulativeEnergyImported mWh). iOS 27 Home shows tile watts and counts it in the Energy total.
 * - Solar production (experimental): outlet reporting generation the Matter way: activePower NEGATIVE (mW)
 *   and cumulativeEnergyExported (mWh), so it should not be added to consumption.
 * On/Off is read-only: any command is reverted to the measured state.
 */
type Kind = 'consumed' | 'produced';
interface Dev { kind: Kind; uuid: string; name: string; lastPower: number; lastEnergy: number; on: boolean }

/* eslint-disable @typescript-eslint/no-explicit-any -- the Matter API is only typed in Homebridge >= 2.3 */

function versionAtLeast(v: string, min: number[]): boolean {
  const p = (v || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) { if ((p[i] ?? 0) !== min[i]) { return (p[i] ?? 0) > min[i]; } }
  return true;
}

export class MatterPublisher {
  private devs: Dev[] = [];
  private cached: any[] = [];
  private m: any;
  private values: Values = {};
  private voltage?: number;
  private energyWh: Partial<Record<Kind, number>> = {};
  private timer?: NodeJS.Timeout;

  constructor(private api: API, private log: Logging, private config: PlatformConfig) {}

  /** Called from platform.configureMatterAccessory */
  addCached(acc: any) { this.cached.push(acc); }

  static available(api: API, log: Logging, config: PlatformConfig): boolean {
    if (!config.matter?.enabled) { return false; }
    const a = api as any;
    if (!versionAtLeast(api.serverVersion, [2, 3, 0]) || typeof a.isMatterEnabled !== 'function') {
      log.warn(`Matter: requires Homebridge >= 2.3 (running ${api.serverVersion}); Matter mode skipped.`); return false;
    }
    if (!a.isMatterEnabled() || !a.matter) {
      log.warn('Matter: not enabled on this plugin\'s bridge. Enable Matter on the plugin\'s child bridge (Homebridge UI > plugin > Bridge Settings). Matter mode skipped.');
      return false;
    }
    return true;
  }

  async start() {
    const a = this.api as any; this.m = a.matter;
    const thr = this.config.threshold ?? 10;
    const kinds: Kind[] = ['consumed'];
    if (this.config.matter?.exposeProduction) { kinds.push('produced'); }
    const names = (this.config.names ?? {}) as Partial<Record<Kind, unknown>>;
    const toRegister: any[] = []; const toUpdate: any[] = [];
    for (const kind of kinds) {
      // UUID is seeded from the kind only, so names can change without breaking pairing.
      const uuid = this.m.uuid.generate(`${PLATFORM}:matter:${kind}`);
      const cached = this.cached.find(c => c.UUID === uuid);
      const w = { kind, name: resolveName(kind, names[kind], cached?.displayName) };
      const dev: Dev = { kind: w.kind, uuid, name: w.name, lastPower: 0, lastEnergy: 0, on: false };
      const revert = async () => { setTimeout(() => this.update(uuid, 'onOff', { onOff: dev.on }), 300); };
      const exported = w.kind === 'produced';
      const acc = {
        UUID: uuid, displayName: w.name, deviceType: this.m.deviceTypes.OnOffOutlet,
        serialNumber: `edp-matter-${w.kind}`, manufacturer: 'EDP (unofficial)', model: 're:dy meter', firmwareRevision: PLUGIN_VERSION,
        context: { kind: w.kind },
        clusters: {
          onOff: { onOff: false },
          electricalPowerMeasurement: { voltage: null, activeCurrent: null, activePower: null },
          electricalEnergyMeasurement: exported ? { cumulativeEnergyExported: null } : { cumulativeEnergyImported: null },
        },
        handlers: { onOff: { on: revert, off: revert, toggle: revert } },
      };
      if (cached) { toUpdate.push(acc); } else { toRegister.push(acc); }
      this.devs.push(dev);
    }
    const keep = new Set(this.devs.map(d => d.uuid));
    const stale = this.cached.filter(c => !keep.has(c.UUID));
    if (stale.length) { await this.m.unregisterPlatformAccessories(PLUGIN, PLATFORM, stale); }
    if (toUpdate.length) { await this.m.updatePlatformAccessories(toUpdate); }
    if (toRegister.length) { await this.m.registerPlatformAccessories(PLUGIN, PLATFORM, toRegister); }
    this.log.info(`Matter: published ${this.devs.map(d => d.name).join(', ')} (threshold ${thr} W).`);
    this.timer = setInterval(() => this.pushEnergy(), 60e3);
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }

  /** Calls the Matter API, turning sync throws and rejections into a logged message. */
  private update(uuid: string, cluster: string, attrs: Record<string, unknown>, onError: (e: Error) => void = e => this.log.debug(`Matter ${cluster}: ${e.message}`)) {
    try {
      Promise.resolve(this.m.updateAccessoryState(uuid, cluster, attrs)).catch(onError);
    } catch (e) { onError(e as Error); }
  }

  onValues(v: Values) { this.values = v; this.pushPower(); }
  onTotals(t: Totals) {
    this.voltage = t.voltage;
    if (t.producedWh !== undefined) { this.energyWh.produced = t.producedWh; }
    if (t.fromGridWh !== undefined && t.injectedWh !== undefined) { this.energyWh.consumed = (t.producedWh ?? 0) + t.fromGridWh - t.injectedWh; }
    this.pushEnergy();
  }

  private pushPower() {
    const now = Date.now(); const thr = this.config.threshold ?? 10;
    for (const d of this.devs) {
      const w = d.kind === 'consumed' ? this.values.consumed : this.values.produced;
      if (w === undefined || now - d.lastPower < 2000) { continue; }
      d.lastPower = now;
      const mw = d.kind === 'produced' && w > 0 ? -Math.round(w * 1000) : Math.round(w * 1000);
      const attrs: Record<string, unknown> = { activePower: mw };
      if (this.voltage) { attrs.voltage = Math.round(this.voltage * 1000); attrs.activeCurrent = Math.round(Math.abs(w) / this.voltage * 1000); }
      this.update(d.uuid, 'electricalPowerMeasurement', attrs);
      const on = w > thr;
      if (on !== d.on) { d.on = on; this.update(d.uuid, 'onOff', { onOff: on }); }
    }
  }

  private pushEnergy() {
    const now = Date.now();
    for (const d of this.devs) {
      const wh = this.energyWh[d.kind];
      if (wh === undefined || now - d.lastEnergy < 55e3) { continue; }
      d.lastEnergy = now;
      const key = d.kind === 'produced' ? 'cumulativeEnergyExported' : 'cumulativeEnergyImported';
      this.update(d.uuid, 'electricalEnergyMeasurement', { [key]: { energy: Math.round(wh * 1000) } }, e => this.log.warn(`Matter energy (${d.name}): ${e.message}`));
    }
  }
}
