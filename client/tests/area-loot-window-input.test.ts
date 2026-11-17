// Ours. The Area Loot window's mouse handling (game/plugins/arealoot/windowInput.ts), in a
// page: a drag by the title ends when the button is let go, though the window swallows every
// press on it so the game behind never hears one. (The first version swallowed its own release
// and the window stayed stuck to the cursor.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { attachLootWindowInput, type LootWindowActions } from "../game/plugins/arealoot/windowInput";
import { clampPosition, type AreaLootRow } from "../game/plugins/arealoot/areaLoot";

function page() {
    const dom = new JSDOM(
        '<div id="stage"><div class="area-loot-layer"><div class="area-loot-window">' +
        '<div class="area-loot-title"><span id="title">Loot (2)</span><button id="close" data-loot="close">x</button></div>' +
        '<div class="area-loot-grid"><button id="whip" data-loot="pile" data-pile="7"><img id="picture"></button>' +
        '<button id="bones" data-loot="pile" data-pile="8"></button></div>' +
        '<div class="area-loot-foot"><button id="all" data-loot="all">Take all</button></div>' +
        "</div></div></div>",
    );
    const view = dom.window as unknown as Window;
    const document = dom.window.document;
    const element = document.querySelector(".area-loot-window") as HTMLElement;
    const layer = document.querySelector(".area-loot-layer") as HTMLElement;
    layer.getBoundingClientRect = () => ({ width: 800, height: 500, left: 0, top: 0, right: 800, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    const rows = [{ id: 7, itemId: 4151, x: 3212, y: 3200 }, { id: 8, itemId: 526, x: 3201, y: 3200 }] as AreaLootRow[];
    const calls: string[] = [];
    let position = { x: 12, y: 48 };
    const actions: LootWindowActions = {
        getState: () => ({ rows, position }),
        takeAll: () => calls.push("all"),
        take: (row) => calls.push(`pile ${row.id}`),
        dismiss: () => calls.push("close"),
        moveTo: (x, y, bounds, size) => { position = clampPosition({ x, y }, bounds, size); },
        savePosition: () => calls.push(`saved ${position.x},${position.y}`),
    };
    // What the game behind the window would hear: anything that bubbles out of it.
    const heard: string[] = [];
    const stage = document.getElementById("stage") as HTMLElement;
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "contextmenu", "wheel"]) {
        stage.addEventListener(type, () => heard.push(type));
    }
    const send = (target: EventTarget, type: string, at: { x?: number; y?: number; buttons?: number; pointerId?: number } = {}) => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x ?? 0, clientY: at.y ?? 0, buttons: at.buttons ?? 0 });
        Object.defineProperty(event, "pointerId", { value: at.pointerId ?? 1 });
        target.dispatchEvent(event);
    };
    return { view, document, element, actions, calls, heard, send, at: () => position, byId: (id: string) => document.getElementById(id) as HTMLElement };
}

test("a drag by the title follows the pointer and lets go when the button is released over the window", () => {
    const p = page();
    const detach = attachLootWindowInput(p.element, p.actions, p.view);
    const title = p.byId("title");
    p.send(title, "pointerdown", { x: 50, y: 60, buttons: 1 });
    p.send(p.document, "pointermove", { x: 150, y: 160, buttons: 1 });
    assert.deepEqual(p.at(), { x: 112, y: 148 }, "moved as far as the pointer did");
    // The release lands on the window itself: it is under the cursor all through a drag.
    p.send(title, "pointerup", { x: 150, y: 160 });
    assert.deepEqual(p.calls, ["saved 112,148"], "let go, and where it is now is remembered");
    p.send(p.document, "pointermove", { x: 400, y: 300, buttons: 0 });
    p.send(p.document, "pointermove", { x: 420, y: 320, buttons: 1 });
    assert.deepEqual(p.at(), { x: 112, y: 148 }, "it no longer follows the cursor");
    assert.deepEqual(p.calls, ["saved 112,148"]);
    assert.deepEqual(p.heard, [], "and the game behind heard none of it");
    detach();
});

test("a release that was never heard still ends the drag: the next move has no button held", () => {
    const p = page();
    attachLootWindowInput(p.element, p.actions, p.view);
    p.send(p.byId("title"), "pointerdown", { x: 50, y: 60, buttons: 1 });
    p.send(p.document, "pointermove", { x: 90, y: 60, buttons: 1 });
    assert.deepEqual(p.at(), { x: 52, y: 48 });
    // The button came up outside the browser window: no pointerup arrives.
    p.send(p.document, "pointermove", { x: 300, y: 300, buttons: 0 });
    assert.deepEqual(p.at(), { x: 52, y: 48 }, "the move without a button is the end, not a move");
    assert.deepEqual(p.calls, ["saved 52,48"]);
    // So is a cancelled pointer, and the page losing the mouse.
    p.send(p.byId("title"), "pointerdown", { x: 60, y: 60, buttons: 1 });
    p.send(p.document, "pointercancel");
    p.send(p.byId("title"), "pointerdown", { x: 60, y: 60, buttons: 1 });
    p.view.dispatchEvent(new (p.view as any).Event("blur"));
    p.send(p.document, "pointermove", { x: 500, y: 400, buttons: 1 });
    assert.deepEqual(p.at(), { x: 52, y: 48 });
});

test("a drag stays inside the game view, and another finger does not move it", () => {
    const p = page();
    attachLootWindowInput(p.element, p.actions, p.view);
    p.send(p.byId("title"), "pointerdown", { x: 20, y: 60, buttons: 1, pointerId: 3 });
    p.send(p.document, "pointermove", { x: 5000, y: 5000, buttons: 1, pointerId: 3 });
    assert.deepEqual(p.at(), { x: 800, y: 500 }, "held at the view's edge (the window's own size is 0 in this page)");
    p.send(p.document, "pointermove", { x: 100, y: 100, buttons: 1, pointerId: 9 });
    assert.deepEqual(p.at(), { x: 800, y: 500 });
    p.send(p.document, "pointerup", { pointerId: 9 });
    p.send(p.document, "pointermove", { x: 30, y: 70, buttons: 1, pointerId: 3 });
    assert.deepEqual(p.at(), { x: 22, y: 58 }, "the dragging finger still has it");
    p.send(p.document, "pointerup", { pointerId: 3 });
    assert.deepEqual(p.calls, ["saved 22,58"]);
});

test("clicks do what they say and stay on the window; the cross and the items do not start a drag", () => {
    const p = page();
    const detach = attachLootWindowInput(p.element, p.actions, p.view);
    for (const id of ["picture", "bones", "all", "close"]) {
        p.send(p.byId(id), "pointerdown", { x: 100, y: 100, buttons: 1 });
        p.send(p.document, "pointermove", { x: 300, y: 300, buttons: 1 });
        p.send(p.byId(id), "pointerup");
        p.send(p.byId(id), "click");
    }
    assert.deepEqual(p.calls, ["pile 7", "pile 8", "all", "close"], "the picture inside an item's button counts as the item");
    assert.deepEqual(p.at(), { x: 12, y: 48 }, "nothing was dragged");
    p.send(p.element, "contextmenu");
    p.send(p.element, "wheel");
    p.send(p.element, "mousedown");
    assert.deepEqual(p.heard, [], "no press, wheel or right-click reaches the game");
    // Taken off, the window's element is an ordinary one again.
    detach();
    p.send(p.byId("all"), "click");
    assert.deepEqual(p.calls.length, 4);
    assert.deepEqual(p.heard, ["click"]);
});
