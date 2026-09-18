import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { loginRpcFailure } from './login-diagnostics.js';

export type Message = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};
export class PocError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Single-use connection: timeout/malformed data fail closed; never replay an RPC. */
export class Rpc {
  private nextId = 1;
  private pending = new Map<
    number,
    { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private events: Message[] = [];
  private eventBytes = 0;
  private listeners = new Set<() => void>();
  private consumers = new Set<(message: Message) => boolean>();
  private failure?: Error;
  private buffer = '';
  private decoder = new StringDecoder('utf8');

  constructor(
    private input: Writable,
    output: Readable,
    private maxLineBytes = 2 * 1024 * 1024,
  ) {
    output.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > this.maxLineBytes)
          return this.fail(new PocError('RPC_SIZE_LIMIT'));
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          return this.fail(new PocError('RPC_INVALID_JSON'));
        }
      }
      if (Buffer.byteLength(this.buffer) > this.maxLineBytes)
        this.fail(new PocError('RPC_SIZE_LIMIT'));
    });
    output.on('end', () => this.fail(new PocError('RPC_CLOSED')));
    output.on('error', () => this.fail(new PocError('RPC_IO_ERROR')));
    input.on('error', () => this.fail(new PocError('RPC_IO_ERROR')));
  }

  private receive(m: Message) {
    if (this.failure) return;
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error();
    if (typeof m.method === 'string') {
      if (m.id !== undefined) {
        this.send({ id: m.id, error: { code: -32601, message: 'Unsupported in judgment probe' } });
        this.fail(new PocError('UNEXPECTED_SERVER_REQUEST'));
        return;
      }
      // Deltas are display-only and can otherwise exhaust the bounded journal.
      for (const consumer of this.consumers) if (consumer(m)) return;
      if (m.method.endsWith('/delta')) return;
      this.eventBytes += Buffer.byteLength(JSON.stringify(m));
      if (this.events.length >= 4096 || this.eventBytes > 8 * 1024 * 1024) {
        this.fail(new PocError('EVENT_LIMIT'));
        return;
      }
      this.events.push(m);
      for (const listener of [...this.listeners]) listener();
      return;
    }
    if (typeof m.id !== 'number' || (!('result' in m) && !('error' in m))) throw new Error();
    const p = this.pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id);
    // Never propagate raw upstream error text (may contain tokens or prompts).
    if ('error' in m)
      p.reject(
        new PocError(
          (p.method === 'account/login/start' ? loginRpcFailure(m.error?.message) : undefined) ??
            `RPC_ERROR_${Number.isInteger(m.error?.code) ? m.error.code : 'UNKNOWN'}`,
        ),
      );
    else p.resolve(m.result);
  }

  private send(message: Message) {
    if (this.failure) throw this.failure;
    this.input.write(JSON.stringify(message) + '\n', (error) => {
      if (error) this.fail(new PocError('RPC_IO_ERROR'));
    });
  }

  notify(method: string, params: unknown = {}) {
    this.send({ method, params });
  }
  call(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new PocError('RPC_TIMEOUT')), timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch {
        this.fail(new PocError('RPC_IO_ERROR'));
      }
    });
  }

  cursor() {
    return this.events.length;
  }
  /** A dedicated thread can own its notifications outside the judgment journal. */
  consumeNotifications(consumer: (message: Message) => boolean) {
    this.consumers.add(consumer);
    return () => {
      this.consumers.delete(consumer);
    };
  }
  clearEventsIfIdle() {
    if (this.listeners.size || this.pending.size) return false;
    this.clearEvents();
    return true;
  }
  since(cursor: number) {
    return this.events.slice(cursor);
  }
  clearEvents() {
    if (this.listeners.size || this.pending.size) throw new PocError('RPC_NOT_IDLE');
    this.events = [];
    this.eventBytes = 0;
  }
  wait(
    cursor: number,
    predicate: (m: Message) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Message> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(new PocError('CANCELLED'));
      };
      const check = () => {
        if (this.failure) {
          cleanup();
          reject(this.failure);
          return;
        }
        const found = this.events.slice(cursor).find(predicate);
        if (found) {
          cleanup();
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PocError('EVENT_TIMEOUT'));
      }, timeoutMs);
      this.listeners.add(check);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      check();
    });
  }
  fail(error = new PocError('RPC_CLOSED')) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const listener of [...this.listeners]) listener();
  }
}
