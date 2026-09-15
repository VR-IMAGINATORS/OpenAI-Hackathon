import type { LiveCommand } from '../../packages/shared/game.js';
import { liveOutboxEntrySchema, type CoreLiveCommand } from '../../packages/shared/conversation.js';

export interface CommandBatch {
  generation: number;
  serverNow: number;
  controlEpoch: number;
  acknowledgedThrough: number;
  commands: CoreLiveCommand[];
}

export class LiveOutboxError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

const MAX_COMMANDS = 128;
const MAX_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 480;

/** A bounded connection history. Acknowledgment means sent, never heard. */
export class LiveOutbox {
  private commands: CoreLiveCommand[] = [];
  private bytes = 0;
  private acknowledgedThrough = 0;
  private generation: number;
  private controllerEpoch: number;

  constructor(
    generation = 1,
    controllerEpoch = 0,
    private wallNow: () => number = Date.now,
    private limits = { maxCommands: MAX_COMMANDS, maxBytes: MAX_BYTES },
  ) {
    this.validateConnection(generation, controllerEpoch);
    this.generation = generation;
    this.controllerEpoch = controllerEpoch;
  }

  get latestSeq() {
    return this.commands.length;
  }
  get hasUnacknowledgedSpeech() {
    return this.commands.some(
      (command) =>
        command.seq > this.acknowledgedThrough && command.type === 'session.commentary.append',
    );
  }

  append(
    command: LiveCommand,
    messageId: string | null = null,
    warning?: { validUntil: number; noticeKind: 'time-warning' },
  ): CoreLiveCommand {
    const parsed = liveOutboxEntrySchema.safeParse({
      seq: this.latestSeq + 1,
      eventId: command.event_id,
      generation: this.generation,
      controllerEpoch: this.controllerEpoch,
      delegationId: command.delegation_id,
      commandType: command.type,
      content: command.content,
      messageId,
      ...warning,
    });
    if (!parsed.success || Buffer.byteLength(command.content, 'utf8') > MAX_CONTENT_BYTES) {
      // Reject rather than truncate a result: callers can use factCommand's safe limiter.
      throw new LiveOutboxError(400, 'LIVE_COMMAND_INVALID');
    }
    const previous = this.commands.find((entry) => entry.event_id === command.event_id);
    if (previous) {
      if (
        previous.type !== command.type ||
        previous.delegation_id !== command.delegation_id ||
        previous.content !== command.content ||
        previous.messageId !== messageId ||
        previous.validUntil !== warning?.validUntil ||
        previous.noticeKind !== warning?.noticeKind
      ) {
        throw new LiveOutboxError(409, 'LIVE_COMMAND_CONFLICT');
      }
      return { ...previous };
    }
    const size = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
    if (
      this.commands.length >= this.limits.maxCommands ||
      this.bytes + size > this.limits.maxBytes
    ) {
      throw new LiveOutboxError(409, 'LIVE_OUTBOX_FULL');
    }
    const entry: CoreLiveCommand = {
      seq: parsed.data.seq,
      event_id: parsed.data.eventId,
      type: parsed.data.commandType,
      delegation_id: parsed.data.delegationId,
      content: parsed.data.content,
      messageId: parsed.data.messageId,
      ...(warning
        ? { validUntil: parsed.data.validUntil, noticeKind: parsed.data.noticeKind }
        : {}),
    };
    this.commands.push(entry);
    this.bytes += size;
    return { ...entry };
  }

  poll(generation: number, controllerEpoch: number, ackThrough: number): CommandBatch {
    this.assertConnection(generation, controllerEpoch);
    if (!Number.isSafeInteger(ackThrough) || ackThrough < 0 || ackThrough > this.latestSeq) {
      throw new LiveOutboxError(400, 'LIVE_ACK_INVALID');
    }
    if (ackThrough !== 0 && ackThrough < this.acknowledgedThrough) {
      throw new LiveOutboxError(409, 'LIVE_ACK_REGRESSION');
    }
    // Zero explicitly requests replay; it does not roll back the acknowledged watermark.
    this.acknowledgedThrough = Math.max(this.acknowledgedThrough, ackThrough);
    return {
      generation: this.generation,
      serverNow: this.wallNow(),
      controlEpoch: this.controllerEpoch,
      acknowledgedThrough: this.acknowledgedThrough,
      commands: this.commands
        .filter((entry) => entry.seq > ackThrough)
        .map((entry) => ({ ...entry })),
    };
  }

  reset(generation: number, controllerEpoch: number): void {
    this.validateConnection(generation, controllerEpoch);
    if (generation < this.generation || controllerEpoch < this.controllerEpoch) {
      throw new LiveOutboxError(409, 'LIVE_CONNECTION_STALE');
    }
    if (generation === this.generation && controllerEpoch === this.controllerEpoch) return;
    this.generation = generation;
    this.controllerEpoch = controllerEpoch;
    this.commands = [];
    this.bytes = 0;
    this.acknowledgedThrough = 0;
  }

  private assertConnection(generation: number, controllerEpoch: number) {
    if (generation !== this.generation || controllerEpoch !== this.controllerEpoch) {
      throw new LiveOutboxError(409, 'LIVE_CONNECTION_STALE');
    }
  }

  private validateConnection(generation: number, controllerEpoch: number) {
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(controllerEpoch) ||
      controllerEpoch < 0
    ) {
      throw new LiveOutboxError(400, 'LIVE_CONNECTION_INVALID');
    }
  }
}
