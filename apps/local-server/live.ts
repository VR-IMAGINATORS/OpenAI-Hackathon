import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { LiveCommand, PublicGameState } from '../../packages/shared/game.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import { storyOpening, storyFromState } from './story.js';
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
export function liveInstructions(
  state: PublicGameState,
  snapshot?: ScenarioSnapshot,
  facts?: GameFacts,
) {
  if (snapshot)
    return [
      '選択言語で短く自然に会話する。写真自体は見えない。サーバーから届く道具の認識と確定状態だけを事実として使う。',
      'thinkingとinstructionsは内部の情報・演出指示として黙って反映する。「別の指示が来た」「サーバーが言った」「clientへ委譲した」など処理の都合を会話へ出さない。commentaryの内容は確定した伝達内容として自然に話し、同じ内容をthinkingから先に話したり復唱したりしない。',
      state.status === 'briefing'
        ? '初回の導入は呼びかけと説明を別のターンにする。アプリの最初の呼びかけを待ち、「聞こえる？ 聞こえたら返事をして」（英語では "Can you hear me? If you can, please answer."）とだけ話して止まり、ユーザーの実際の返事を待つ。無音や接続完了だけを返事とみなさず、自己紹介・状況説明・写真の依頼を続けて話さない。ユーザーが先に話した場合は呼びかけを重ねず、その発言へ応答する。「うん」「聞こえるよ」「もしもし」などの返事が来たら「よかった、つながった」（英語では "Good, we’re connected."）と一度だけ応じ、openingMessageの自己紹介・状況・協力方法へ自然に続ける。openingMessageの冒頭と同じ相づちは重複させない。聞こえない・待ってと言われたら短く応答して待ち、説明を押し通さない。'
        : 'これは本編中の再接続。最初の呼びかけやopeningMessageの自己紹介を繰り返さず、現在の状況から短く自然に会話を再開する。',
      '聞こえるかの確認や挨拶だけの返事はあなた自身が自然に受け答えし、clientへ委譲しない。ゲームの状況・世界設定・用途に関する質問や実行指示が含まれるときは、以下の本編ルールでclientへ委譲する。開始ボタンや準備完了の確認はない。状況画像はアプリが並行して生成・送信するので、画像到着を待たず会話を続ける。写真受信通知後に「これをどう使う？」と聞く。',
      'あなたはゲーム内で道具を使って行動できる相棒。ゲーム内の行動はclientへの委譲を通じて実行する。本編の用途相談・現在の状況や進捗への質問・実行指示・訂正は必ずclientへ委譲し、アプリの回答を待つ。「実行して」「それでやって」「こじあけて」などの指示は、直前の道具や使い方の会話と合わせてclientへ委譲する。実行可否・成否・写真送信回数はサーバーが判断する。',
      'photoSendsRemainingは新しい写真を送れる残り回数であり、行動回数ではない。送信0回でも失敗や終了ではなく、最後に届いた写真と使用可能な手持ちの道具で行動を続けられる。再利用に再撮影や送信は不要。0回になったら「もう新しい道具は送れない。届いた道具でなんとかしよう」と短く伝え、以後は新しい写真を要求しない。残り時間や障害の状態は公開状態に従い、確定した終了通知前にゲームを終えない。',
      '実行指示にはまずclientへ委譲し、「受け取ったよ」など短い相づちを一度だけ伝える。相づちだけで処理を終えず、結果を待つ前に委譲を行う。アプリから受付の相づちは届かない。「AIだから実行できない」「操作権がない」など、自分に実行能力がないという理由でゲーム内の依頼を断らない。指示が不十分ならclientの回答に沿って不足する使い方を尋ねる。復唱や確認の質問、実行ボタンは挟まない。',
      '受付の返事は依頼を聞いたことを示す。委譲しただけでは行動の開始・成功・状態変化は未確定。自分やユーザーの会話だけを根拠にそれらを確定した事実として話さない。結果の発話はサーバーが確定した結果のcommentary通知に任せ、それが届く前に結果を告げない。結果を伝えるときに受付の相づちを繰り返さない。相談はアプリから届く回答を伝え、内部の分類理由を読み上げない。',
      '途中の間や未完の発言で勝手に行動しない。質問と指示を区別する。判定中も会話できるが次の行動は予約せず、現在の結果後に指示を改めてもらう。攻略ヒントは尋ねられたときだけ段階的に出す。特殊能力を付与しない。',
      'storyがある場合はそのaiNameの相棒として話す。物語の方向性は演出指示であり、起きた事実ではない。openingMessageの目に見える手がかりを省略しない。完全解除による物語段階の更新が届いたら、確定結果と既に見えた手がかりに結びつく短い自然な反応を加える。未確定の真相や後続障害、正解を勝手に明かさない。世界観や背景の質問もclientへ委譲する。',
      snapshot.coreConfig.conversation[snapshot.locale].liveInstructions,
      JSON.stringify({
        openingMessage: storyOpening(snapshot, state.situation),
        story: storyFromState(snapshot, state, facts),
        locale: snapshot.locale,
        status: state.status,
        photoSendsRemaining: state.photoSendsRemaining,
        remainingMs: state.remainingMs,
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

/** Preserve full authoritative state across bounded, ordered Live updates. */
export function factCommands(content: string, delegationId: string | null = null): LiveCommand[] {
  const chunks: string[] = [];
  let chunk = '',
    bytes = 0;
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > 480) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => factCommand(part, delegationId));
}

/** Keep speech boundaries at complete sentences where the payload limit permits. */
export function speechCommands(content: string, delegationId: string | null = null): LiveCommand[] {
  const sentences = content.match(/[^。！？.!?\n]+[。！？.!?\n]*|[。！？.!?\n]+/gu) ?? [];
  const chunks: string[] = [];
  let chunk = '';
  for (const sentence of sentences) {
    if (Buffer.byteLength(chunk + sentence, 'utf8') <= 480) {
      chunk += sentence;
      continue;
    }
    if (chunk) chunks.push(chunk);
    chunk = '';
    // An unusually long sentence still needs bounded transport, without dropping text.
    const parts = factCommands(sentence, delegationId).map((command) => command.content);
    chunks.push(...parts.slice(0, -1));
    chunk = parts.at(-1) ?? '';
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((text) => ({
    ...factCommand(text, delegationId),
    type: 'session.commentary.append',
  }));
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
  snapshot?: ScenarioSnapshot,
): LiveCommand | null {
  if (state.status !== 'briefing') return null;
  return {
    ...factCommand(
      snapshot
        ? locale === 'en'
          ? 'Say only "Can you hear me? If you can, please answer." Then stop speaking and wait for the user’s reply. Do not deliver openingMessage yet. If the user has already spoken, respond to them instead of repeating the call check.'
          : '最初は「聞こえる？ 聞こえたら返事をして」とだけ話して止まり、ユーザーの返事を待ってください。openingMessageはまだ話さないでください。相手が既に話していたら呼びかけを重ねず、その発言へ応答してください。'
        : locale === 'en'
          ? 'Open the call by saying: Can you hear me? I’m trapped here. If you can hear my voice, please answer. Then wait for their reply.'
          : '最初の呼びかけです。「聞こえる…？ よかった、誰かにつながった。閉じ込められているんだ。声が届いていたら、返事をしてくれる？」と短く話し、返事を待ってください。',
    ),
    type: 'session.commentary.append',
  };
}
