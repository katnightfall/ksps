// Ours (upstream issue #6240, "trees lag after being cut"): a tree, a rock or a stall, and what
// the server puts in its place, is drawn with the doors, so that the server changing one rebuilds
// only that small group of the map square and not all of its scenery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BuildSteps, finishBuild } from "../common/utils/BuildSteps";
import { LOC_OVERRIDE_REMOVED } from "../rs/scene/LocOverride";
import { isChangingLocType, isStillLocType } from "../rs/scene/ChangingLocs";
import { isChangingCacheLoc, isChangingTile, isDoorGroupAddedLoc, isDoorGroupChange } from "../render/loc/DoorGroupLocs";
import { CACHE_FORMAT } from "../game/worker/MapSquareCache";

const same = (a: ArrayBufferView | undefined, b: ArrayBufferView | undefined) =>
    !!a && !!b && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

test("a felled tree, an emptied stall and their return rebuild only the door group", async () => {
    const { CacheSystem } = await import("../rs/cache/CacheSystem");
    const { getCacheLoaderFactory } = await import("../rs/cache/loader/CacheLoaderFactory");
    const { LocModelLoader } = await import("../rs/config/loctype/LocModelLoader");
    const { VarManager } = await import("../rs/config/vartype/VarManager");
    const { SceneBuilder } = await import("../rs/scene/SceneBuilder");
    const { MinimapImageRenderer } = await import("../rs/map/MinimapImageRenderer");
    const { SdMapDataLoader } = await import("../render/loader/SdMapDataLoader");
    const { Hasher } = await import("../common/utils/Hasher");
    const { loadCache, loadCacheInfos, loadCacheList } = await import("../scripts/cache/load-util");
    await Hasher.init();
    const cache = loadCache(loadCacheList(loadCacheInfos()).latest);
    const cacheSystem = CacheSystem.fromFiles(cache.info, cache.files);
    const factory = getCacheLoaderFactory(cache.info, cacheSystem);
    const locTypeLoader = factory.getLocTypeLoader(), textureLoader = factory.getTextureLoader();
    const locModelLoader = new LocModelLoader(locTypeLoader, factory.getModelLoader(), textureLoader,
        factory.getSeqTypeLoader(), factory.getSeqFrameLoader(), factory.getSkeletalSeqLoader());
    const state: any = { cache, cacheSystem, locTypeLoader, textureLoader, locModelLoader,
        varManager: new VarManager(factory.getVarBitTypeLoader()), npcInstances: [],
        sceneBuilder: new SceneBuilder(cache.info, factory.getMapFileLoader(), factory.getUnderlayTypeLoader(),
            factory.getOverlayTypeLoader(), locTypeLoader, locModelLoader, cache.xteas),
        minimapImageRenderer: new MinimapImageRenderer(locTypeLoader, factory.getMapScenes()),
    };
    const log = console.log;
    console.log = (...args: unknown[]) => { if (!String(args[0]).startsWith("[SceneBuilder]")) log(...args); };
    const loader = new SdMapDataLoader();
    const immediate = new BuildSteps();
    immediate.run = async (steps) => finishBuild(steps);

    // Civitas illa Fortis, where the issue was reported: the Tree by the bird fountain, its
    // stump, and the Baker's stall with the nameless object that is the stall emptied.
    const TREE = 52823, STUMP = 1342, STALL = 51937, EMPTY_STALL = 51938;
    const tree = locTypeLoader.load(TREE), stump = locTypeLoader.load(STUMP);
    assert.equal(tree.name, "Tree");
    assert.equal(isChangingLocType(tree, 10), true, "a tree changes in play");
    assert.equal(isChangingLocType(locTypeLoader.load(STALL), 10), true, "a stall changes in play");
    assert.equal(isChangingLocType(stump, 10), false, "a stump is told by the tree it replaced, not by itself");
    assert.equal(isStillLocType(stump, 10), true);
    assert.equal(isChangingLocType(locTypeLoader.load(EMPTY_STALL), 10), false);

    const input = { mapX: 26, mapY: 48, maxLevel: 3, loadNpcs: false, smoothTerrain: true,
        minimizeDrawCalls: true, minimapLevel: 0, loadedTextureIds: new Set<number>() };
    const build = async (extra: object) => (await loader.load(state, { ...input, ...extra } as any, immediate)).data!;
    const whole = await build({});
    assert.ok(whole.locSignature, "a build says what its loc group holds");

    /** Where the cache puts `id` in the square: its tile, plane, shape and rotation. */
    const find = (id: number) => {
        for (let level = 0; level < 4; level++) {
            const ids = whole.tileLocIdsByLevel[level], offsets = whole.tileLocOffsetsByLevel[level];
            for (let tile = 0; tile < 64 * 64; tile++) for (let at = offsets[tile]; at < offsets[tile + 1]; at++) {
                if (ids[at] !== id) continue;
                const typeRot = whole.tileLocTypeRotByLevel[level][at];
                return { x: 26 * 64 + (tile % 64), y: 48 * 64 + Math.floor(tile / 64), level, shape: typeRot & 0x3f, rotation: typeRot >> 6 };
            }
        }
        throw new Error(`loc ${id} is not in the square`);
    };
    /** What the renderers hold after the server swaps the cache loc at `at` for `id` (LOC_DEL, LOC_ADD_CHANGE). */
    const swapped = (at: ReturnType<typeof find>, cacheId: number, id: number) => ({
        locOverrides: new Map([[`${at.x},${at.y},${at.level},${cacheId}`, { newId: LOC_OVERRIDE_REMOVED }]]),
        extraLocs: [{ id, x: at.x, y: at.y, level: at.level, shape: at.shape, rotation: at.rotation }],
    });

    const treeAt = find(TREE);
    assert.equal(treeAt.shape, 10);
    const stallAt = find(STALL);
    for (const [name, change] of [
        ["the tree felled", swapped(treeAt, TREE, STUMP)],
        ["the tree grown back", swapped(treeAt, TREE, TREE)],
        ["the stall emptied", swapped(stallAt, STALL, EMPTY_STALL)],
    ] as const) {
        const started = performance.now();
        const doors = await build({ ...change, doorOnly: true });
        const doorMs = performance.now() - started;
        const fresh = await build(change);
        assert.equal(doors.locSignature, whole.locSignature, `${name}: the loc group holds what it held`);
        assert.ok(same(fresh.loc.vertices, whole.loc.vertices) && same(fresh.loc.indices, whole.loc.indices),
            `${name}: the loc group drawn before the change is the one a new build draws`);
        assert.ok(same(doors.doorVertices, fresh.doorVertices) && same(doors.doorIndices, fresh.doorIndices),
            `${name}: the door-only build draws what a new build of the whole square draws`);
        assert.deepEqual(doors.tileLocIdsByLevel, fresh.tileLocIdsByLevel, `${name}: the objects listed per tile`);
        if (change.extraLocs[0].id !== TREE) {
            assert.ok(!same(doors.doorVertices, whole.doorVertices), `${name}: the door group changed`);
        } else {
            assert.ok(same(doors.doorVertices, whole.doorVertices), `${name}: it is drawn as the cache's own tree is`);
        }
        log(`${name}: door-only build ${Math.round(doorMs)} ms, ${doors.doorVertices.length} bytes of vertices (loc group: ${whole.loc.vertices.length})`);
    }

    // A loc-only build draws everything but the ground: what a renderer asks for when a door-only
    // build shows that the loc group changed too.
    const locOnly = await build({ ...swapped(treeAt, TREE, STUMP), locOnly: true });
    const cut = await build(swapped(treeAt, TREE, STUMP));
    assert.ok(same(locOnly.loc.vertices, cut.loc.vertices) && same(locOnly.doorVertices, cut.doorVertices) &&
        same(locOnly.doorIndices, cut.doorIndices), "a loc-only build carries the loc group and the door group");
    assert.equal(locOnly.locSignature, cut.locSignature);

    // An object that is no tree, rock or stall stays in the loc group, and one put in its place
    // goes there too: the door-only build then says that the loc group is out of date.
    const other = (() => {
        const ids = whole.tileLocIdsByLevel[0], offsets = whole.tileLocOffsetsByLevel[0];
        for (let tile = 0; tile < 64 * 64; tile++) for (let at = offsets[tile]; at < offsets[tile + 1]; at++) {
            const typeRot = whole.tileLocTypeRotByLevel[0][at], type = locTypeLoader.load(ids[at]);
            if ((typeRot & 0x3f) !== 10 || isChangingLocType(type, 10) || !isStillLocType(type, 10)) continue;
            if (type.name === "null" || /door|gate/i.test(type.name) || type.actions.some((action: string) => /open|close/i.test(action ?? ""))) continue;
            return { id: ids[at], at: { x: 26 * 64 + (tile % 64), y: 48 * 64 + Math.floor(tile / 64), level: 0, shape: 10, rotation: typeRot >> 6 } };
        }
        throw new Error("no ordinary object in the square");
    })();
    const replaced = swapped(other.at, other.id, STUMP);
    const staleDoors = await build({ ...replaced, doorOnly: true });
    assert.notEqual(staleDoors.locSignature, whole.locSignature, "replacing an ordinary object changes the loc group");
    const rebuilt = await build({ ...replaced, locOnly: true });
    const replacedWhole = await build(replaced);
    assert.equal(rebuilt.locSignature, staleDoors.locSignature, "every kind of build of one scene gives the same text");
    assert.equal(replacedWhole.locSignature, staleDoors.locSignature);
    assert.ok(same(rebuilt.loc.vertices, replacedWhole.loc.vertices) && same(rebuilt.doorVertices, replacedWhole.doorVertices));
    assert.ok(!same(rebuilt.loc.vertices, whole.loc.vertices), "the stump that replaced it is drawn in the loc group");
    assert.ok(same(rebuilt.doorVertices, whole.doorVertices), "and not with the doors");

    // The renderers' forecast of which build to ask for.
    assert.equal(isChangingCacheLoc(locTypeLoader, TREE, 10), true);
    assert.equal(isDoorGroupChange(locTypeLoader, TREE, STUMP), true);
    assert.equal(isDoorGroupChange(locTypeLoader, TREE, 0), true);
    assert.equal(isDoorGroupChange(locTypeLoader, other.id, STUMP), false);
    const felled = new Map([[`1696,3102,0,${TREE}`, { newId: LOC_OVERRIDE_REMOVED }]]); // the tree by the fountain
    assert.equal(isChangingTile(felled, locTypeLoader, { x: 1696, y: 3102 }, 0, [], 10), true,
        "a felled tree's tile is known by the override that hides the tree");
    assert.equal(isChangingTile(new Map(), locTypeLoader, { x: 1696, y: 3102 }, 0, [TREE], 10), true);
    assert.equal(isChangingTile(felled, locTypeLoader, { x: 1697, y: 3102 }, 0, [other.id], 10), false);
    assert.equal(isDoorGroupAddedLoc(locTypeLoader, STUMP, 10, true), true);
    assert.equal(isDoorGroupAddedLoc(locTypeLoader, STUMP, 10, false), false, "a stump on a tile with no tree is ordinary scenery");
    assert.equal(isDoorGroupAddedLoc(locTypeLoader, TREE, 10, false), true);
    const fire = locTypeLoader.load(26185);
    assert.notEqual(fire.seqId, -1, "a fire is animated");
    assert.equal(isDoorGroupAddedLoc(locTypeLoader, 26185, 10, true), false, "an animated object is drawn with the animated locs");

    assert.ok(CACHE_FORMAT >= 8, "squares stored with their trees in the loc group must not be reused");
    console.log = log;
});
