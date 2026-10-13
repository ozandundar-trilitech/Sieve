import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Per-user shell preferences. Nothing secret lives here. */
export interface Prefs {
  /** Show a notification when Sieve blocks an agent request. */
  notifyBlocked: boolean;
}

const DEFAULTS: Prefs = { notifyBlocked: true };

const file = (): string => join(app.getPath('userData'), 'preferences.json');

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), 'utf8')) as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    writeFileSync(file(), JSON.stringify(p, null, 2), { mode: 0o600 });
  } catch {
    /* preferences are best-effort */
  }
}
