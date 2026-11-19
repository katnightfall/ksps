/**
 * Ours: reports of failures that are caught and survived on the tick. The same failure can come
 * back on every cycle (a listener that throws each time it runs), so each place reports its
 * first failure in full and after that only every REPORT_EVERY-th, with the count.
 */
export class FailureReports {
  private static readonly REPORT_EVERY = 1000;
  private static readonly counts = new Map<string, number>();

  /** `where` names the place that failed ("world.move_boats", "boat listener 3"); it is the counter's key. */
  public static report(where: string, error: unknown): void {
    const count = (FailureReports.counts.get(where) ?? 0) + 1;
    FailureReports.counts.set(where, count);
    if (count !== 1 && count % FailureReports.REPORT_EVERY !== 0) return;
    console.error(`[tick] ${where} failed${count > 1 ? ` (${count} times now)` : ""}`, error);
  }
}
