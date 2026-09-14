import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runRecordSchema, type RunRecord } from './schemas.js';

/** Only a newly created UUID directory can receive checkpoints. */
export class RunStore {
  private constructor(readonly directory: string) {}
  static async create(root = resolve('runs/auto-mission')): Promise<RunStore> {
    await mkdir(root, { recursive: true });
    const directory = join(root, randomUUID());
    await mkdir(directory);
    return new RunStore(directory);
  }
  async save(record: RunRecord): Promise<void> {
    const json = JSON.stringify(runRecordSchema.parse(record), null, 2) + '\n';
    const temporary = join(this.directory, `run-${randomUUID()}.tmp`);
    await writeFile(temporary, json, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, join(this.directory, 'run.json'));
  }
  async report(html: string): Promise<void> {
    const temporary = join(this.directory, `report-${randomUUID()}.tmp`);
    await writeFile(temporary, html, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, join(this.directory, 'report.html'));
  }
}
export async function readRun(path: string): Promise<RunRecord> {
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('Saved run exceeds 16 MiB');
  return runRecordSchema.parse(JSON.parse(raw));
}
