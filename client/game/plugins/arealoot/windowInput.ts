import type { AreaLootPosition, AreaLootRow } from "./areaLoot";

/** What the window's presses act on (the plugin; a stand-in in tests). */
export type LootWindowActions = {
    getState(): { rows: readonly AreaLootRow[]; position: AreaLootPosition };
    takeAll(): void;
    take(row: AreaLootRow): void;
    dismiss(): void;
    moveTo(x: number, y: number, view?: { width: number; height: number }, size?: { width: number; height: number }): void;
    savePosition(): void;
};

/** Everything a press on the window could tell the game underneath it. */
const SWALLOWED = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchend"] as const;

/**
 * Ours. The Area Loot window's mouse and touch handling, on the window's own element.
 *
 * Every press on the window stops there, so a click on it is never also a click on the game
 * behind it. That includes the release of the button, and the release is also what ends a drag:
 * so the drag listens for it on the page itself in the capture phase, where it is heard before
 * the window (or anything else) can stop it. Listening for it the ordinary way, the window
 * swallowed its own release and stayed stuck to the cursor.
 *
 * A drag also ends when the pointer is cancelled, when the page loses the mouse, and when a
 * move arrives with no button held (the release happened somewhere it was not heard).
 *
 * Returns what undoes it all.
 */
export function attachLootWindowInput(element: HTMLElement, actions: LootWindowActions, view: Window = window): () => void {
    let drag: { pointer: number | undefined; dx: number; dy: number } | undefined;

    const samePointer = (event: PointerEvent) => drag?.pointer === undefined || event.pointerId === undefined || event.pointerId === drag.pointer;

    const endDrag = () => {
        if (!drag) return;
        drag = undefined;
        view.removeEventListener("pointermove", onMove as EventListener, true);
        view.removeEventListener("pointerup", onUp as EventListener, true);
        view.removeEventListener("pointercancel", onUp as EventListener, true);
        view.removeEventListener("blur", endDrag);
        actions.savePosition();
    };
    const onMove = (event: PointerEvent) => {
        if (!drag || !samePointer(event)) return;
        if (event.buttons === 0) {
            endDrag();
            return;
        }
        const bounds = element.parentElement?.getBoundingClientRect();
        actions.moveTo(event.clientX - drag.dx, event.clientY - drag.dy,
            bounds && bounds.width > 0 && bounds.height > 0 ? { width: bounds.width, height: bounds.height } : undefined,
            { width: element.offsetWidth, height: element.offsetHeight });
    };
    const onUp = (event: PointerEvent) => {
        if (drag && samePointer(event)) endDrag();
    };
    const onDown = (event: PointerEvent) => {
        event.stopPropagation();
        const target = event.target as HTMLElement | null;
        // The title bar drags; the cross on it is a button.
        if (!target?.closest?.(".area-loot-title") || target.closest("[data-loot]")) return;
        endDrag();
        const at = actions.getState().position;
        drag = { pointer: event.pointerId, dx: event.clientX - at.x, dy: event.clientY - at.y };
        view.addEventListener("pointermove", onMove as EventListener, true);
        view.addEventListener("pointerup", onUp as EventListener, true);
        view.addEventListener("pointercancel", onUp as EventListener, true);
        view.addEventListener("blur", endDrag);
    };
    const onClick = (event: Event) => {
        event.stopPropagation();
        const target = (event.target as HTMLElement | null)?.closest?.("[data-loot]") as HTMLElement | null;
        const action = target?.dataset.loot;
        if (action === "all") actions.takeAll();
        else if (action === "close") actions.dismiss();
        else if (action === "pile") {
            const row = actions.getState().rows.find((entry) => entry.id === Number(target?.dataset.pile));
            if (row) actions.take(row);
        }
    };
    const stop = (event: Event) => event.stopPropagation();
    const handlerFor = (type: string): EventListener => (type === "click" ? onClick : type === "pointerdown" ? (onDown as EventListener) : stop);

    for (const type of SWALLOWED) element.addEventListener(type, handlerFor(type));
    return () => {
        for (const type of SWALLOWED) element.removeEventListener(type, handlerFor(type));
        if (drag) {
            // The window is going (its list emptied mid-drag): let go without saving a half-made move.
            drag = undefined;
            view.removeEventListener("pointermove", onMove as EventListener, true);
            view.removeEventListener("pointerup", onUp as EventListener, true);
            view.removeEventListener("pointercancel", onUp as EventListener, true);
            view.removeEventListener("blur", endDrag);
        }
    };
}
