// Ours (upstream issue #5133). The on-screen joystick is for devices used by touch, not for
// every screen that can be touched: a touchscreen laptop keeps its game clear.
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as any).window ??= { location: { search: "" } };

const media = (truths: string[]) => (query: string) => truths.includes(query);

test("a phone or tablet: touch, a coarse main pointer, no hover", async () => {
    const { isTouchFirst } = await import("../game/plugins/touchcontrols/TouchControlsPlugin");
    assert.equal(isTouchFirst(true, media(["(pointer: coarse)"])), true);
});

test("a laptop with a touchscreen: its main pointer is a mouse or trackpad, so no joystick", async () => {
    const { isTouchFirst } = await import("../game/plugins/touchcontrols/TouchControlsPlugin");
    assert.equal(isTouchFirst(true, media(["(pointer: fine)", "(hover: hover)"])), false);
});

test("a desktop with no touch at all: never", async () => {
    const { isTouchFirst } = await import("../game/plugins/touchcontrols/TouchControlsPlugin");
    assert.equal(isTouchFirst(false, media(["(pointer: fine)", "(hover: hover)"])), false);
    assert.equal(isTouchFirst(false, media(["(pointer: coarse)"])), false);
});

test("a tablet with a stylus (fine, but cannot hover) is still used by touch", async () => {
    const { isTouchFirst } = await import("../game/plugins/touchcontrols/TouchControlsPlugin");
    assert.equal(isTouchFirst(true, media(["(pointer: fine)"])), true);
});

test("a browser that cannot be asked: any touch screen counts, as before", async () => {
    const { isTouchFirst } = await import("../game/plugins/touchcontrols/TouchControlsPlugin");
    assert.equal(isTouchFirst(true), true);
    assert.equal(isTouchFirst(true, () => undefined), true);
    assert.equal(isTouchFirst(false), false);
});
