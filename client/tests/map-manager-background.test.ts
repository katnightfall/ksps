// Ours: how many squares outside the view build at a time (MapManager.update). A pool of four
// builders builds two at a time; a smaller pool keeps to one, as before. What is in view always
// comes first, and nothing outside it starts until the view is ready.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientState } from "../game/ClientState";
import { MapManager } from "../game/MapManager";
import { getMapSquareId } from "../rs/map/MapFileIndex";

/** A manager over a nine-square grid whose four squares in view have just been asked for. */
function arrive(builders: number) {
    const queued: number[] = [];
    const manager = new MapManager<any>(builders, (x, y) => { queued.push(getMapSquareId(x, y)); });
    const camera = { getPosX: () => 3250, getPosZ: () => 3250 } as any;
    const update = (frame: number) => manager.update(3250, 3250, camera, frame, 1, 3224, 3200, 2, 25);
    const addMap = (id: number) => manager.addMap(id >> 8, id & 255, { mapX: id >> 8, mapY: id & 255, canRender: () => true, delete() {} });
    update(0);
    const inView = [...queued];
    return { manager, queued, update, addMap, inView };
}

function withDesktop(run: () => void): void {
    const instance = ClientState.inInstance;
    const lowEnd = MapManager.lowEnd;
    try {
        ClientState.inInstance = false;
        MapManager.lowEnd = false;
        run();
    } finally {
        ClientState.inInstance = instance;
        MapManager.lowEnd = lowEnd;
    }
}

for (const [builders, atATime] of [[4, 2], [3, 1], [2, 1], [1, 1]] as const) {
    test(`${builders} builders: ${atATime} out-of-view square${atATime > 1 ? "s" : ""} at a time, after the view`, () => withDesktop(() => {
        const { manager, queued, update, addMap, inView } = arrive(builders);
        assert.equal(manager.gridMapCount, 9);
        assert.equal(inView.length, 4, "only what is in view is asked for first");

        // Until the whole view is built, nothing outside it starts.
        for (const id of inView.slice(0, 3)) addMap(id);
        update(1);
        assert.equal(queued.length, 4);
        addMap(inView[3]);
        update(2);
        update(3);
        assert.equal(queued.length, 4 + atATime, "the surroundings start once the view is ready");
        assert.equal(manager.loadingMapIds.size, atATime);

        // Slow builds are not joined by more.
        for (let frame = 4; frame < 40; frame++) update(frame);
        assert.equal(queued.length, 4 + atATime, "no more than that many wait on the builders");

        // Each one that finishes lets the next start, until the grid is whole.
        let frame = 40;
        while (manager.loadingMapIds.size > 0 && frame < 200) {
            const done = [...manager.loadingMapIds][0];
            addMap(done);
            update(frame++);
            assert.ok(manager.loadingMapIds.size <= atATime);
        }
        assert.equal(new Set(queued).size, 9, "every square of the grid was built, each once");
        assert.equal(queued.length, 9);
    }));
}
