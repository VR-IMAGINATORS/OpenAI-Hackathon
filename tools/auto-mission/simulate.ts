import { digestValue } from './config.js';
import {
  missionContractSchema,
  type MissionContract,
  type MissionCandidate,
  type MechanicalCheck,
  type MechanicalResult,
  type ItemState,
} from './schemas.js';

const unique = (values: string[]) => new Set(values).size === values.length;
export function validateContract(contract: MissionContract): {
  valid: boolean;
  checks: MechanicalCheck[];
} {
  const checks: MechanicalCheck[] = [];
  const check = (ok: boolean, path: string, reason: string) =>
    checks.push({
      id: `contract-${checks.length + 1}`,
      status: ok ? 'pass' : 'fail',
      path,
      reason,
    });
  const parsed = missionContractSchema.safeParse(contract);
  if (!parsed.success) {
    check(false, '/', 'コントラクトの構造が不正です');
    return { valid: false, checks };
  }
  const locations = new Set(contract.locations.map((x) => x.id));
  const facts = new Map(contract.factDefinitions.map((x) => [x.key, x]));
  check(unique(contract.locations.map((x) => x.id)), '/locations', '場所IDの一意性');
  check(unique(contract.factDefinitions.map((x) => x.key)), '/factDefinitions', '事実キーの一意性');
  check(unique(contract.objectCatalog.map((x) => x.id)), '/objectCatalog', '道具IDの一意性');
  check(
    unique(contract.initialState.props.map((x) => x.id)),
    '/initialState/props',
    '備品IDの一意性',
  );
  check(
    locations.has(contract.initialState.locationId),
    '/initialState/locationId',
    '初期場所の存在',
  );
  contract.initialState.props.forEach((p, i) =>
    check(locations.has(p.locationId), `/initialState/props/${i}`, '備品の場所の存在'),
  );
  contract.factDefinitions.forEach((f, i) =>
    check(
      unique(f.allowedValues) && f.allowedValues.includes(f.initialValue),
      `/factDefinitions/${i}`,
      '初期値と値域の整合性',
    ),
  );
  check(
    unique(contract.orderedObstacles.map((x) => x.id)) &&
      contract.orderedObstacles.length === contract.difficulty.obstacleCount,
    '/orderedObstacles',
    'ギミック数とIDの整合性',
  );
  const conditions = (cs: { key: string; value: string }[], path: string) => {
    check(unique(cs.map((c) => c.key)), path, '条件キーの重複がない');
    cs.forEach((c, i) =>
      check(
        facts.get(c.key)?.allowedValues.includes(c.value) === true,
        `${path}/${i}`,
        '条件のキーと値が宣言されている',
      ),
    );
  };
  contract.orderedObstacles.forEach((o, i) => {
    check(locations.has(o.locationId), `/orderedObstacles/${i}/locationId`, 'ギミックの場所の存在');
    conditions(o.goalConditions, `/orderedObstacles/${i}/goalConditions`);
  });
  conditions(contract.escapeConditions, '/escapeConditions');
  // Every obstacle goal remains required at the terminal state, together with escape.
  // A transient fact cannot be required to hold two different values at that time.
  const terminalValues = new Map<string, { value: string; path: string }>();
  const terminalConditions = [
    ...contract.orderedObstacles.flatMap((obstacle, i) =>
      obstacle.goalConditions.map((condition, j) => ({
        condition,
        path: `/orderedObstacles/${i}/goalConditions/${j}`,
      })),
    ),
    ...contract.escapeConditions.map((condition, i) => ({
      condition,
      path: `/escapeConditions/${i}`,
    })),
  ];
  for (const { condition, path } of terminalConditions) {
    const previous = terminalValues.get(condition.key);
    const compatible = previous === undefined || previous.value === condition.value;
    check(
      compatible,
      path,
      compatible
        ? '終端で同時に要求される事実の値が矛盾しない'
        : `終端条件が矛盾: ${condition.key} は ${previous!.path} で ${previous!.value}、ここで ${condition.value} が必要`,
    );
    if (!previous) terminalValues.set(condition.key, { value: condition.value, path });
  }

  return { valid: checks.every((c) => c.status === 'pass'), checks };
}

