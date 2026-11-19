// Ours (upstream issue #6240): which rebuild a renderer asks for when the server changes a loc
// that is drawn with the doors though it is no door (a tree, a rock, a stall and what the server
// puts in its place: rs/scene/ChangingLocs.ts).
//
// This is a forecast, for speed only. Where the scene builder decides otherwise (SceneBuilder
// .addLoc is what decides), the door-only build that comes back says so (SdMapData.locSignature)
// and the renderer asks for the loc group as well.
import { LocModelType } from "../../rs/config/loctype/LocModelType";
import type { LocType } from "../../rs/config/loctype/LocType";
import { isChangingLocType, isStillLocType } from "../../rs/scene/ChangingLocs";
import { LOC_OVERRIDE_REMOVED } from "../../rs/scene/LocOverride";

type Loader = { load(id: number): LocType | undefined };
type Overrides = { keys(): Iterable<string>; get(key: string): { newId?: number } | undefined };

function load(loader: Loader, id: number): LocType | undefined {
    if (!((id | 0) >= 0)) return undefined;
    try {
        return loader.load(id | 0);
    } catch {
        return undefined;
    }
}

/** Whether the cache's loc `id` is one that changes in play. */
export function isChangingCacheLoc(loader: Loader, id: number, shape: number = LocModelType.NORMAL): boolean {
    return isChangingLocType(load(loader, id), shape);
}

/**
 * Whether the cache has an object that changes in play on this tile: among the ids the built
 * square lists there (`slotIds`), or among the cache locs the server has since removed from the
 * tile (a felled tree's own id is known only from the override that hides it).
 */
export function isChangingTile(
    overrides: Overrides,
    loader: Loader,
    tile: { x: number; y: number },
    level: number,
    slotIds: ArrayLike<number>,
    shape: number,
): boolean {
    for (let i = 0; i < slotIds.length; i++) {
        if (isChangingCacheLoc(loader, slotIds[i], shape)) return true;
    }
    const prefix = `${tile.x | 0},${tile.y | 0},${level | 0},`;
    for (const key of overrides.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes(",")) continue;
        const id = Number(rest);
        if (!Number.isInteger(id) || id < 0) continue;
        if (overrides.get(key)?.newId !== LOC_OVERRIDE_REMOVED) continue;
        if (isChangingCacheLoc(loader, id, shape)) return true;
    }
    return false;
}

/** Whether a loc the server added (or is taking away again) is drawn with the doors. */
export function isDoorGroupAddedLoc(loader: Loader, id: number, shape: number, changingTile: boolean): boolean {
    const type = load(loader, id);
    return type !== undefined && isStillLocType(type, shape) && (changingTile || isChangingLocType(type, shape));
}

/** Whether a cache loc turning into `newId` (0: into nothing) stays within the door group. */
export function isDoorGroupChange(loader: Loader, oldId: number, newId: number): boolean {
    if (!isChangingCacheLoc(loader, oldId)) return false;
    if ((newId | 0) <= 0) return true;
    const next = load(loader, newId);
    return next !== undefined && isStillLocType(next, LocModelType.NORMAL);
}
