// SPDX-License-Identifier: GPL-3.0-only
export function transferResult(rows, result, kind, { titles = new Map() } = {}) {
  const written = new Set(result.written),
    removed = new Set(result.removed),
    skipped = new Map(result.skipped.map((s) => [s.id, s.problems]));
  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };
  const details = rows.map((row) => {
    let status, message;
    if (skipped.has(row.id)) {
      status = 'skipped';
      message = skipped.get(row.id).join(' ');
    } else if (kind === 'remove' && removed.has(row.id)) {
      status = 'removed';
      message = 'Removed from Pocket.';
    } else if (written.has(row.id)) {
      status = row.onDevice ? 'updated' : 'added';
      message = status === 'added' ? 'Added to Pocket.' : 'Updated on Pocket.';
    } else {
      status = 'unchanged';
      message = 'Already on Pocket.';
    }
    counts[status]++;
    return { title: row.title, status, message };
  });
  const parts = [];
  const amount = (n, verb) => `${n} ${n === 1 ? 'item' : 'items'} ${verb}`;
  if (counts.added) parts.push(amount(counts.added, 'added'));
  if (counts.updated) parts.push(amount(counts.updated, 'updated'));
  if (counts.removed) parts.push(amount(counts.removed, 'removed'));
  if (counts.unchanged) parts.push(amount(counts.unchanged, 'already on Pocket'));
  if (counts.skipped)
    parts.push(amount(counts.skipped, counts.skipped === 1 ? 'needs attention' : 'need attention'));
  const selectedIds = new Set(rows.map((r) => r.id));
  const otherProblems = result.skipped
    .filter((s) => !selectedIds.has(s.id))
    .map((s) =>
      /manifest unreadable.*ENOENT/i.test(s.problems.join(' '))
        ? `“${titles.get(s.id) ?? s.id}” is incomplete on Pocket: its library record is missing. Sync that item again from your Inbox to repair it; add its original there first if needed. Your Inbox files are kept.`
        : 'Existing audio (' + s.id + '): ' + s.problems.join(' '),
    );
  if (otherProblems.length) parts.push('Other audio needs attention');
  return {
    kind,
    counts,
    details,
    tone: result.skipped.length || result.warnings.length ? 'warning' : 'success',
    message: parts.join(' · '),
    warnings: [...result.warnings, ...otherProblems],
  };
}
