/**
 * Ours: reports of failures that are caught and survived on the tick. The same failure can come
 * back on every cycle (a listener that throws each time it runs), so each place reports its
 * first failure in full and after that only every REPORT_EVERY-th, with the count.
 */
export class FailureReports {
  private static readonly REPORT_EVERY = 1000;
  /** Places counted at most; past it the counts start again (a key can hold an error's message). */
  private static readonly MAX_PLACES = 10_000;
  private static readonly counts = new Map<string, number>();

  /**
   * Counts a failure at `where` and answers its count when it is one to report (the first, then
   * every REPORT_EVERY-th), or 0 when it is not.
   */
  public static due(where: string): number {
    if (FailureReports.counts.size >= FailureReports.MAX_PLACES && !FailureReports.counts.has(where)) {
      FailureReports.counts.clear();
    }
    const count = (FailureReports.counts.get(where) ?? 0) + 1;
    FailureReports.counts.set(where, count);
    return count === 1 || count % FailureReports.REPORT_EVERY === 0 ? count : 0;
  }

  /** `where` names the place that failed ("world.move_boats", "boat listener 3"); it is the counter's key. */
  public static report(where: string, error: unknown): void {
    const count = FailureReports.due(where);
    if (count === 0) return;
    console.error(`[tick] ${where} failed${count > 1 ? ` (${count} times now)` : ""}`, error);
  }
}
