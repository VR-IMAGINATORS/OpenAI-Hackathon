export type EndingOutcome = 'happy' | 'normal' | 'bad';
export type GameEndReason = 'escaped' | 'time_limit' | 'action_limit' | 'interrupted';
export type EndingVideoStatus =
  | 'disabled'
  | 'not_applicable'
  | 'queued'
  | 'preparing'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'expired';

export interface EndingStory {
  title: string;
  text: string;
  evaluation: string;
}

/** Owner-visible state only. Provider details and prompts never cross this boundary. */
export interface EndingView {
  playId: string;
  outcome: EndingOutcome | null;
  clearedCount: number;
  status: EndingVideoStatus;
  errorCode: string | null;
  retainUntil: string | null;
  videoPath: string | null;
  story: EndingStory | null;
}
