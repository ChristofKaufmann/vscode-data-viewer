// Pure helpers for the multi-column sort state. The key list is ordered with
// the primary key first. Kept DOM-free so it can be unit-tested.
import { SortKey } from '../shared/protocol';

export type SortDirection = 'none' | 'asc' | 'desc';

/**
 * Cycles a column's sort state on click: none → asc → desc → none.
 * Activating a column (none → asc) makes it the new primary key (prepended);
 * flipping an active column's direction keeps its place; deactivating removes it.
 */
export function cycleSort(keys: SortKey[], column: number): SortKey[] {
  const existing = keys.find((k) => k.column === column);
  if (!existing) {
    return [{ column, descending: false }, ...keys];
  }
  if (!existing.descending) {
    return keys.map((k) => (k.column === column ? { column, descending: true } : k));
  }
  return keys.filter((k) => k.column !== column);
}

/** A column's current direction and 1-based sort priority (0 when unsorted). */
export function sortState(keys: SortKey[], column: number): { dir: SortDirection; rank: number } {
  const index = keys.findIndex((k) => k.column === column);
  if (index === -1) {
    return { dir: 'none', rank: 0 };
  }
  return { dir: keys[index].descending ? 'desc' : 'asc', rank: index + 1 };
}
