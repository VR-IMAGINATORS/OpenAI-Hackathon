import WebSocket from 'ws';
import { z } from 'zod';

export const liveSessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const sessionClosedEvent = z
  .object({
    type: z.literal('session.closed'),
    event_id: z.string().min(1).max(1024),
    reason: z.enum(['close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost']),
    session: z.object({ id: liveSessionId }).passthrough(),
    usage: z.object({ seconds: z.number().finite().nonnegative() }).passthrough(),
    client_event_id: z.string().max(1024).optional(),
  })
  .passthrough();

const MAX_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 120_000;

export interface LiveSidebandSocket {
  readonly readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number): void;
  terminate(): void;
}

export interface LiveSidebandConnectOptions {
  headers: { Authorization: string };
  handshakeTimeout: number;
  maxPayload: number;
  perMessageDeflate: false;
}

export type LiveSidebandConnector = (
  url: string,
  options: LiveSidebandConnectOptions,
) => LiveSidebandSocket;

export interface LiveSidebandOptions {
  connector?: LiveSidebandConnector;
  closeTimeoutMs?: number;
  observationTimeoutMs?: number;
  maxSessions?: number;
  now?: () => number;
}

interface Connection {
  socket: LiveSidebandSocket;
  ready: Promise<void>;
  ended: Promise<void>;
}

interface SessionEntry {
  id: string;
  confirmed: boolean;
  observationDeadline?: number;
  observationTimer?: ReturnType<typeof setTimeout>;
  confirmation: Promise<void>;
  confirm: () => void;
  connection?: Connection;
  closeAttempt?: Promise<void>;
}

export interface LiveSidebandReservation {
  track(id: string): void;
  release(): void;
}

export class LiveSidebandError extends Error {
  constructor() {
    super('Live session finalization was not confirmed');
  }
}

function defaultConnector(url: string, options: LiveSidebandConnectOptions): LiveSidebandSocket {
  return new WebSocket(url, options) as unknown as LiveSidebandSocket;
}

function messageBytes(value: unknown): Buffer | undefined {
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(Buffer.isBuffer)) return Buffer.concat(value);
  return undefined;
}

/**
 * Tracks the trusted sideband for each WebRTC Live session. It intentionally ignores all
 * conversation and audio events; only a schema-valid session.closed for the attached ID is kept.
 */
