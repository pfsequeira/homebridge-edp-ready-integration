import { createHmac, createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } from '@aws-sdk/client-cognito-identity';
import mqtt, { MqttClient } from 'mqtt';

// Public app constants (same as the community Home Assistant integration)
const REGION = 'eu-west-1';
const ID_USER_POOL = 'eu-west-1_CZc7dNRRv';
const CLIENT_ID = '6qvkl7ibvspbfjabmhqhije6e1';
const CLIENT_SECRET = '145vkmdmcfn146a9mj8an6or0b3jmiqgp3c861evtns6bba4d0tp';
const IDENTITY_POOL_ID = 'eu-west-1:6d1279fe-b63a-4255-8f11-556369bdab2e';
const IOT_HOST = 'axhipzdhdp7t3-ats.iot.eu-west-1.amazonaws.com';
const API = 'https://uiapi.emcp.edp.com/equipment';

export type Role = 'PRODUCTION' | 'GRID' | 'OTHER';
export interface Values { produced?: number; fromGrid?: number; injected?: number; consumed?: number }
export interface Totals { producedWh?: number; fromGridWh?: number; injectedWh?: number; voltage?: number }
interface Logger { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void }

const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
const sha = (d: string) => createHash('sha256').update(d).digest('hex');

function presignIotUrl(ak: string, sk: string, token: string): string {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const service = 'iotdevicegateway';
  const scope = `${date}/${REGION}/${service}/aws4_request`;
  const q = [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    `X-Amz-Credential=${encodeURIComponent(`${ak}/${scope}`)}`,
    `X-Amz-Date=${amzDate}`,
    'X-Amz-SignedHeaders=host',
  ].join('&');
  const canonical = `GET\n/mqtt\n${q}\nhost:${IOT_HOST}\n\nhost\n${sha('')}`;
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha(canonical)}`;
  let k = hmac('AWS4' + sk, date); k = hmac(k, REGION); k = hmac(k, service); k = hmac(k, 'aws4_request');
  const sig = createHmac('sha256', k).update(sts).digest('hex');
  return `wss://${IOT_HOST}/mqtt?${q}&X-Amz-Signature=${sig}&X-Amz-Security-Token=${encodeURIComponent(token)}`;
}

