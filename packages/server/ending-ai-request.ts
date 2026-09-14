import { z } from 'zod';
import { responseRequest } from './openai.js';

const text = z.object({ type: z.literal('input_text'), text: z.string().max(128 * 1024) }).strict();
const image = z
  .object({
    type: z.literal('input_image'),
    image_url: z
      .string()
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/)
      .refine((v) => Buffer.byteLength(v.slice(23), 'base64') <= 1024 * 1024),
    detail: z.enum(['low', 'high', 'auto']).optional(),
  })
  .strict();

/** Separate scope: ordinary game Responses retain their smaller contract. */
export const endingResponseRequest = z
  .object({
    model: z.string().max(100),
    instructions: z.string().max(16000),
    input: z
      .array(
        z
          .object({
            role: z.literal('user'),
            content: z
              .array(z.union([text, image]))
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .length(1),
    text: responseRequest.shape.text,
    store: z.literal(false),
    max_output_tokens: z.number().int().min(1).max(4096),
  })
  .strict()
  .refine((v) => v.input[0].content.filter((c) => c.type === 'input_image').length <= 2)
  .refine(
    (v) =>
      v.input[0].content.reduce(
        (n, c) => n + (c.type === 'input_text' ? Buffer.byteLength(c.text) : 0),
        0,
      ) <=
      128 * 1024,
  );

export const endingImageRequest = z
  .object({
    model: z.string(),
    prompt: z.string().min(1).max(16000),
    images: z
      .array(
        z.instanceof(Buffer).refine((b) => b.length <= 1024 * 1024 && b[0] === 255 && b[1] === 216),
      )
      .min(1)
      .max(2),
    n: z.literal(1),
    size: z.literal('1024x1024'),
    quality: z.literal('low'),
    output_format: z.literal('jpeg'),
  })
  .strict();

export type EndingCallKind = 'extraction' | 'story' | 'direction' | 'frame' | 'inspection';
