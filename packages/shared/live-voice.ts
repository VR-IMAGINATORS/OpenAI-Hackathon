/** API voice names documented for GPT-Live. Voice changes require a new session. */
export const liveVoices = [
  'marin',
  'gleam',
  'quartz',
  'ripple',
  'vesper',
  'willow',
  'stone',
  'meridian',
  'bossa',
  'tempo',
  'beacon',
  'delta',
  'cinder',
] as const;
export const defaultLiveVoice = 'gleam';
export type LiveVoice = (typeof liveVoices)[number];
