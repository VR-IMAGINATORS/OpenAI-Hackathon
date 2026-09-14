/** Player-readable failure category; provider payloads and credentials are never shown. */
export function endingErrorText(code: string | null, locale: 'ja' | 'en'): string | null {
  if (!code) return null;
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  if (code === 'ENDING_BUDGET_EXHAUSTED')
    return t('動画生成の回数上限に達しました。', 'The video generation limit has been reached.');
  if (code === 'ENDING_AI_BUDGET_EXHAUSTED')
    return t(
      '物語や画像を作るAIの利用上限に達しました。',
      'The AI limit for story or image generation has been reached.',
    );
  if (code === 'ENDING_QUEUE_FULL')
    return t(
      '動画生成が混み合っているため、受付できませんでした。',
      'The video generation queue was full.',
    );
  if (/^ENDING_[A-Z_]+_HTTP_(401|403)$/.test(code))
    return t(
      '生成サービスの認証・利用権限を確認できませんでした。',
      'The generation service could not authorize the request.',
    );
  if (/^ENDING_[A-Z_]+_HTTP_429$/.test(code))
    return t(
      '生成サービスの利用上限により処理できませんでした。',
      'The generation service rejected the request due to a usage limit.',
    );
  if (code.startsWith('ENDING_REFERENCE_'))
    return t(
      'プレイ終了時点で、動画の元に使える完成済みの場面画像がありませんでした。',
      'No completed scene image was available for the video when the game ended.',
    );
  if (code.startsWith('ENDING_STORY_'))
    return t(
      'このプレイのタグ・結末文を作る段階で失敗しました。',
      'The story and tag for this play could not be prepared.',
    );
  if (code.startsWith('ENDING_DIRECTION_'))
    return t('動画の演出を作る段階で失敗しました。', 'The video direction could not be prepared.');
  if (code.startsWith('ENDING_START_FRAME_'))
    return t(
      '動画の開始画像を作る段階で失敗しました。',
      'The starting image could not be created.',
    );
  if (code.startsWith('ENDING_END_FRAME_'))
    return t('動画の終了画像を作る段階で失敗しました。', 'The ending image could not be created.');
  if (code.startsWith('ENDING_START_INSPECTION_') || code.startsWith('ENDING_END_INSPECTION_'))
    return t(
      '開始・終了画像の内容を確認できませんでした。',
      'The starting or ending image could not pass its content check.',
    );
  if (code === 'ENDING_VIDEO_SUBMIT_UNCONFIRMED')
    return t(
      '動画生成サービスへの依頼結果を確認できませんでした。',
      'The video generation request could not be confirmed.',
    );
  if (code.startsWith('ENDING_VIDEO_SUBMIT_'))
    return t(
      '動画生成サービスが依頼を受け付けませんでした。',
      'The video generation service did not accept the request.',
    );
  if (code === 'ENDING_VIDEO_INVALID_MEDIA')
    return t(
      '生成された動画の形式・長さ・音声を確認できませんでした。',
      'The generated video did not pass its format, duration or audio check.',
    );
  if (code.startsWith('ENDING_VIDEO_'))
    return t(
      '動画生成サービスから完成動画を受け取れませんでした。',
      'The finished video could not be received from the generation service.',
    );
  if (code.startsWith('ENDING_STORAGE_'))
    return t(
      '動画を保持する空き容量がありませんでした。',
      'There was not enough capacity to retain the video.',
    );
  return null;
}
