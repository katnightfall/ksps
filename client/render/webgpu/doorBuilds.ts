// Ours (upstream issue #6240): door-only builds on their way, by renderer and map square.
//
// Among bots a square's trees and rocks change several times a second. A build dropped for every
// change that came while it was made would never be shown, so a door-only build is finished and
// shown whatever came since (it is the square as it was a moment ago), and the changes that came
// meanwhile are drawn by one more build after it, not by one each (WebGPURenderer.queueLocReload
// and applyQueuedMap).
export type DoorBuilds = {
    epoch: number;
    /** When the door-only build on its way was started. */
    started: Map<number, number>;
    /** The loc version of the newest build started, and of the newest one shown. */
    startedVersions: Map<number, number>;
    shownVersions: Map<number, number>;
};

/** A build not heard of for this long no longer holds the next one back. */
export const DOOR_BUILD_LIMIT_MS = 15000;

const records = new WeakMap<object, DoorBuilds>();

/** The record of `renderer`; a new set of map squares (`epoch`: a login, a far teleport) starts it again. */
export function doorBuildsOf(renderer: object, epoch: number): DoorBuilds {
    let record = records.get(renderer);
    if (!record || record.epoch !== epoch) {
        record = { epoch, started: new Map(), startedVersions: new Map(), shownVersions: new Map() };
        records.set(renderer, record);
    }
    return record;
}
