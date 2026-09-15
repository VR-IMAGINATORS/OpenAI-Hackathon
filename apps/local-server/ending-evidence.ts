/** Keep whole, trusted records: never truncate a sentence into a different claim. */
export function boundedEndingEvidence<T extends { sourceId: string; kind?: string }>(
  records: readonly T[],
  maxBytes: number,
): T[] {
  const sizes = records.map((record) => Buffer.byteLength(JSON.stringify(record)) + 1);
  if (2 + sizes.reduce((sum, size) => sum + size, 0) <= maxBytes) return [...records];
  const selected = new Set<number>();
  let bytes = 2;
  const take = (index: number) => {
    if (selected.has(index) || bytes + sizes[index] > maxBytes) return;
    selected.add(index);
    bytes += sizes[index];
  };
  // Briefings and confirmed scene/action results take precedence over speech fragments.
  records.forEach((record, index) => {
    if (record.kind && record.kind !== 'assistant_transcript') take(index);
  });
  // Retain both early foreshadowing and the final conversation, in original order.
  for (let i = 0; i < records.length; i++) {
    take(i);
    take(records.length - 1 - i);
  }
  return records.filter((_record, index) => selected.has(index));
}
