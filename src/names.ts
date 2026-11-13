import { readFileSync } from 'fs';
import { join } from 'path';

export const PLUGIN_NAME = 'homebridge-edp-ready-integration';
export const PLATFORM_NAME = 'EdpSolar';

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
export const PLUGIN_VERSION = readVersion();

export type MeterKey = 'consumed' | 'produced' | 'fromGrid' | 'injected';

/** Default (English) accessory names, used only for accessories created for the first time. */
export const DEFAULT_NAMES: Record<MeterKey, string> = {
  consumed: 'Home Consumption',
  produced: 'Solar Production',
  fromGrid: 'Grid Import',
  injected: 'Grid Export',
};

/**
 * Make a string a valid HomeKit name: letters, numbers, spaces, apostrophes, hyphens,
 * periods and commas only, starting and ending with a letter or number.
 */
export function sanitizeName(name: unknown): string | undefined {
  if (typeof name !== 'string') { return undefined; }
  const clean = name
    .replace(/[^\p{L}\p{N} '’.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
  return clean.length ? clean.slice(0, 64) : undefined;
}

/**
 * Name precedence: explicit config override > existing (cached) name > English default.
 * Keeping the cached name means upgrading never renames accessories the user already has.
 */
export function resolveName(key: MeterKey, configured: unknown, cachedName?: string): string {
  return sanitizeName(configured) ?? sanitizeName(cachedName) ?? DEFAULT_NAMES[key];
}
