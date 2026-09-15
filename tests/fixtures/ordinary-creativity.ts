import type { CreativeAssessment } from '../../apps/local-server/creative-acceptance.js';

/** Explicit ordinary classification for fake-provider tests of unrelated game behavior. */
export const ordinaryCreativity: CreativeAssessment = {
  kind: 'ordinary',
  approach: 'Use the supplied tool on the current obstacle',
  equivalentAttemptId: null,
  effect: 'other',
};
