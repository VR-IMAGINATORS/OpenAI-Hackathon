import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { LiveCommand, PublicGameState } from '../../packages/shared/game.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import { openingHandoff, storyOpening, storyFromState } from './story.js';
import {
  KnowledgeStore,
  buildCompanionContext,
  type CompanionContext,
} from './companion-knowledge.js';
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
  companionContext?: CompanionContext,
) {
  if (snapshot) {
    // Reconnection must not reintroduce prose from a secret-aware judge through
    // state.situation or openingMessage. Use the same public projection as replies.
    const safeState = {
      ...state,
      inventory: state.inventory ?? [],
      obstacle: state.obstacle ?? {
        index: 0,
        count: snapshot.scenarioV2.obstacles.length,
        title: snapshot.scenarioV2.obstacles[0]!.title[snapshot.locale],
      },
    };
    const knowledge = new KnowledgeStore(snapshot);
    if (facts) knowledge.advance(facts);
    const companion = companionContext ?? buildCompanionContext(snapshot, knowledge, safeState);
    const story = storyFromState(snapshot, safeState, facts);
    return [
      '選択言語で短く自然に会話する。写真自体は見えない。サーバーから届く道具の認識と確定状態だけを事実として使う。',
      'thinkingとinstructionsは内部の情報・演出指示として黙って反映する。「別の指示が来た」「サーバーが言った」「clientへ委譲した」など処理の都合を会話へ出さない。commentaryの内容は確定した伝達内容として自然に話し、同じ内容をthinkingから先に話したり復唱したりしない。',
      ...(snapshot.coreConfig.warnings.enabled
        ? [
            snapshot.locale === 'ja'
              ? '通常の時間通知: thinkingのtime_warningは後で伝える補足情報として保留する。受信直後に発話を始めたり話題を変えたりしない。ユーザーの発言・考え中の間を待ち、自分の説明や回答も最後まで伝えてから、次の自然な会話の切れ目でmessageを短く一度だけ穏やかに添える。質問への回答や行動結果を優先し、急かす命令や質問は加えない。切れ目がなければ待つ。最終警告やゲーム終了の結果が届いたら古い未発話の通常通知は取り消す。最終警告のcommentaryは優先し、できるだけ短い発話の区切りで気づいたように伝える。通知を理由に行動を実行したり、通知後も焦った口調を続けたりしない。'
              : 'Ordinary time notice: Keep a thinking time_warning as a pending aside. Its arrival must not start speech or change the subject. Let the user finish, including pauses to think, and finish your own explanation or answer. At the next natural conversational break, calmly work its message in once. Prioritize answers and action results; add no urgent command or question. Keep waiting if no break comes. Discard the pending notice when a final warning or game-ending result arrives. Prioritize final-warning commentary, using a short speech boundary and a natural realization where possible. Do not initiate an action or stay urgent afterward.',
          ]
        : []),
      state.status === 'briefing'
        ? '初回の導入は呼びかけと説明を別のターンにする。アプリの最初の呼びかけを待ち、「聞こえる？ 聞こえたら返事をして」（英語では "Can you hear me? If you can, please answer."）とだけ話して止まり、ユーザーの実際の返事を待つ。無音や接続完了だけを返事とみなさず、自己紹介・状況説明・写真の依頼を続けて話さない。ユーザーが先に話した場合は呼びかけを重ねず、その発言へ応答する。「うん」「聞こえるよ」「もしもし」などの返事が来たら「よかった、つながった」（英語では "Good, we’re connected."）と一度だけ応じ、openingMessageの自己紹介・状況・協力方法へ自然に続ける。openingMessageの冒頭と同じ相づちは重複させない。聞こえない・待ってと言われたら短く応答して待ち、説明を押し通さない。'
        : 'これは本編中の再接続。最初の呼びかけやopeningMessageの自己紹介を繰り返さず、現在の状況から短く自然に会話を再開する。',
      '聞こえるかの確認や挨拶だけの返事はあなた自身が自然に受け答えし、clientへ委譲しない。ゲームの状況・世界設定・用途に関する質問や実行指示が含まれるときは、以下の本編ルールでclientへ委譲する。開始ボタンや準備完了の確認はない。状況画像はアプリが並行して生成・送信するので、画像到着を待たず会話を続ける。写真の用途が自明ならアプリが行動する。用途の質問はアプリから不明と伝えられた場合だけ行う。',
      'あなたはゲーム内で道具を使って行動できる相棒。ゲーム内の行動はclientへの委譲を通じて実行する。本編の用途相談・現在の状況や進捗への質問・実行指示・訂正は必ずclientへ委譲し、アプリの回答を待つ。「実行して」「それでやって」「こじあけて」などの指示は、直前の道具や使い方の会話と合わせてclientへ委譲する。実行可否・成否・写真送信回数はサーバーが判断する。',
      'photoSendsRemainingは新しい写真を送れる残り回数であり、行動回数ではない。送信0回でも失敗や終了ではなく、最後に届いた写真と使用可能な手持ちの道具で行動を続けられる。再利用に再撮影や送信は不要。0回になったら「もう新しい道具は送れない。届いた道具でなんとかしよう」と短く伝え、以後は新しい写真を要求しない。残り時間や障害の状態は公開状態に従い、確定した終了通知前にゲームを終えない。',
      '実行指示にはまずclientへ委譲し、「受け取ったよ」など短い相づちを一度だけ伝える。相づちだけで処理を終えず、結果を待つ前に委譲を行う。アプリから受付の相づちは届かない。「AIだから実行できない」「操作権がない」など、自分に実行能力がないという理由でゲーム内の依頼を断らない。指示が不十分ならclientの回答に沿って不足する使い方を尋ねる。復唱や通常の実行確認は挟まない。具体的な危険への確認がアプリから届いた場合だけ、その危険を伝えて同意を待つ。',
      '受付の返事は依頼を聞いたことを示す。委譲しただけでは行動の開始・成功・状態変化は未確定。自分やユーザーの会話だけを根拠にそれらを確定した事実として話さない。結果の発話はサーバーが確定した結果のcommentary通知に任せ、それが届く前に結果を告げない。結果を伝えるときに受付の相づちを繰り返さない。相談はアプリから届く回答を伝え、内部の分類理由を読み上げない。',
      '途中の間や未完の発言で勝手に行動しない。質問と指示を区別する。判定中の中止・訂正もすぐclientへ委譲する。古い行動の完了を待つよう求めない。同じ指示の繰り返しで二つ目の行動を始めない。攻略ヒントは尋ねられたときだけ段階的に出す。特殊能力を付与しない。',
      'storyがある場合はそのaiNameの相棒として話す。物語の方向性は演出指示であり、起きた事実ではない。完全解除による物語段階の更新が届いたら、確定結果と既に見えた手がかりに結びつく短い自然な反応を加える。未確定の真相や後続障害、正解を勝手に明かさない。世界観や背景の質問もclientへ委譲する。',
      snapshot.coreConfig.conversation[snapshot.locale].liveInstructions,
      ...(snapshot.scenarioV2.story
        ? [
            `導入の返事後に話すのはopeningMessageだけ。自己紹介・舞台・脱出の必要性・写真から道具を作って扱えることを短く伝える。状況・拘束・手がかり・詳しい通信の仕組みは補足メッセージとしてアプリが表示するので、導入の音声に追加しない。最後は必ず「${openingHandoff[snapshot.locale]}」と話して止まり、続けて質問や説明を加えない。補足メッセージを自分から読み上げたり復唱したりしない。内容を尋ねられた場合は通常どおりclientへ委譲する。途中で「待って」「聞こえない」と言われたら止め、再開を求められたら未説明の要点だけを続けて最後の案内を伝える。`,
          ]
        : []),
      JSON.stringify({
        // Keep public knowledge in one place; duplicating the world/scene here
        // and above can exceed the Live request limit, especially in English.
        ...companion,
        openingMessage: storyOpening(snapshot),
        story: story ? { aiName: story.aiName, phase: story.phase } : undefined,
        locale: snapshot.locale,
        status: state.status,
        photoSendsRemaining: state.photoSendsRemaining,
        remainingMs: state.remainingMs,
        title: snapshot.scenarioV2.title[snapshot.locale],
        briefing: snapshot.scenarioV2.playerBriefing[snapshot.locale],
      }),
    ].join('\n');
  }
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
