// Ours. Overhead chat text on a display scaled above 100%: the text is drawn enlarged, so where it
// is put has to be worked out in the same scale. It was placed as if it were not enlarged, which
// left it lower by (padding + ascent) x (scale - 1) pixels: sunk into the speaker's head.
import assert from "node:assert/strict";
import { test } from "node:test";

import { OverheadTextLayer } from "../render/webgpu/overlays/OverheadTextLayer";

const ASCENT = 12;
const V_PADDING = 2;
const HEAD = { x: 400, y: 300 };

interface Quad { x: number; y: number; width: number; height: number }

/** Draws the entries once at `scale` and returns the queued quads and the stack offsets left. */
function draw(scale: number, entries: any[], stacks = new Map<number, number>()): { quads: Quad[]; stacks: Map<number, number> } {
    const quads: Quad[] = [];
    const args = {
        time: 0,
        state: { overheadTexts: entries, actor2dStacks: stacks },
        helpers: {
            getMinTileHeightInRadius: () => 0,
            worldToScreen: (worldX: number) => [HEAD.x + worldX, HEAD.y],
        },
    };
    const layer = new OverheadTextLayer(
        { canvas: { width: 1600, height: 1200 }, buildUpdateArgs: () => args } as any,
        {
            queueTexture(_texture: unknown, x: number, y: number, width: number, height: number) { quads.push({ x, y, width, height }); },
            releaseTexture() {},
        } as any,
    );
    Object.assign(layer, {
        scale,
        font: { maxAscent: ASCENT, ascent: ASCENT },
        ensureFont() {},
        // A 60 x 12 line of text in its texture: 2 pixels of padding all round.
        getTextTexture: () => ({ texture: {}, w: 64, h: ASCENT + 2 * V_PADDING, disposable: false }),
    });
    layer.draw();
    return { quads, stacks };
}

const speaker = (groupKey: number, worldX = 0) =>
    ({ worldX, worldZ: 0, plane: 0, heightOffsetTiles: 1.5, life: 1, effect: 0, duration: 100, remaining: 100, text: "Hello there", groupKey });

/** Where the text's baseline lands on the screen: the texture's own baseline, enlarged with it. */
const baselineOf = (quad: Quad, scale: number) => quad.y + (V_PADDING + ASCENT) * scale;

test("at 100% the text is where it was: its baseline 2 pixels under the head's top", () => {
    const { quads, stacks } = draw(1, [speaker(7)]);
    assert.equal(quads.length, 1);
    assert.equal(baselineOf(quads[0], 1), HEAD.y + 2);
    assert.deepEqual([quads[0].width, quads[0].height], [64, 16]);
    assert.equal(stacks.get(7), 10, "the head icons start 12 above the text's offset");
});

test("at 150% and 200% the same picture, enlarged: the baseline keeps its place on the head", () => {
    for (const scale of [1.5, 2]) {
        const { quads, stacks } = draw(scale, [speaker(7)]);
        assert.equal(baselineOf(quads[0], scale), HEAD.y + 2 * scale, `baseline at ${scale}`);
        // Before: the top was put at the 100% place, so the baseline hung this much lower.
        const oldTop = HEAD.y + 2 - V_PADDING - ASCENT;
        assert.equal(oldTop - quads[0].y, (V_PADDING + ASCENT) * (scale - 1) - 2 * (scale - 1), `raised at ${scale}`);
        assert.deepEqual([quads[0].width, quads[0].height], [64 * scale, 16 * scale]);
        assert.equal(Math.round(quads[0].x + quads[0].width / 2), HEAD.x, "centred on the speaker");
        assert.equal(stacks.get(7), 10 * scale, "the head icons' start is in the same scale");
    }
});

test("an offset already taken by this actor is used as it stands", () => {
    // A health bar, say, has moved this actor's offset to 20 screen pixels.
    const { quads, stacks } = draw(2, [speaker(7)], new Map([[7, 20]]));
    assert.equal(baselineOf(quads[0], 2), HEAD.y - 20);
    assert.equal(stacks.get(7), 20 + 12 * 2);
});

test("two speakers side by side: the second is pushed above the first by the enlarged line", () => {
    for (const scale of [1, 2]) {
        const { quads } = draw(scale, [speaker(1), speaker(2, 10)]);
        assert.equal(quads.length, 2);
        assert.equal(baselineOf(quads[0], scale) - baselineOf(quads[1], scale), ASCENT * scale, `one line apart at ${scale}`);
    }
});
