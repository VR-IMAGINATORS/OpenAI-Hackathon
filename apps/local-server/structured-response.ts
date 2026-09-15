import { aiFailureCode, canRetryJudgment } from './ai-failure.js';

// Reasoning and final JSON share this budget. Keep repair bounded but give it
// more room than the request which just ran out of output tokens.
export const gameOutputTokens = 2048;
export const gameRepairTokens = 4096;

export function responseText(value: any): string {
  if (
    value?.incomplete_details?.reason === 'content_filter' ||
    (Array.isArray(value?.output) &&
      value.output.some(
        (item: any) =>
          Array.isArray(item?.content) &&
          item.content.some((part: any) => part?.type === 'refusal'),
      ))
  )
    throw new Error('AI_OUTPUT_REFUSED');
  if (value?.status === 'incomplete') throw new Error('AI_OUTPUT_INCOMPLETE');
  if (value?.status !== undefined && value.status !== 'completed')
    throw new Error('AI_OUTPUT_INVALID');
  if (!Array.isArray(value?.output)) throw new Error('AI_OUTPUT_INVALID');
  const texts = value.output.flatMap((item: any) =>
    item?.type === 'message' && Array.isArray(item.content)
      ? item.content
          .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
          .map((part: any) => part.text)
      : [],
  );
  if (texts.length !== 1) throw new Error('AI_OUTPUT_INVALID');
  return texts[0];
}

/** Retries only read/parse work. The caller commits effects after this returns. */
export async function structuredResponse<T>(
  respond: (body: unknown) => Promise<unknown>,
  body: { instructions: string; max_output_tokens: number; [key: string]: unknown },
  parse: (value: unknown) => T,
  retry = true,
): Promise<T> {
  let request = body;
  for (let attempt = 0; ; attempt++) {
    try {
      return parse(JSON.parse(responseText(await respond(request))));
    } catch (error) {
      if (!retry || attempt >= 1 || !canRetryJudgment(error)) throw error;
      request = {
        ...body,
        max_output_tokens: gameRepairTokens,
        instructions:
          body.instructions +
          '\nThe previous response failed validation (' +
          aiFailureCode(error) +
          '). Return one complete concise JSON object matching the schema. ' +
          'Use the same supplied evidence. No action or result was committed by that response.',
      };
    }
  }
}
