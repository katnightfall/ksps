// Ours: the make box (skillmulti) with a 100 button and amounts above 28 (rs/cs2/makeAmounts.ts),
// run through the cache's own scripts.
import assert from "node:assert/strict";

import { MAKE_AMOUNT_LIMIT, MAKE_MENU_SCRIPT, addMakeAmounts } from "../rs/cs2/makeAmounts";
import { Script } from "../rs/cs2/Script";

const GROUP = 270;
const [ONE, FIVE, TEN, SPARE, OTHER, ALL] = [7, 8, 9, 10, 11, 12];
const SET_AMOUNT_SCRIPT = 2059;

const { vm } = require("../scripts/cache/cs2-sweep").createCacheVm();
const wm = vm.context.widgetManager;
wm.rootInterface = 161;
wm.getGroup(GROUP);

/** The box opened for two products: the amount buttons as the player sees them. */
function open(most: number, suggested: number) {
    vm.run(vm.context.loadScript(MAKE_MENU_SCRIPT), [0, most, 52, 53, ...Array(16).fill(-1), suggested],
        ["How many sets would you like to make?|Arrow shaft|Headless arrow"]);
    assert.equal(vm.lastError, null);
    return buttons();
}

function buttons() {
    const out: Record<string, { text: string; chosen: boolean; amount: number | null }> = {};
    for (const [name, id] of Object.entries({ ONE, FIVE, TEN, SPARE, OTHER, ALL })) {
        const button = wm.getWidgetByUid((GROUP << 16) | id);
        const label = (button.children ?? []).find((child: any) => child?.type === 4);
        if (!label || button.hidden || button.isHidden) continue;
        const text = String(label.text ?? "");
        out[name] = {
            text: text.replace(/<[^>]+>/g, ""),
            chosen: text.includes("<col=ffffff>"),
            amount: button.onOp?.[0] === SET_AMOUNT_SCRIPT ? Number(button.onOp[2]) : null,
        };
    }
    return out;
}

/** Clicks an amount button: its own script with the click's arguments filled in. */
function click(id: number) {
    const button = wm.getWidgetByUid((GROUP << 16) | id);
    const [script, , ...rest] = button.onOp;
    vm.run(vm.context.loadScript(script), [1, ...rest], []);
    assert.equal(vm.lastError, null);
    return buttons();
}

// An inventory's worth: nothing new. 1, 5, 10, X and All, All chosen.
{
    const box = open(27, 27);
    assert.deepEqual(Object.keys(box), ["ONE", "FIVE", "TEN", "OTHER", "ALL"]);
    assert.equal(box.ALL.chosen, true);
    assert.equal(box.ONE.amount, 1);
}

// Exactly 100 can be made: All is the 100, so there is no second button for it.
assert.deepEqual(Object.keys(open(100, 100)), ["ONE", "FIVE", "TEN", "OTHER", "ALL"]);

// More than 100 can be made: a 100 button between 10 and X, All still the amount chosen.
{
    const box = open(333, 333);
    assert.deepEqual(Object.keys(box), ["ONE", "FIVE", "TEN", "SPARE", "OTHER", "ALL"]);
    assert.deepEqual(box.SPARE, { text: "100", chosen: false, amount: 100 });
    assert.equal(box.ALL.chosen, true);
    assert.equal(box.ALL.text, "All");
    const x = (id: number) => wm.getWidgetByUid((GROUP << 16) | id).x ?? wm.getWidgetByUid((GROUP << 16) | id).rawX;
    assert.ok(x(TEN) < x(SPARE) && x(SPARE) < x(OTHER) && x(OTHER) < x(ALL), "in order: 10, 100, X, All");

    // Clicking it chooses 100: the amount the item click then sends (varc 200).
    const after = click(SPARE);
    assert.equal(after.SPARE.chosen, true);
    assert.equal(after.ALL.chosen, false);
    assert.equal(after.ALL.amount, 333, "All is the most that can be made, above 28");
    assert.equal(click(FIVE).SPARE.amount, 100, "another amount chosen: the 100 button stays");
}

// The most a world may offer is the limit, not an inventory.
{
    const box = open(MAKE_AMOUNT_LIMIT + 5000, MAKE_AMOUNT_LIMIT + 5000);
    assert.equal(box.SPARE.text, "100");
    click(TEN);
    assert.equal(buttons().ALL.amount, MAKE_AMOUNT_LIMIT);
}

// A suggested amount of its own (the Sawmill's remembered one) keeps the spare button, as before.
{
    const box = open(27, 7);
    assert.deepEqual(box.SPARE, { text: "7", chosen: true, amount: null });
    const large = open(500, 250);
    assert.equal(large.SPARE.text, "250");
    assert.equal(large.SPARE.chosen, true);
}

// 1, 5 or 10 suggested: that button is chosen and the spare one is the 100.
{
    const box = open(500, 5);
    assert.equal(box.FIVE.chosen, true);
    assert.deepEqual(box.SPARE, { text: "100", chosen: false, amount: 100 });
}

// A script that is not the one expected is left alone.
{
    const other = new Script();
    other.id = MAKE_MENU_SCRIPT;
    other.instructions = new Int32Array([0, 21]);
    other.intOperands = new Int32Array([28, 0]);
    other.stringOperands = [null, null];
    assert.equal(addMakeAmounts(other), false);
    assert.deepEqual([...other.intOperands], [28, 0]);
}

console.log("make-amounts: ok");
