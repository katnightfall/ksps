import { WorldPoint } from "@runelite/api/coords/WorldPoint";
import type { Box } from "../multilines/multiLines";

/*
 * The tracking half of RuneLite's NpcAggroAreaPlugin (Copyright (c) 2018, Woox
 * <https://github.com/wooxsolo>, BSD 2-Clause), ported from its onGameTick, timer and
 * login/logout code. From its own notes:
 *
 * How it works: The game remembers 2 tiles. When the player goes >10 steps away from both
 * tiles, the oldest one is moved to under the player and the NPC aggression timer resets.
 * So to first figure out where the 2 tiles are, we wait until the player teleports a long
 * enough distance. At that point it's very likely that the player moved out of the radius of
 * both tiles, which resets one of them. The other should reset shortly after as the player
 * starts moving around.
 *
 * One difference from RuneLite: distances count the plane. This server's tolerance regions
 * (server AggressionTolerance.ts) belong to one plane, so a change of floor leaves both regions
 * and restarts the ten minutes, where RuneLite measures in two dimensions only.
 */

export const SAFE_AREA_RADIUS = 10;
const UNKNOWN_AREA_RADIUS = SAFE_AREA_RADIUS * 2;
/** RuneLite's AGGRESSIVE_TIME_DURATION: ten minutes (the server's 1000 ticks). */
export const AGGRESSIVE_TIME_MS = 600_000;

/** RuneLite's WILDERNESS_ABOVE_GROUND and WILDERNESS_UNDERGROUND (x, y, width, height). */
const WILDERNESS_AREAS = [
    [2944, 3523, 448, 448],
    [2944, 9918, 320, 442],
];

/** RuneLite's isInWilderness (WorldPoint.isInArea2D of the two areas). */
export function isInWilderness(location: WorldPoint): boolean {
    return WILDERNESS_AREAS.some(([x, y, width, height]) =>
        location.getX() >= x && location.getX() < x + width && location.getY() >= y && location.getY() < y + height);
}

/** What a logout keeps, so a login at the same tile carries on (RuneLite's RS profile keys). */
export type SavedAggroArea = { center1: string; center2: string; location: string; duration: number };

const pack = (point: WorldPoint) => `${point.getX()},${point.getY()},${point.getPlane()}`;

function unpack(text: unknown): WorldPoint | null {
    const parts = String(text ?? "").split(",").map(Number);
    return parts.length === 3 && parts.every(Number.isInteger) ? new WorldPoint(parts[0], parts[1], parts[2]) : null;
}

export class AggroAreaTracker {
    readonly safeCenters: [WorldPoint | null, WorldPoint | null] = [null, null];
    /** Wall-clock time NPCs stop being aggressive, or null while no timer runs. */
    endTime: number | null = null;
    lastPlayerLocation: WorldPoint | null = null;
    private previousUnknownCenter: WorldPoint | null = null;
    private notifyOnce = false;

    /** RuneLite's createTimer. */
    private createTimer(durationMs: number, now: number): void {
        this.endTime = now + durationMs;
        this.notifyOnce = true;
    }

    /** RuneLite's removeTimer. */
    private removeTimer(): void {
        this.endTime = null;
        this.notifyOnce = false;
    }

    /** True once, when the timer has run out and its notification is still owed. */
    takeExpiry(now: number): boolean {
        if (!this.notifyOnce || this.endTime === null || now <= this.endTime) return false;
        this.notifyOnce = false;
        return true;
    }

    /** RuneLite's onGameTick, after the expiry notification. Returns whether the area changed. */
    tick(newLocation: WorldPoint, now: number): boolean {
        let changed = false;
        const centers = this.safeCenters;

        if (this.lastPlayerLocation) {
            if (centers[1] === null && newLocation.distanceTo(this.lastPlayerLocation) > SAFE_AREA_RADIUS * 4) {
                centers[0] = null;
                centers[1] = newLocation;
                this.createTimer(AGGRESSIVE_TIME_MS, now);
                changed = true;
                // We don't know where the previous area was, so if the player e.g. entered a
                // dungeon and then goes back out, they may enter the previous area, which is
                // unknown and would make the plugin inaccurate.
                this.previousUnknownCenter = this.lastPlayerLocation;
            }
        }

        if (centers[0] === null && this.previousUnknownCenter !== null
            && this.previousUnknownCenter.distanceTo(newLocation) <= UNKNOWN_AREA_RADIUS) {
            // Player went back to their previous unknown area before the 2nd center point was
            // found, which means we don't know where it is again.
            centers[1] = null;
            this.removeTimer();
            changed = true;
        }

        if (centers[1] !== null) {
            if (!centers.some((center) => center !== null && center.distanceTo(newLocation) <= SAFE_AREA_RADIUS)) {
                centers[0] = centers[1];
                centers[1] = newLocation;
                this.createTimer(AGGRESSIVE_TIME_MS, now);
                changed = true;
                this.previousUnknownCenter = null;
            }
        }

        this.lastPlayerLocation = newLocation;
        return changed;
    }

    /** The two 21x21 safe squares on a plane, as boxes of tiles (RuneLite's generateSafeArea). */
    boxes(plane: number): Box[] {
        return this.safeCenters
            .filter((center): center is WorldPoint => center !== null && center.getPlane() === plane)
            .map((center) => ({
                minX: center.getX() - SAFE_AREA_RADIUS,
                maxX: center.getX() + SAFE_AREA_RADIUS,
                minY: center.getY() - SAFE_AREA_RADIUS,
                maxY: center.getY() + SAFE_AREA_RADIUS,
                z: plane,
            }));
    }

    /** RuneLite's saveConfig: what to keep over a logout, or null when the area isn't known. */
    save(now: number): SavedAggroArea | null {
        const [center1, center2] = this.safeCenters;
        if (!center1 || !center2 || !this.lastPlayerLocation || this.endTime === null) return null;
        return { center1: pack(center1), center2: pack(center2), location: pack(this.lastPlayerLocation), duration: this.endTime - now };
    }

    /**
     * RuneLite's onLogin: take up what the last logout saved if the player is on the very tile
     * they logged out at; anywhere else the area probably changed, so start uncalibrated.
     */
    login(saved: SavedAggroArea | null, newLocation: WorldPoint, now: number): void {
        this.reset();
        const location = saved ? unpack(saved.location) : null;
        const center1 = saved ? unpack(saved.center1) : null;
        const center2 = saved ? unpack(saved.center2) : null;
        if (saved && location && center1 && center2 && Number.isFinite(saved.duration) && newLocation.distanceTo(location) === 0) {
            this.safeCenters[0] = center1;
            this.safeCenters[1] = center2;
            // An elapsed timer keeps its end time (the lines show the unaggressive colour) and owes nothing.
            this.createTimer(saved.duration, now);
            if (saved.duration < 0) this.notifyOnce = false;
        }
        this.lastPlayerLocation = newLocation;
    }

    /** The login screen and shutDown: nothing is known. */
    reset(): void {
        this.safeCenters[0] = null;
        this.safeCenters[1] = null;
        this.lastPlayerLocation = null;
        this.previousUnknownCenter = null;
        this.removeTimer();
    }
}

/** RuneLite's Timer.getText: minutes and seconds left, "9:59". */
export function timerText(remainingMs: number): string {
    const seconds = Math.max(0, Math.floor(remainingMs / 1000));
    return `${Math.floor((seconds % 3600) / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