export function simulateWitness(
  contract: MissionContract,
  candidate: MissionCandidate,
): MechanicalResult {
  const result: MechanicalResult = {
    candidateDigest: digestValue(candidate),
    checks: [],
    stateTrace: [],
    resourceTotals: { photoSends: 0, actions: 0, photos: 0 },
    estimatedTotalSeconds: 0,
  };
  const check = (ok: boolean, path: string, reason: string) => {
    result.checks.push({
      id: `check-${result.checks.length + 1}`,
      status: ok ? 'pass' : 'fail',
      path,
      reason,
    });
    return ok;
  };
  const validity = validateContract(contract);
  if (!validity.valid) {
    check(false, '/contractDigest', '固定コントラクトが不正です');
    return result;
  }
  check(
    candidate.contractDigest === digestValue(contract),
    '/contractDigest',
    '固定コントラクトのdigest一致',
  );
  check(unique(candidate.items.map((i) => i.id)), '/items', '道具インスタンスIDの一意性');
  check(unique(candidate.steps.map((s) => s.id)), '/steps', '手順IDの一意性');
  check(
    candidate.obstacles.map((o) => o.id).join('|') ===
      contract.orderedObstacles.map((o) => o.id).join('|'),
    '/obstacles',
    '固定された全ギミックと順序の一致',
  );
  const locations = new Set(contract.locations.map((l) => l.id));
  const definitions = new Map(contract.factDefinitions.map((f) => [f.key, f]));
  const facts = new Map(contract.factDefinitions.map((f) => [f.key, f.initialValue]));
  const states = new Map<string, ItemState>();
  candidate.items.forEach((item, i) => {
    check(
      contract.objectCatalog.some((c) => c.id === item.catalogId),
      `/items/${i}/catalogId`,
      '身近な道具リストに含まれる',
    );
    check(
      !contract.initialState.props.some((p) => p.id === item.id),
      `/items/${i}/id`,
      '備品IDとの衝突がない',
    );
    states.set(item.id, { phase: 'unmaterialized', locationId: null, condition: 'usable' });
  });
  let location = contract.initialState.locationId;
  let obstacleIndex = 0;
  const satisfies = (cs: { key: string; value: string }[]) =>
    cs.every((c) => facts.get(c.key) === c.value);
  for (const [index, step] of candidate.steps.entries()) {
    const path = `/steps/${index}`;
    const beforeFailures = result.checks.filter((c) => c.status === 'fail').length;
    const nextIndex = contract.orderedObstacles.findIndex((o) => o.id === step.obstacleId);
    check(
      nextIndex >= obstacleIndex && nextIndex <= obstacleIndex + 1,
      path + '/obstacleId',
      'ギミック順序が連続している',
    );
    if (nextIndex === obstacleIndex + 1)
      check(
        satisfies(contract.orderedObstacles[obstacleIndex].goalConditions),
        path + '/obstacleId',
        '前のギミック達成後に進んでいる',
      );
    check(nextIndex !== -1, path + '/obstacleId', '既知のギミック');
    check(unique(step.itemIds), path + '/itemIds', '同じ道具を二重に指定しない');
    check(
      unique(step.preconditions.map((c) => c.key)),
      path + '/preconditions',
      '前提条件の重複がない',
    );
    step.preconditions.forEach((c, i) =>
      check(
        definitions.get(c.key)?.allowedValues.includes(c.value) === true &&
          facts.get(c.key) === c.value,
        `${path}/preconditions/${i}`,
        '宣言された前提条件が成立する',
      ),
    );
    check(
      step.targetLocationId === null || locations.has(step.targetLocationId),
      path + '/targetLocationId',
      '移動・具現化先が既知の場所',
    );
    if (step.kind === 'send') {
      result.resourceTotals.photoSends++;
      result.resourceTotals.photos += step.itemIds.length;
      check(
        step.itemIds.length > 0 && step.itemIds.length <= contract.difficulty.maxPhotosPerSend,
        path + '/itemIds',
        '送信枚数の上限',
      );
    } else result.resourceTotals.actions++;
    result.estimatedTotalSeconds += step.estimatedSeconds;
    if (step.kind === 'send' || step.kind === 'place' || step.kind === 'retrieve')
      check(step.itemIds.length > 0, path + '/itemIds', '操作対象が指定されている');
    if (step.kind === 'use' && step.itemIds.length === 0)
      check(
        step.itemEffects.length === 0,
        path + '/itemEffects',
        '素手の操作では具現化した道具の状態を変更しない',
      );
    if (step.kind === 'move')
      check(
        step.targetLocationId !== null &&
          step.targetLocationId !== location &&
          step.itemEffects.length === 0 &&
          step.itemIds.length === 0,
        path,
        '移動には別の目的地だけを指定し、道具操作を混ぜない',
      );
    if (step.kind !== 'move' && step.kind !== 'send')
      check(
        step.targetLocationId === null || step.targetLocationId === location,
        path + '/targetLocationId',
        '遠隔の道具操作ではない',
      );
    if (step.kind !== 'move' && step.kind !== 'send')
      check(
        contract.orderedObstacles[nextIndex]?.locationId === location,
        path,
        'ギミックの場所で操作する',
      );
    const nextStates = new Map(Array.from(states, ([key, state]) => [key, { ...state }]));
    check(
      unique(step.itemEffects.map((e) => e.itemId)),
      path + '/itemEffects',
      '道具効果の重複がない',
    );
    for (const id of step.itemIds) {
      const state = states.get(id);
      check(!!state, path + '/itemIds', '道具インスタンスが宣言されている');
      if (!state) continue;
      const available =
        state.condition === 'usable' &&
        (state.phase === 'held' || state.phase === 'placed') &&
        state.locationId === location;
      check(
        step.kind === 'send'
          ? state.phase === 'unmaterialized' && state.condition === 'usable'
          : available,
        path + '/itemIds',
        '道具が現在地で使用可能、または未具現化である',
      );
      if (step.kind === 'place') check(state.phase === 'held', path, '設置前に道具を持っている');
      if (step.kind === 'retrieve') check(state.phase === 'placed', path, '回収対象が設置済み');
      if (step.kind !== 'use' && step.kind !== 'move')
        check(
          step.itemEffects.some((e) => e.itemId === id),
          path + '/itemEffects',
          '道具の状態変化が明示されている',
        );
    }
    for (const [ei, effect] of step.itemEffects.entries()) {
      const state = states.get(effect.itemId),
        to = effect.to;
      check(
        step.itemIds.includes(effect.itemId) &&
          !!state &&
          digestValue(state) === digestValue(effect.from),
        `${path}/itemEffects/${ei}`,
        '指定道具の実行前状態が一致',
      );
      let legal = false;
      if (state) {
        if (step.kind === 'send')
          legal =
            state.phase === 'unmaterialized' &&
            to.condition === 'usable' &&
            ((to.phase === 'held' && to.locationId === location) ||
              (to.phase === 'placed' && to.locationId === (step.targetLocationId ?? location)));
        if (step.kind === 'place')
          legal =
            state.phase === 'held' &&
            to.phase === 'placed' &&
            to.locationId === location &&
            to.condition === state.condition;
        if (step.kind === 'retrieve')
          legal =
            state.phase === 'placed' &&
            to.phase === 'held' &&
            to.locationId === location &&
            to.condition === state.condition;
        if (step.kind === 'use')
          legal =
            (to.phase === state.phase || to.phase === 'unavailable') &&
            to.locationId === (to.phase === 'unavailable' ? null : state.locationId) &&
            (state.condition === 'usable' || to.condition === state.condition);
      }
      check(legal, `${path}/itemEffects/${ei}/to`, '操作種別に対して合法な状態遷移');
      nextStates.set(effect.itemId, { ...to });
    }
    check(
      unique(step.factEffects.map((e) => e.key)),
      path + '/factEffects',
      '事実効果の重複がない',
    );
    for (const [i, e] of step.factEffects.entries())
      check(
        facts.get(e.key) === e.from &&
          definitions.get(e.key)?.allowedValues.includes(e.to) === true,
        `${path}/factEffects/${i}`,
        '事実の変更元・変更先が宣言と一致',
      );
    if (result.checks.filter((c) => c.status === 'fail').length > beforeFailures) break;
    obstacleIndex = nextIndex;
    for (const e of step.factEffects) facts.set(e.key, e.to);
    for (const [id, state] of nextStates) states.set(id, state);
    if (step.kind === 'move') {
      location = step.targetLocationId!;
      for (const state of states.values()) if (state.phase === 'held') state.locationId = location;
    }
    result.stateTrace.push({
      stepId: step.id,
      locationId: location,
      facts: Array.from(facts, ([key, value]) => ({ key, value })),
      items: Array.from(states, ([itemId, state]) => ({ itemId, state: { ...state } })),
    });
  }
  check(
    result.resourceTotals.photoSends <= contract.difficulty.maxPhotoSends,
    '/steps',
    '写真送信回数の上限',
  );
  check(
    contract.difficulty.maxActions === null ||
      result.resourceTotals.actions <= contract.difficulty.maxActions,
    '/steps',
    '行動回数の上限',
  );
  check(
    result.estimatedTotalSeconds <= contract.difficulty.totalTimeSeconds,
    '/steps',
    '手順の見積り時間の上限（実プレイ未測定）',
  );
  check(result.stateTrace.length === candidate.steps.length, '/steps', '全手順が合法に完了する');
  contract.orderedObstacles.forEach((o) =>
    check(satisfies(o.goalConditions), '/steps', `${o.id}の終端達成条件`),
  );
  check(satisfies(contract.escapeConditions), '/ending', '脱出条件が成立する');
  return result;
}