export class LiveSidebandManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connector: LiveSidebandConnector;
  private readonly closeTimeoutMs: number;
  private readonly observationTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private reserved = 0;

  constructor(
    private readonly apiKey: string,
    options: LiveSidebandOptions = {},
  ) {
    this.connector = options.connector ?? defaultConnector;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.observationTimeoutMs = options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1)
      throw new Error('Invalid Live sideband session limit');
    if (!Number.isSafeInteger(this.closeTimeoutMs) || this.closeTimeoutMs < 1)
      throw new Error('Invalid Live sideband close timeout');
    if (
      !Number.isSafeInteger(this.observationTimeoutMs) ||
      this.observationTimeoutMs < this.closeTimeoutMs
    )
      throw new Error('Invalid Live sideband observation timeout');
  }

  /** Reserve bounded tracking capacity before creating a billable upstream session. */
  reserve(): LiveSidebandReservation {
    // Keep finalization evidence until its owner consumes it, even after a long idle period.
    if (this.sessions.size + this.reserved >= this.maxSessions) throw new LiveSidebandError();
    this.reserved++;
    let active = true;
    return {
      track: (id) => {
        if (!active) throw new LiveSidebandError();
        active = false;
        this.reserved--;
        this.track(id);
      },
      release: () => {
        if (!active) return;
        active = false;
        this.reserved--;
      },
    };
  }

  isClosed(id: string): boolean {
    return this.sessions.get(id)?.confirmed === true;
  }

  releaseClosed(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry?.confirmed) return;
    clearTimeout(entry.observationTimer);
    this.sessions.delete(id);
  }

  async hangup(id: string): Promise<void> {
    const validId = liveSessionId.parse(id);
    const entry = this.sessions.get(validId);
    if (!entry) throw new LiveSidebandError();
    if (entry.confirmed) return;
    if (entry.closeAttempt) return entry.closeAttempt;
    const attempt = this.close(entry);
    entry.closeAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (entry.closeAttempt === attempt) entry.closeAttempt = undefined;
    }
  }

  private track(id: string): void {
    const validId = liveSessionId.parse(id);
    let entry = this.sessions.get(validId);
    if (entry) throw new LiveSidebandError();
    {
      let confirm!: () => void;
      const confirmation = new Promise<void>((resolve) => {
        confirm = resolve;
      });
      entry = { id: validId, confirmed: false, confirmation, confirm };
      this.sessions.set(validId, entry);
    }
    // Attach synchronously after the HTTP response is parsed, before returning it to the browser.
    try {
      this.connect(entry);
    } catch {
      // The known session ID remains tracked so hangup can retry attachment later.
    }
  }

  private connect(entry: SessionEntry): Connection {
    if (entry.connection && entry.connection.socket.readyState < 2) return entry.connection;
    let socket: LiveSidebandSocket;
    try {
      socket = this.connector(
        `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(entry.id)}/attach`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          handshakeTimeout: Math.min(this.closeTimeoutMs, 10_000),
          maxPayload: MAX_EVENT_BYTES,
          perMessageDeflate: false,
        },
      );
    } catch {
      throw new LiveSidebandError();
    }

    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    let endedResolve!: () => void;
    let opened = socket.readyState === 1;
    let ended = false;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // Eager attachment may fail before hangup observes it. Keep that expected failure handled;
    // later callers still receive the rejection when they await the original promise.
    void ready.catch(() => {});
    const endedPromise = new Promise<void>((resolve) => {
      endedResolve = resolve;
    });
    const connection: Connection = { socket, ready, ended: endedPromise };
    entry.connection = connection;

    const end = () => {
      if (ended) return;
      ended = true;
      if (!opened) readyReject(new LiveSidebandError());
      endedResolve();
      if (entry.connection === connection) entry.connection = undefined;
    };
    socket.on('open', () => {
      if (opened || ended) return;
      opened = true;
      readyResolve();
    });
    socket.on('error', end);
    socket.on('close', end);
    socket.on('message', (raw) => this.receive(entry!, connection, raw));
    if (opened) readyResolve();
    return connection;
  }

  private receive(entry: SessionEntry, connection: Connection, raw: unknown): void {
    if (entry.connection !== connection) return;
    const bytes = messageBytes(raw);
    if (!bytes || bytes.byteLength > MAX_EVENT_BYTES) {
      connection.socket.terminate();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      return;
    }
    const event = sessionClosedEvent.safeParse(value);
    if (!event.success || event.data.session.id !== entry.id || entry.confirmed) return;
    entry.confirmed = true;
    clearTimeout(entry.observationTimer);
    entry.confirm();
    connection.socket.close(1000);
  }

  private async close(entry: SessionEntry): Promise<void> {
    if (entry.confirmed) return;
    // A caller timeout must not discard a subsequent trusted finalization event. Observe
    // for a bounded period starting with the first close; retries cannot extend this limit.
    if (entry.observationDeadline === undefined) {
      entry.observationDeadline = this.now() + this.observationTimeoutMs;
      entry.observationTimer = setTimeout(() => {
        if (!entry.confirmed) entry.connection?.socket.terminate();
      }, this.observationTimeoutMs);
      entry.observationTimer.unref();
    }
    if (this.now() >= entry.observationDeadline) throw new LiveSidebandError();
    const connection = this.connect(entry);
    const deadline = Math.min(this.now() + this.closeTimeoutMs, entry.observationDeadline);
    try {
      await this.until(connection.ready, connection, deadline);
      if (entry.confirmed) return;
      await this.until(
        new Promise<void>((resolve, reject) => {
          try {
            connection.socket.send(JSON.stringify({ type: 'session.close' }), (error) =>
              error ? reject(new LiveSidebandError()) : resolve(),
            );
          } catch {
            reject(new LiveSidebandError());
          }
        }),
        connection,
        deadline,
      );
      await this.until(entry.confirmation, connection, deadline);
      if (!entry.confirmed) throw new LiveSidebandError();
    } catch {
      if (entry.confirmed) return;
      throw new LiveSidebandError();
    }
  }

  private async until(
    operation: Promise<void>,
    connection: Connection,
    deadline: number,
  ): Promise<void> {
    const remaining = Math.max(0, deadline - this.now());
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LiveSidebandError()), remaining);
    });
    const disconnected = connection.ended.then(() => {
      throw new LiveSidebandError();
    });
    try {
      await Promise.race([operation, disconnected, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
