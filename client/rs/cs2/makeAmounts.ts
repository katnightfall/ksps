import { Opcodes } from "./Opcodes";
import type { Script } from "./Script";

/**
 * Ours: the "how many would you like to make" box (skillmulti, group 270) with a 100 button and
 * amounts above 28.
 *
 * The box is drawn by the cache's own script 2046 (skillmulti_setup), which takes the most that
 * can be made and a suggested amount. Two things in it are changed as it is loaded:
 *
 * 1. It clamps the most to an inventory's worth:
 *
 *        iconst 1; iconst 28; iload 1; gosub 1046 (min); gosub 1045 (max); istore 1
 *
 *    The 28 becomes MAKE_AMOUNT_LIMIT, so a world can offer more of something that stacks
 *    (sets of arrows, bolts and darts).
 *
 * 2. It keeps the suggested amount as both the chosen amount (varc 200) and the amount of the
 *    spare button between 10 and X (varc 201), which the cache only shows for an amount that is
 *    not 1, 5, 10 or the most (the amount last typed after X):
 *
 *        iload 20; iload 20; set_varc_int 201; set_varc_int 200
 *
 *    The spare button now starts as MAKE_AMOUNT_PRESET (100) unless the suggested amount needs
 *    it:
 *
 *        iload 20; set_varc_int 200
 *        if (suggested is 1, 5 or 10, or at least the most) varc 201 = 100 else varc 201 = suggested
 *
 *    The cache's own drawing (script 2055) then shows 100 exactly when more than 100 can be
 *    made, as it shows 5 and 10 only when more than 5 and 10 can. Typing an amount after X
 *    still puts that amount on the button.
 *
 * The second change makes the script longer, so the jumps and switches that cross it are moved.
 */
export const MAKE_MENU_SCRIPT = 2046;
export const MAKE_AMOUNT_PRESET = 100;
/** The most a world may offer; the chosen amount travels to the server as a short. */
export const MAKE_AMOUNT_LIMIT = 10000;

const INVENTORY_SIZE = 28;
const MIN_SCRIPT = 1046;
const MAX_SCRIPT = 1045;
const CHOSEN_VARC = 200;
const SPARE_VARC = 201;
const MOST_LOCAL = 1;
const SUGGESTED_LOCAL = 20;

type Op = [number, number];

const CLAMP: Op[] = [
    [Opcodes.ICONST, 1],
    [Opcodes.ICONST, INVENTORY_SIZE],
    [Opcodes.ILOAD, MOST_LOCAL],
    [Opcodes.INVOKE, MIN_SCRIPT],
    [Opcodes.INVOKE, MAX_SCRIPT],
    [Opcodes.ISTORE, MOST_LOCAL],
];
const KEEP_SUGGESTED: Op[] = [
    [Opcodes.ILOAD, SUGGESTED_LOCAL],
    [Opcodes.ILOAD, SUGGESTED_LOCAL],
    [Opcodes.SET_VARC_INT, SPARE_VARC],
    [Opcodes.SET_VARC_INT, CHOSEN_VARC],
];
/** Jumps are relative to the instruction after them. */
const KEEP_SUGGESTED_WITH_PRESET: Op[] = [
    [Opcodes.ILOAD, SUGGESTED_LOCAL],
    [Opcodes.SET_VARC_INT, CHOSEN_VARC],
    [Opcodes.ILOAD, SUGGESTED_LOCAL], [Opcodes.ICONST, 1], [Opcodes.IF_ICMPEQ, 12],
    [Opcodes.ILOAD, SUGGESTED_LOCAL], [Opcodes.ICONST, 5], [Opcodes.IF_ICMPEQ, 9],
    [Opcodes.ILOAD, SUGGESTED_LOCAL], [Opcodes.ICONST, 10], [Opcodes.IF_ICMPEQ, 6],
    [Opcodes.ILOAD, SUGGESTED_LOCAL], [Opcodes.ILOAD, MOST_LOCAL], [Opcodes.IF_ICMPGE, 3],
    [Opcodes.ILOAD, SUGGESTED_LOCAL], [Opcodes.SET_VARC_INT, SPARE_VARC], [Opcodes.JUMP, 2],
    [Opcodes.ICONST, MAKE_AMOUNT_PRESET], [Opcodes.SET_VARC_INT, SPARE_VARC],
];

