import type { CommittedEndingAction } from './ending.js';

/** Remove repeated unchanged snapshots without discarding any confirmed transition. */
export function actionFactChanges<
  T extends Pick<CommittedEndingAction, 'beforeFacts' | 'afterFacts'>,
>(action: T): T {
  const changed = new Set(
    [...Object.keys(action.beforeFacts.values), ...Object.keys(action.afterFacts.values)].filter(
      (key) => action.beforeFacts.values[key] !== action.afterFacts.values[key],
    ),
  );
  return {
    ...action,
    beforeFacts: {
      ...action.beforeFacts,
      values: Object.fromEntries(
        Object.entries(action.beforeFacts.values).filter(([key]) => changed.has(key)),
      ),
    },
    afterFacts: {
      ...action.afterFacts,
      values: Object.fromEntries(
        Object.entries(action.afterFacts.values).filter(([key]) => changed.has(key)),
      ),
    },
  };
}
