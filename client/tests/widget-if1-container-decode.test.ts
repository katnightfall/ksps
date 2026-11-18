import assert from "node:assert/strict";

import { CacheSystem } from "../rs/cache/CacheSystem";
import { WidgetLoader } from "../widgets/WidgetLoader";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

// OSRS's legacy (IF1) widget format has no child list: a type-0 container is its scroll height and
// hidden flag, and children name it through their parent id. Reading a 317-style child list after
// it overran every IF1 container, so the decoder dropped all of them.
const cacheInfo = loadCacheList(loadCacheInfos()).latest;
const cache = CacheSystem.fromFiles(cacheInfo, loadCache(cacheInfo).files);
const loader: any = new WidgetLoader(cache);

const failures: string[] = [];
const error = console.error;
console.error = (message?: unknown) => {
    failures.push(String(message));
};
let if1Containers = 0;
try {
    for (let group = 0; group < 1000; group++) {
        let fileIds: number[] | undefined;
        try {
            fileIds = loader.interfacesIndex.getFileIds(group);
        } catch {
            continue;
        }
        if (!fileIds?.length) continue;
        const loaded = loader.loadWidgetGroup(group);
        for (const widget of loaded?.widgets.values() ?? []) {
            if (!widget.isIf3 && widget.type === 0) if1Containers++;
        }
    }
} finally {
    console.error = error;
}
assert.deepEqual(failures, [], "every widget in the cache decodes");
// 236 since osrs-242_2026-11-11: Miscellania's kingdom interface (391), with 11 of them, was rebuilt
// as IF3.
assert.ok(if1Containers >= 236, `IF1 containers decoded (${if1Containers})`);

// Death Plateau's dice (death_dice, 99): container 27 holds the "Roll Dice!" label (28).
const dice = new WidgetLoader(cache).loadWidgetGroup(99);
const container = dice?.widgets.get((99 << 16) | 27);
assert.ok(container, "99:27 decodes");
assert.equal(container.type, 0);
assert.equal(container.isIf3, false);
const label = dice?.widgets.get((99 << 16) | 28);
assert.equal(label?.text, "Roll Dice!");
assert.equal(label?.parentUid, (99 << 16) | 27, "children link to the container through their parent id");

console.log("IF1 container decode test passed");
