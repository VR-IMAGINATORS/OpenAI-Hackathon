import { z } from 'zod';
const short = z.string().max(1000);
export const itemStatus = z.enum(['available', 'damaged', 'consumed']);
export const proposalSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            photoId: z.string().uuid().nullable(),
            inventoryId: z.string().uuid().nullable(),
            name: short,
          })
          .strict(),
      )
      .max(40),
    usage: short,
    summary: short,
  })
  .strict();
export const judgmentSchema = z
  .object({
    success: z.boolean(),
    narrative: z.string().max(2000),
    situation: z.string().max(2000),
    inventoryChanges: z
      .array(z.object({ id: z.string().uuid(), status: itemStatus, description: short }).strict())
      .max(40),
  })
  .strict();
export type RecognizedProposal = z.infer<typeof proposalSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
export interface InventoryItem {
  id: string;
  name: string;
  description: string;
  status: z.infer<typeof itemStatus>;
}
export interface Proposal extends RecognizedProposal {
  revision: number;
  inputRevision: number;
}
export type VoiceState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export interface LiveCommand {
  type: 'session.thinking.append' | 'session.commentary.append';
  event_id: string;
  delegation_id: string | null;
  content: string;
}
export interface PublicGameState {
  automaticActions?: boolean;
  id: string;
  generation: number;
  status: 'briefing' | 'playing' | 'judging' | 'won' | 'lost' | 'expired';
  title: string;
  briefing: string;
  obstacle: { title: string; index: number; count: number };
  situation: string;
  actionsRemaining: number;
  remainingMs: number;
  waitingRemainingMs: number;
  paused: boolean;
  maxPhotos: number;
  photoCount: number;
  inventory: InventoryItem[];
  proposal: Proposal | null;
  inputRevision: number;
  busy: boolean;
  voiceState: VoiceState;
  transcript: string;
  lastResult: { success: boolean; narrative: string } | null;
  error: string | null;
}
export interface PlayUpdate {
  state: PublicGameState;
  commands: LiveCommand[];
}
