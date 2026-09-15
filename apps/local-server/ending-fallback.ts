import { endingTitle, type EndingDesign } from './ending-ai.js';
import type { EndingPacket } from './ending.js';
import { endingItems } from './ending-coverage.js';

/** Recovery directions, not a generated story. The frame pipeline supplies and checks play facts. */
export function aftermathDirection(packet: EndingPacket): EndingDesign {
  const title = endingTitle(packet);
  const outcome =
    packet.outcome === 'happy'
      ? 'Show the confirmed completed escape: the entire person and both feet are beyond the final open doorway on the safe route. Keep the doorway and threshold in the foreground, camera inside looking toward the back of the person.'
      : 'The person has not escaped. Preserve every unresolved physical constraint and all confirmed partial progress and tool damage. Show a pause and steady breathing, without another attempt.';
  const scene =
    'Depict only the supplied confirmed ending state, not the earlier reference state. ' +
    outcome +
    ' Use the reference for the same person, clothing, tools and location. ' +
    'Medium-wide eye-level camera behind the person; keep the face hidden, no head turn. ' +
    'Do not add a rescue, capture, death, new tool, new obstacle or unearned success.';
  return {
    mode: 'aftermath',
    usedActionIds: [],
    usedEvidenceIds: [],
    itemCoverage: endingItems(packet).map((item) => ({
      itemId: item.id,
      actionId: null,
      shot: null,
      depiction: 'omitted',
      reason:
        'Direction unavailable; the recovery preserves final state but cannot promise a dedicated item beat.',
    })),
    candidates: [
      { focus: 'full-play items', reason: 'Unavailable after direction generation failed.' },
      { focus: 'compressed item beats', reason: 'Avoid replaying an unverified action direction.' },
      { focus: 'aftermath', reason: 'Preserve the confirmed ending state with minimal motion.' },
    ],
    selectionReason:
      'Recovery after unavailable AI direction; use the confirmed state without rewriting the published story.',
    startPrompt: scene + ' No added title or captions.',
    endPrompt:
      scene +
      ` Keep the same composition with subtly relaxed shoulders. Add exactly "${title.text}" at ${title.position}; leave the scene and outcome visible.`,
    videoPrompt:
      '15 seconds. Both input frames depict the same confirmed ending state. ' +
      outcome +
      ' From 0 to 5 seconds hold the rear medium-wide view, preserving the character, location, tool identities and constraints in the supplied frames. ' +
      'From 5 to 12 seconds show only breathing and a small shoulder movement; keep physical state fixed and face hidden. A gentle slow camera push is allowed; no new action or event. ' +
      `Around 12 seconds reveal exactly "${title.text}" at ${title.position} with a short amber left-to-right light reveal, holding it legibly for the final 2 seconds. ` +
      'No black card or other captions. Only environmental ambience and natural physical sounds. No speech, narration, singing or music. Do not invent rescue, capture, death or any additional success.',
  };
}