/** Read-only EDP Solar client. Emits 'values' and 'totals'. Never logs credentials or tokens. */
export class EdpClient extends EventEmitter {
  private idToken = '';
  private creds?: { ak: string; sk: string; token: string; exp: number };
  private client?: MqttClient;
  devices: Record<string, { type: string; role: Role; serial?: string; firmware?: string }> = {};
  houseId = '';
  values: Values = {};
  totals: Totals = {};
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private email: string, private password: string, private log: Logger) { super(); }

  private async login() {
    const idp = new CognitoIdentityProviderClient({ region: REGION });
    const sh = createHmac('sha256', CLIENT_SECRET).update(this.email + CLIENT_ID).digest('base64');
    const r = await idp.send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH', ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: this.email, PASSWORD: this.password, SECRET_HASH: sh },
    }));
    if (!r.AuthenticationResult?.IdToken) { throw new Error(`Login requires challenge: ${r.ChallengeName ?? 'unknown'}`); }
    this.idToken = r.AuthenticationResult.IdToken;
    const ci = new CognitoIdentityClient({ region: REGION });
    const Logins = { [`cognito-idp.${REGION}.amazonaws.com/${ID_USER_POOL}`]: this.idToken };
    const id = await ci.send(new GetIdCommand({ IdentityPoolId: IDENTITY_POOL_ID, Logins }));
    const c = await ci.send(new GetCredentialsForIdentityCommand({ IdentityId: id.IdentityId!, Logins }));
    const cr = c.Credentials!;
    this.creds = { ak: cr.AccessKeyId!, sk: cr.SecretKey!, token: cr.SessionToken!, exp: cr.Expiration?.getTime() ?? Date.now() + 3600e3 };
    this.log.info('EDP: login OK');
  }

  private async get(path: string) {
    const r = await fetch(API + path, { headers: { Authorization: this.idToken, 'Content-Type': 'application/json', 'User-Agent': 'okhttp/5.0.0-alpha.14' } });
    if (!r.ok) { throw new Error(`EDP API ${path} -> HTTP ${r.status}`); }
    return r.json() as Promise<any>;
  }

  private async discover() {
    const houses = await this.get('/houses');
    this.houseId = houses.houses[0].houseId;
    const devices = await this.get(`/houses/${this.houseId}/device`);
    await this.refreshModules(devices);
  }

  private async refreshModules(devices?: any[]) {
    devices = devices ?? await this.get(`/houses/${this.houseId}/device`);
    const mods = (await this.get(`/houses/${this.houseId}/modules`)).Modules ?? [];
    const byDev: Record<string, any> = {};
    for (const m of mods) { byDev[m.deviceId] = m; }
    const t: Totals = {};
    for (const d of devices!) {
      const m = byDev[d.deviceId] ?? {};
      const g: string[] = m.groups ?? [];
      const role: Role = g.includes('PRODUCTION_METER') ? 'PRODUCTION' : g.includes('CONSUMPTION_METER') ? 'GRID' : 'OTHER';
      this.devices[d.deviceLocalId] = { type: d.type, role, serial: m.serialNumber, firmware: d.firmwareVersion };
      const sv = m.stateVars ?? {};
      if (role === 'PRODUCTION') { t.producedWh = sv.totalActiveEnergyAminus?.value; }
      if (role === 'GRID') {
        t.fromGridWh = sv.totalActiveEnergyAplus?.value; t.injectedWh = sv.totalActiveEnergyAminus?.value;
        t.voltage = sv.voltage?.value;
      }
    }
    this.totals = t; this.emit('totals', t);
  }

  private connectMqtt() {
    this.client?.end(true);
    const c = this.creds!;
    const client = mqtt.connect(presignIotUrl(c.ak, c.sk, c.token), {
      clientId: randomUUID(), protocolVersion: 4, reconnectPeriod: 0, connectTimeout: 20000, keepalive: 60,
    });
    client.on('connect', () => {
      this.log.info('EDP: MQTT connected');
      for (const [lid, d] of Object.entries(this.devices)) {
        client.subscribe([`${d.type}/${lid}/fromDev/realtime`, `${d.type}/${lid}/fromDev/module/changed`], { qos: 1 });
      }
      this.requestRealtime();
    });
    client.on('message', (topic, buf) => this.onMessage(topic, buf));
    client.on('error', e => this.log.warn(`EDP: MQTT error: ${e.message}`));
    client.on('close', () => {
      if (this.stopped || this.client !== client) { return; }
      this.log.warn('EDP: MQTT closed, reconnecting in 15s');
      setTimeout(() => this.reconnect(), 15000);
    });
    this.client = client;
  }

  private async reconnect() {
    if (this.stopped) { return; }
    try {
      if (!this.creds || this.creds.exp - Date.now() < 10 * 60e3) { await this.login(); }
      this.connectMqtt();
    } catch (e: any) {
      this.log.error(`EDP: reconnect failed: ${e.message}; retry in 60s`);
      setTimeout(() => this.reconnect(), 60000);
    }
  }

  /** Same read-only 'realtime' stream request the EDP app sends; changes no settings. */
  private requestRealtime() {
    if (!this.client?.connected) { return; }
    for (const [lid, d] of Object.entries(this.devices)) {
      this.client.publish(`${d.type}/${lid}/toDev/realtime`, JSON.stringify({
        id: randomUUID(), operationType: 'realtime', messageType: 'request', data: { timeout: 60 },
      }), { qos: 1 });
    }
  }

  private onMessage(topic: string, buf: Buffer) {
    if (!topic.endsWith('/fromDev/realtime')) { return; }
    let p: any; try { p = JSON.parse(buf.toString()); } catch { return; }
    const sv = p?.data?.[0]?.stateVariables; if (!sv) { return; }
    const role = this.devices[topic.split('/')[1]]?.role;
    const v = this.values;
    if (role === 'GRID') {
      if (sv['emeter:power_aplus'] !== undefined) { v.fromGrid = sv['emeter:power_aplus']; }
      if (sv['emeter:power_aminus'] !== undefined) { v.injected = sv['emeter:power_aminus']; }
    } else if (role === 'PRODUCTION' && sv['emeter:power_aminus'] !== undefined) { v.produced = sv['emeter:power_aminus']; }
    const hasProd = Object.values(this.devices).some(d => d.role === 'PRODUCTION');
    if (v.fromGrid !== undefined && v.injected !== undefined && (v.produced !== undefined || !hasProd)) {
      v.consumed = Math.max(0, (v.produced ?? 0) + v.fromGrid - v.injected);
    }
    this.emit('values', { ...v });
  }

  async start() {
    await this.login();
    await this.discover();
    this.connectMqtt();
    this.timers.push(setInterval(() => this.requestRealtime(), 55e3));
    // Refresh credentials before the ~1h expiry, then reconnect MQTT with new signature
    this.timers.push(setInterval(async () => {
      if (this.creds && this.creds.exp - Date.now() < 15 * 60e3) {
        try { await this.login(); this.connectMqtt(); } catch (e: any) { this.log.error(`EDP: re-login failed: ${e.message}`); }
      }
    }, 60e3));
    this.timers.push(setInterval(() => this.refreshModules().catch(e => this.log.warn(`EDP: totals refresh failed: ${e.message}`)), 5 * 60e3));
  }

  stop() { this.stopped = true; this.timers.forEach(clearInterval); this.client?.end(true); }
}
