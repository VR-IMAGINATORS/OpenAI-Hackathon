import { digestValue } from './config.js';
import {
  reviewerRoles,
  type MissionCandidate,
  type MechanicalResult,
  type Review,
  type Verification,
  type Finding,
  type FailureCode,
} from './schemas.js';

export interface Verdict {
  passed: boolean;
  failureCode: FailureCode | null;
  reasons: string[];
}
/** Only own JSON properties are addressable; model strings never become executable paths. */
export function resolveEvidence(root: unknown, path: string): unknown {
  if (path === '' || path === '/') return root;
  if (!path.startsWith('/')) return undefined;
  let value: unknown = root;
  for (const raw of path.slice(1).split('/')) {
    if (/~(?![01])/u.test(raw)) return undefined;
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(value, part)
    )
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function validateEvidence(
  root: unknown,
  finding: Pick<Finding, 'targetPath' | 'excerpt'>,
): boolean {
  const value = resolveEvidence(root, finding.targetPath);
  return (
    value !== undefined &&
    finding.excerpt.trim().length > 0 &&
    (typeof value === 'string' ? value : JSON.stringify(value)).includes(finding.excerpt)
  );
}
export function deriveVerdict(
  candidate: MissionCandidate,
  mechanical: MechanicalResult,
  reviews: Review[],
  verification: Verification | null,
): Verdict {
  const reasons: string[] = [];
  const fail = (failureCode: FailureCode): Verdict => ({ passed: false, failureCode, reasons });
  if (mechanical.checks.length === 0 || mechanical.checks.some((c) => c.status === 'fail')) {
    reasons.push('機械検査で成立性を確認できませんでした');
    return fail('STORY_REJECTED');
  }
  const digest = digestValue(candidate);
  if (mechanical.candidateDigest !== digest) {
    reasons.push('機械検査の候補digestが一致しません');
    return fail('OUTPUT_INVALID');
  }
  if (
    reviews.length !== 3 ||
    reviewerRoles.some((role) => reviews.filter((r) => r.role === role).length !== 1) ||
    reviews.some((r) => r.verdict === 'unknown')
  ) {
    reasons.push('必須の独立評価が欠落、重複、または不明です');
    return fail('REVIEW_INCOMPLETE');
  }
  if (!verification) {
    reasons.push('指摘検証が完了していません');
    return fail('REVIEW_INCOMPLETE');
  }
  if (
    reviews.some((r) => r.candidateDigest !== digest) ||
    verification.candidateDigest !== digest
  ) {
    reasons.push('評価対象の候補digestが一致しません');
    return fail('OUTPUT_INVALID');
  }
  const findings = reviews.flatMap((r) => r.findings);
  const ids = new Set<string>();
  for (const review of reviews) {
    if (review.verdict === 'fail' && review.findings.length === 0)
      reasons.push('不合格評価に根拠の指摘がありません');
    for (const finding of review.findings) {
      if (
        finding.role !== review.role ||
        ids.has(finding.id) ||
        !validateEvidence(candidate, finding)
      )
        reasons.push(`指摘 ${finding.id} の役割・ID・参照または引用が不正です`);
      ids.add(finding.id);
    }
  }
  for (const finding of verification.findings) {
    if (finding.role !== 'verifier' || ids.has(finding.id) || !validateEvidence(candidate, finding))
      reasons.push(`追加指摘 ${finding.id} のID・参照または引用が不正です`);
    ids.add(finding.id);
  }
  if (
    verification.decisions.length !== findings.length ||
    verification.decisions.some((d) => !findings.some((f) => f.id === d.findingId))
  )
    reasons.push('全指摘と判定の対応が一致しません');
  for (const finding of findings) {
    const decisions = verification.decisions.filter((d) => d.findingId === finding.id);
    if (decisions.length !== 1) {
      reasons.push(`指摘 ${finding.id} の判定が欠落または重複しています`);
      continue;
    }
    const d = decisions[0];
    if (d.evidencePaths.some((path) => resolveEvidence(candidate, path) === undefined))
      reasons.push(`指摘 ${finding.id} の根拠パスが存在しません`);
    if (d.disposition === 'rejected' && (!d.counterevidence.trim() || d.evidencePaths.length === 0))
      reasons.push(`指摘 ${finding.id} の棄却には反証と根拠が必要です`);
  }
  if (reasons.length) return fail('OUTPUT_INVALID');
  for (const finding of findings) {
    const d = verification.decisions.find((d) => d.findingId === finding.id)!;
    if (d.disposition === 'unresolved' || (d.disposition === 'confirmed' && finding.blocking))
      reasons.push(`${finding.id}: ${d.reason}`);
  }
  for (const finding of verification.findings)
    if (finding.blocking) reasons.push(`${finding.id}: ${finding.reason}`);
  return reasons.length ? fail('STORY_REJECTED') : { passed: true, failureCode: null, reasons: [] };
}
