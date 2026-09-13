import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { LiveCommand, PublicGameState } from '../../packages/shared/game.js';
const base = { event_id: z.string().min(1).max(200) };
const transcript = (type: 'session.input_transcript.delta' | 'session.output_transcript.delta') =>
  z
    .object({
      ...base,
      type: z.literal(type),
      delta: z.string().max(4000),
      start_ms: z.number().nonnegative(),
      end_ms: z.number().nonnegative(),
    })
    .strict();
export const liveEventSchema = z.union([
  transcript('session.input_transcript.delta'),
  transcript('session.output_transcript.delta'),
  z
    .object({
      ...base,
      type: z.literal('session.delegation.created'),
      offset_ms: z.number().nonnegative(),
      delegation: z
        .object({
          id: z.string().min(1).max(200),
          type: z.literal('delegation'),
          target: z.literal('client'),
        })
        .strict(),
    })
    .strict(),
]);
export function liveInstructions(state: PublicGameState, snapshot?: ScenarioSnapshot) {
  if (snapshot)
    return [
      'あなたは未来で閉じ込められた相手。選択言語で短く自然に会話する。写真自体は見えない。サーバーから届く道具の認識と確定状態だけを事実として使う。',
      '導入ではアプリの最初の呼びかけを待つ。返事が来たら状況を短く説明し、写真を送ると道具として使えると伝える。写真受信通知後に「これをどう使う？」と聞く。準備ができたら画面のプレイ開始で本編に入る。',
      '本編の用途相談や実行指示、訂正の判断が必要ならclientへ委譲する。委譲は作業依頼であり、行動成功を確定しない。復唱や確認の質問、実行ボタンは挟まない。指示を受け付けた時の「やってみる」と結果の発話はアプリのcommentary通知に任せ、重ねて同じ相づちを話さない。',
      '途中の間や未完の発言で勝手に行動しない。質問と指示を区別する。判定中も会話できるが次の行動は予約せず、現在の結果後に指示を改めてもらう。攻略ヒントは尋ねられたときだけ段階的に出す。特殊能力を付与しない。',
      snapshot.coreConfig.conversation[snapshot.locale].liveInstructions,
      JSON.stringify({
        locale: snapshot.locale,
        status: state.status,
        title: state.title,
        briefing: state.briefing,
        situation: state.situation,
        inventory: state.inventory.map((i) => ({ name: i.name, status: i.status })),
      }),
    ].join('\n');
  return `あなたは未来で脱出を試みる相手。日本語で短く臨場感を持って話す。写真は直接見えない。道具と用途はlocalからの検証済み更新だけを参照する。相談では行動の成功・失敗・消費を確定しない。ユーザーの明示実行ボタン後だけ結果が確定する。魔法の能力は付与しない。導入ではアプリからの最初の呼びかけ指示を待つ。相手が先に話したら自然に応答する。briefing中はチュートリアルで時計はまだ進まない。最初は「聞こえる…？」と短く呼びかけ、返事を待つ。返事が来たら閉じ込められた状況を一息で説明し、身近な物の写真を送るとこちらで道具として使える、と伝える。次に画面の「撮影」で1枚送ってもらい、どう使えそうか声で聞く。一度に一つだけ依頼して返事を待つ。長いルール説明や正解の先回りはしない。認識が違えば声で訂正できること、準備できたら「状況を聞いたら、プレイ開始」、その後「この使い方で実行」を押すまでは行動を消費しないことを順に案内する。プレイ開始や時計・行動の変更を台詞だけで確定しない。playing中は導入を繰り返さない。現在の公開事実: ${JSON.stringify({ status: state.status, title: state.title, briefing: state.briefing.slice(0, 1200), situation: state.situation, inventory: state.inventory.map((i) => ({ name: i.name.slice(0, 80), status: i.status })), proposal: state.proposal ? { summary: state.proposal.summary.slice(0, 300) } : null })}`;
}
export function factCommand(content: string, delegationId: string | null = null): LiveCommand {
  return {
    type: 'session.thinking.append',
    event_id: randomUUID(),
    delegation_id: delegationId,
    content: limitLiveContent(content),
  };
}

// A UTF-8 byte ceiling is conservative for the provider's 500-token limit.
function limitLiveContent(content: string) {
  let result = '',
    bytes = 0;
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > 480) break;
    result += char;
    bytes += size;
  }
  return result;
}

export function openingCommand(
  state: PublicGameState,
  locale: 'ja' | 'en' = 'ja',
): LiveCommand | null {
  if (state.status !== 'briefing') return null;
  return {
    ...factCommand(
      locale === 'en'
        ? 'Open the call by saying: Can you hear me? I’m trapped here. If you can hear my voice, please answer. Then wait for their reply.'
        : '最初の呼びかけです。「聞こえる…？ よかった、誰かにつながった。閉じ込められているんだ。声が届いていたら、返事をしてくれる？」と短く話し、返事を待ってください。',
    ),
    type: 'session.commentary.append',
  };
}
