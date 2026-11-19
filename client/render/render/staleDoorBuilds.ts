// Ours (upstream issue #6240): door-only builds that a later loc change overtook while they were
// made. Among bots a square's trees and rocks change several times a second; a build dropped for
// every change that came meanwhile would never be shown. Such a build is shown all the same (it
// is the square as it was a moment ago) while the next one is made, and each map square has one
// reload on its way at a time, which picks the later changes up when it ends.
import type { SdMapData } from "../loader/SdMapData";

const stale = new WeakSet<SdMapData>();

export function markStaleDoorBuild(mapData: SdMapData): void {
    stale.add(mapData);
}

export function isStaleDoorBuild(mapData: SdMapData): boolean {
    return stale.has(mapData);
}

const reloading = new WeakMap<object, Set<number>>();

/** The map squares of `host` with a loc reload on its way (see beginLocReloadBatch). */
export function reloadingSquares(host: object): Set<number> {
    let squares = reloading.get(host);
    if (!squares) reloading.set(host, (squares = new Set()));
    return squares;
}
