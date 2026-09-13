import { z } from 'zod';
const liveId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const liveRequest = z
  .object({
    session: z
      .object({
        model: z.string().max(100),
        instructions: z.string().max(8000),
        delegation: z.object({ type: z.literal('client') }).strict(),
        store: z.literal(false),
      })
      .strict(),
    transport: z.object({ type: z.literal('webrtc'), sdp: z.string().min(1).max(100000) }).strict(),
  })
  .strict();
export const liveAnswer = z
  .object({
    session: z.object({ id: liveId }).passthrough(),
    transport: z
      .object({ type: z.literal('webrtc'), sdp: z.string().min(1).max(200000) })
      .passthrough(),
  })
  .passthrough();
const image = z
  .object({
    type: z.literal('input_image'),
    image_url: z
      .string()
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/)
      .refine((v) => Buffer.byteLength(v.slice(23), 'base64') <= 2 * 1024 * 1024),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  })
  .strict();
const inputText = z.object({ type: z.literal('input_text'), text: z.string().max(16000) }).strict();
export const responseRequest = z
  .object({
    model: z.string().max(100),
    instructions: z.string().max(16000),
    input: z
      .array(
        z
          .object({
            role: z.literal('user'),
            content: z
              .array(z.union([inputText, image]))
              .min(1)
              .max(10),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    text: z
      .object({
        format: z
          .object({
            type: z.literal('json_schema'),
            name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            strict: z.literal(true),
            schema: z
              .record(z.string(), z.unknown())
              .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 16384),
          })
          .strict(),
      })
      .strict(),
    store: z.literal(false),
    max_output_tokens: z.number().int().positive().max(1000),
  })
  .strict()
  .refine(
    (v) => v.input.flatMap((i) => i.content).filter((i) => i.type === 'input_image').length <= 2,
  )
  .refine(
    (v) =>
      v.input
        .flatMap((i) => i.content)
        .reduce((n, i) => n + (i.type === 'input_text' ? i.text.length : 0), 0) <= 16000,
  );
export interface OpenAITransport {
  createLiveSession(body: unknown): Promise<z.infer<typeof liveAnswer>>;
  createResponse(body: unknown): Promise<unknown>;
  hangup(id: string): Promise<void>;
}
export class UpstreamError extends Error {
  constructor(public readonly status: number) {
    super('Upstream request failed');
  }
}
export function createOpenAITransport(
  apiKey: string,
  request: typeof fetch = fetch,
): OpenAITransport {
  async function post(path: string, body: unknown, empty = false): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const result = await request('https://api.openai.com/v1/' + path, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!result.ok) {
        await result.body?.cancel();
        throw new UpstreamError(result.status === 429 ? 429 : 502);
      }
      if (empty) {
        await result.body?.cancel();
        return;
      }
      const reader = result.body?.getReader();
      if (!reader) throw new UpstreamError(502);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 256 * 1024) {
          await reader.cancel();
          throw new UpstreamError(502);
        }
        chunks.push(item.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    createLiveSession: async (body) => liveAnswer.parse(await post('live/sessions', body)),
    createResponse: (body) => post('responses', body),
    hangup: async (id) => {
      liveId.parse(id);
      await post('live/sessions/' + encodeURIComponent(id) + '/hangup', {}, true);
    },
  };
}
