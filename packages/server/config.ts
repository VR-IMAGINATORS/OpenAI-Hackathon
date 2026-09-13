import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { parse } from 'dotenv';

export function readEnvironment(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parse(readFileSync(resolve(cwd, file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Environment file could not be read: ' + file);
  }
  return { ...fileValues, ...env };
}
export function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = 1_000_000,
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(name + ' must be a positive integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new Error(name + ' is out of range');
  return number;
}
export function bindHost(value: string | undefined, name: string): string {
  const host = value ?? '127.0.0.1';
  if (!isIP(host) && host !== 'localhost')
    throw new Error(name + ' must be an IP address or localhost');
  return host;
}
export function allowedHosts(value: string | undefined, defaults: string[]): Set<string> {
  if (value === undefined) return new Set(defaults);
  const entries = value.split(',').map((s) => s.trim());
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL('http://' + entry);
    } catch {
      throw new Error('APP_ALLOWED_HOSTS must contain exact hosts with optional ports');
    }
    if (
      !entry ||
      /[\s\/@?#\\*]/.test(entry) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.host !== entry.toLowerCase()
    ) {
      throw new Error('APP_ALLOWED_HOSTS must contain exact hosts with optional ports');
    }
  }
  return new Set(entries.map((s) => s.toLowerCase()));
}
export function allowedOrigins(value: string | undefined, defaults: string[]): Set<string> {
  if (value === undefined) return new Set(defaults);
  const entries = value.split(',').map((s) => s.trim());
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error('APP_ALLOWED_ORIGINS must contain exact HTTP or HTTPS origins');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== entry ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('APP_ALLOWED_ORIGINS must contain exact HTTP or HTTPS origins');
    }
  }
  return new Set(entries);
}