const JUMPS: ReadonlySet<number> = new Set([
    Opcodes.JUMP, Opcodes.IF_ICMPNE, Opcodes.IF_ICMPEQ, Opcodes.IF_ICMPLT, Opcodes.IF_ICMPGT,
    Opcodes.IF_ICMPLE, Opcodes.IF_ICMPGE,
]);

function indexOfOps(script: Script, ops: readonly Op[]): number {
    for (let start = 0; start + ops.length <= script.instructions.length; start++) {
        if (ops.every(([opcode, operand], i) =>
            script.instructions[start + i] === opcode && script.intOperands[start + i] === operand)) {
            return start;
        }
    }
    return -1;
}

/**
 * Puts `ops` in place of the `length` instructions at `start`. A jump or switch entry from
 * outside the replaced instructions to a place after them is moved by the difference in length.
 */
function replaceOps(script: Script, start: number, length: number, ops: readonly Op[]): void {
    const end = start + length;
    const grown = ops.length - length;
    const moved = (from: number, offset: number): number => {
        const to = from + 1 + offset;
        if (from < start && to >= end) return offset + grown;
        if (from >= end && to <= start) return offset - grown;
        return offset;
    };
    for (let i = 0; i < script.instructions.length; i++) {
        if (i >= start && i < end) continue;
        const opcode = script.instructions[i];
        if (JUMPS.has(opcode)) {
            script.intOperands[i] = moved(i, script.intOperands[i]);
        } else if (opcode === Opcodes.SWITCH) {
            const table = script.switches?.[script.intOperands[i]];
            if (table) for (const [key, offset] of table) table.set(key, moved(i, offset));
        }
    }
    const count = script.instructions.length + grown;
    const instructions = new Int32Array(count);
    const intOperands = new Int32Array(count);
    const longOperands = new BigInt64Array(count);
    const stringOperands: (string | null)[] = new Array(count).fill(null);
    for (let i = 0; i < script.instructions.length; i++) {
        if (i >= start && i < end) continue;
        const at = i < start ? i : i + grown;
        instructions[at] = script.instructions[i];
        intOperands[at] = script.intOperands[i];
        if (i < script.longOperands.length) longOperands[at] = script.longOperands[i];
        stringOperands[at] = script.stringOperands[i] ?? null;
    }
    ops.forEach(([opcode, operand], i) => {
        instructions[start + i] = opcode;
        intOperands[start + i] = operand;
    });
    script.instructions = instructions;
    script.intOperands = intOperands;
    script.longOperands = script.longOperands.length > 0 ? longOperands : script.longOperands;
    script.stringOperands = stringOperands;
}

/**
 * Gives the box its 100 button and its higher limit; false (unchanged) if the script is not the
 * one expected. Both changes are made or neither.
 */
export function addMakeAmounts(script: Script): boolean {
    const clamp = indexOfOps(script, CLAMP);
    const keep = indexOfOps(script, KEEP_SUGGESTED);
    if (clamp < 0 || keep < 0) return false;
    script.intOperands[clamp + 1] = MAKE_AMOUNT_LIMIT;
    replaceOps(script, keep, KEEP_SUGGESTED.length, KEEP_SUGGESTED_WITH_PRESET);
    return true;
}

export function applyMakeAmounts(script: Script): void {
    if (script.id !== MAKE_MENU_SCRIPT) return;
    if (!addMakeAmounts(script)) {
        console.warn(`[cs2] script ${script.id}: not the make box expected; it keeps the cache's amounts`);
    }
}
