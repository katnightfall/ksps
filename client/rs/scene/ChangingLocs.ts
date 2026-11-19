// Ours (upstream issue #6240): objects that change state in play are drawn with the doors.
//
// A map square draws its scenery in two groups: the loc group (walls, roofs, furniture: tens of
// megabytes of vertices in a town) and the small door group, which is rebuilt on its own in a
// fraction of a second when a door opens. A tree becoming its stump, a rock being mined and a stall
// being emptied used to rebuild the whole loc group: four seconds for a Varlamore square, during
// which the felled tree stood. These objects are drawn in the door group instead.
//
// What belongs there is decided where the scene is built (SceneBuilder.addLoc), from the object the
// game cache puts on the tile, not from the object shown now: a stump or an empty stall is a
// nameless object with no option of its own.
import { LocType } from "../config/loctype/LocType";
import { preparedLocSequence } from "./LocPacketAnimation";

/** Options of the objects the server swaps for a used-up form and back all day. */
const CHANGING_ACTIONS = new Set(["chop down", "mine", "steal-from", "pick"]);

/**
 * Whether a loc is drawn as one still model lit by itself: no animation, not a multiloc. Only
 * these can be drawn with the doors, whose group holds no animated frames.
 */
export function isStillLocType(locType: LocType, shape: number): boolean {
    return (
        locType.seqId === -1 &&
        !locType.randomSeqIds?.length &&
        locType.transforms === undefined &&
        preparedLocSequence(locType.id, shape) === undefined
    );
}

/**
 * Whether the cache's object is one the server changes in play (a tree, a rock, a stall, a crop).
 * One that shares its lighting with its neighbours (a vein set in a cave wall) stays in the loc
 * group: lit by itself it would show a seam.
 */
export function isChangingLocType(locType: LocType | undefined, shape: number): boolean {
    if (!locType || locType.mergeNormals || !isStillLocType(locType, shape)) return false;
    if (!Array.isArray(locType.actions)) return false;
    for (const action of locType.actions) {
        if (action && CHANGING_ACTIONS.has(action.toLowerCase())) return true;
    }
    return false;
}

/** A tile's loc slot as the server addresses it: its own plane, the tile and the shape. */
export function locSlotKey(level: number, tileX: number, tileY: number, shape: number): string {
    return `${level | 0},${tileX | 0},${tileY | 0},${shape | 0}`;
}

/** A placed loc, as a LocEntity carries it (the plane is the map's, see SceneBuilder.addLoc). */
export function placedLocKey(id: number, level: number, tileX: number, tileY: number): string {
    return `${id | 0},${level | 0},${tileX | 0},${tileY | 0}`;
}

/**
 * What a scene's locs outside the door group are, as a short text: two builds of a square give
 * the same one exactly when their loc groups hold the same objects. A door-only build is sent
 * with it, so a renderer can tell that the loc group it is drawing is out of date.
 * `placed` holds eight numbers per loc (see SceneBuilder.addLoc).
 */
export function locGroupSignature(
    placed: ArrayLike<number>,
    inLocGroup: (index: number) => boolean,
): string {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    let count = 0;
    for (let i = 0; i + PLACED_LOC_FIELDS <= placed.length; i += PLACED_LOC_FIELDS) {
        if (!inLocGroup(i)) continue;
        count++;
        for (let j = 0; j < PLACED_LOC_FIELDS - 1; j++) {
            const value = placed[i + j] | 0;
            a = Math.imul(a ^ value, 0x01000193);
            b = Math.imul(b + value, 0x85ebca6b) ^ (b >>> 13);
        }
    }
    return `${count}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/** id, plane, tileX, tileY, shape, rotation, sequence override (-2 for none), changing (0/1). */
export const PLACED_LOC_FIELDS = 8;

/** What SceneBuilder.addLoc records about the locs of a scene it builds. */
export type PlacedLocs = {
    /** Every loc placed, PLACED_LOC_FIELDS numbers each. */
    placed: number[];
    /** The placed locs drawn with the doors (placedLocKey). */
    changing: Set<string>;
    /** Slots (locSlotKey) where the cache holds an object that changes in play. */
    changingSlots: Set<string>;
    /** Slots where another cache loc was removed or replaced: what stands there is in the loc group. */
    baseChangedSlots: Set<string>;
};

const records = new WeakMap<object, PlacedLocs>();

/** The record of a scene's locs, kept beside the scene. */
export function placedLocsOf(scene: object): PlacedLocs {
    let record = records.get(scene);
    if (!record) {
        record = { placed: [], changing: new Set(), changingSlots: new Set(), baseChangedSlots: new Set() };
        records.set(scene, record);
    }
    return record;
}
