/** Speech-only projection. Never write it back to game facts, UI, or transcripts. */
const readings: ReadonlyArray<readonly [string, string]> = [
  ['反時計回り', 'はんとけいまわり'],
  ['連結金具', 'れんけつかなぐ'],
  ['受け金具', 'うけかなぐ'],
  ['引き輪', 'ひきわ'],
  ['内扉', 'うちとびら'],
  ['留め具', 'とめぐ'],
  ['蝶番', 'ちょうつがい'],
  ['具現化', 'ぐげんか'],
  ['退避路', 'たいひろ'],
  ['格子', 'こうし'],
  ['閂', 'かんぬき'],
];

export function liveSpeechText(text: string): string {
  for (const [written, spoken] of readings) text = text.replaceAll(written, spoken);
  // Remove legacy delivery directions only at the speech boundary; keep world facts intact.
  return text
    .replaceAll(
      '落ち着いた敬体で短く話し、成功した工夫に具体的に応答する。',
      '成功した工夫に具体的に応答する。',
    )
    .replaceAll(
      'Speak briefly, calmly and politely; respond specifically to successful ideas.',
      'Respond specifically to successful ideas.',
    );
}
