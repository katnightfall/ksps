import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { AreaLootPlugin } from "./AreaLootPlugin";
import type { AreaLootRow } from "./areaLoot";
import "./AreaLootWindow.css";

const formatCoins = (amount: number) => {
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}m`;
    if (amount >= 10_000) return `${Math.round(amount / 1000)}k`;
    return Math.round(amount).toLocaleString();
};

const tooltip = (row: AreaLootRow) =>
    `${row.name}${row.quantity > 1 ? ` x ${row.quantity.toLocaleString()}` : ""}` +
    `${row.value > 0 ? ` (${formatCoins(row.value)} gp)` : ""}, ${row.distance} ${row.distance === 1 ? "tile" : "tiles"} away`;

/** Everything a press on the window could tell the game underneath it. */
const SWALLOWED = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchend"] as const;

/**
 * Ours. The Area Loot window: a small in-game window over the game view that lists the drops in
 * reach as item pictures. A click on a picture takes that pile, "Take all" takes everything,
 * the title bar drags it, the cross closes it until something new drops.
 *
 * Its presses are handled on the window itself (not through React) and stopped there, so a
 * click on it is never also a click on the game behind it.
 */
export function AreaLootWindow({ plugin }: { plugin: AreaLootPlugin }): JSX.Element | null {
    const subscribe = useCallback((listener: () => void) => plugin.subscribe(listener), [plugin]);
    const getSnapshot = useCallback(() => plugin.getState(), [plugin]);
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const root = useRef<HTMLDivElement | null>(null);
    const open = state.open && state.rows.length > 0;

    useEffect(() => {
        const element = root.current;
        if (!element) return;
        let drag: { pointer: number; dx: number; dy: number } | undefined;
        const stop = (event: Event) => event.stopPropagation();
        const onClick = (event: Event) => {
            event.stopPropagation();
            const target = (event.target as HTMLElement | null)?.closest?.("[data-loot]") as HTMLElement | null;
            const action = target?.dataset.loot;
            if (action === "all") plugin.takeAll();
            else if (action === "close") plugin.dismiss();
            else if (action === "pile") {
                const row = plugin.getState().rows.find((entry) => entry.id === Number(target?.dataset.pile));
                if (row) plugin.take(row);
            }
        };
        const onDown = (event: PointerEvent) => {
            event.stopPropagation();
            const onTitle = (event.target as HTMLElement | null)?.closest?.(".area-loot-title");
            if (!onTitle || (event.target as HTMLElement).closest("[data-loot]")) return;
            const at = plugin.getState().position;
            drag = { pointer: event.pointerId, dx: event.clientX - at.x, dy: event.clientY - at.y };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        };
        const onMove = (event: PointerEvent) => {
            if (!drag || event.pointerId !== drag.pointer) return;
            const bounds = element.parentElement?.getBoundingClientRect();
            plugin.moveTo(event.clientX - drag.dx, event.clientY - drag.dy, bounds ? { width: bounds.width, height: bounds.height } : undefined,
                { width: element.offsetWidth, height: element.offsetHeight });
        };
        const onUp = (event: PointerEvent) => {
            if (!drag || event.pointerId !== drag.pointer) return;
            drag = undefined;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            plugin.savePosition();
        };
        for (const type of SWALLOWED) element.addEventListener(type, type === "click" ? onClick : type === "pointerdown" ? (onDown as EventListener) : stop);
        return () => {
            for (const type of SWALLOWED) element.removeEventListener(type, type === "click" ? onClick : type === "pointerdown" ? (onDown as EventListener) : stop);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
    }, [plugin, open]);

    if (!open) return null;
    const { rows, settings, position } = state;
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return (
        <div className="area-loot-layer">
            <div ref={root} className="area-loot-window" style={{ left: position.x, top: position.y }} role="dialog" aria-label="Area loot">
                <div className="area-loot-title">
                    <span>Loot ({rows.length})</span>
                    <button type="button" className="area-loot-close" data-loot="close" title="Close until something new drops" aria-label="Close">×</button>
                </div>
                <div className="area-loot-grid">
                    {rows.map((row) => {
                        const icon = plugin.iconFor(row.itemId, row.quantity);
                        return (
                            <button key={row.id} type="button" className="area-loot-cell" data-loot="pile" data-pile={row.id} title={tooltip(row)}>
                                {icon ? <img src={icon} alt={row.name} draggable={false} /> : <span className="area-loot-name">{row.name}</span>}
                            </button>
                        );
                    })}
                </div>
                <div className="area-loot-foot">
                    <span className="area-loot-sum" title={`Drops within ${settings.radius} tiles of you`}>{total > 0 ? `${formatCoins(total)} gp` : `${settings.radius} tiles`}</span>
                    <button type="button" className="area-loot-all" data-loot="all" title="Pick up everything shown (::loot)">Take all</button>
                </div>
            </div>
        </div>
    );
}
