import { useCallback, useSyncExternalStore } from "react";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import type { AreaLootPlugin } from "./AreaLootPlugin";

const formatCoins = (amount: number) => {
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}m`;
    if (amount >= 10_000) return `${Math.round(amount / 1000)}k`;
    return Math.round(amount).toLocaleString();
};

/** Ours. The Area Loot sidebar panel: what lies in reach, a button for all of it, a click for one pile. */
export function AreaLootPanel({ plugin }: { plugin: AreaLootPlugin }): JSX.Element {
    const subscribe = useCallback((listener: () => void) => plugin.subscribe(listener), [plugin]);
    const getSnapshot = useCallback(() => plugin.getState(), [plugin]);
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const { rows, settings } = state;
    const total = rows.reduce((sum, row) => sum + row.value, 0);

    return (
        <div className="rl-sidebar-panel-content" style={{ padding: 10, overflow: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
                <strong>Area loot</strong>
                <button type="button" onClick={() => plugin.takeAll()} disabled={!settings.enabled || rows.length === 0} title="Pick up everything listed (::loot)">
                    Take all
                </button>
            </div>
            {!settings.enabled ? (
                <p style={{ opacity: 0.75, lineHeight: 1.45 }}>Area loot is switched off on this world.</p>
            ) : (
                <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
                        <Summary label={`Piles within ${settings.radius} tiles`} value={rows.length.toLocaleString()} />
                        <Summary label="Est. GE value" value={`${formatCoins(total)} gp`} />
                    </div>
                    {rows.length === 0 ? (
                        <p style={{ opacity: 0.75, lineHeight: 1.45 }}>
                            Nothing to pick up nearby. Drops within {settings.radius} tiles of you are listed here.
                        </p>
                    ) : (
                        <div style={{ display: "grid", gap: 4 }}>
                            {rows.map((row) => (
                                <button
                                    key={row.id}
                                    type="button"
                                    onClick={() => plugin.take(row)}
                                    title={`Pick up ${row.name} (${row.distance} ${row.distance === 1 ? "tile" : "tiles"} away)`}
                                    style={{
                                        display: "flex", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", padding: "6px 7px",
                                        background: "#ffffff0f", color: "inherit", font: "inherit", border: "1px solid #ffffff1c", borderRadius: 4, cursor: "pointer",
                                    }}
                                >
                                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {row.name}{row.quantity > 1 ? ` × ${row.quantity.toLocaleString()}` : ""}
                                    </span>
                                    <span style={{ whiteSpace: "nowrap", opacity: 0.8 }}>
                                        {row.value > 0 ? `${formatCoins(row.value)} gp` : "—"}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                    <p style={{ opacity: 0.6, fontSize: 11, marginTop: 12, lineHeight: 1.4 }}>
                        Click a row for one pile, or Take all. Typing ::loot does the same.
                        {settings.wilderness ? "" : " Not in the Wilderness."} Items the world itself puts out are not listed.
                    </p>
                </>
            )}
        </div>
    );
}

function Summary({ label, value }: { label: string; value: string }): JSX.Element {
    return <div style={{ background: "#ffffff0a", borderRadius: 4, padding: 7 }}><div style={{ opacity: 0.65, fontSize: 11 }}>{label}</div><strong>{value}</strong></div>;
}

function AreaLootIcon({ label }: { label: string }): JSX.Element {
    return <svg className="rl-sidebar-icon-svg" viewBox="0 0 24 24" role="img" aria-label={label}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.4" />
        <path d="M8.2 10.6 12 8.4l3.8 2.2v4.6L12 17.4l-3.8-2.2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8.4 10.7 12 12.8l3.6-2.1M12 12.8v4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>;
}

export function createAreaLootNavigationButton(plugin: AreaLootPlugin): NavigationButton {
    return NavigationButton.builder()
        .tooltip("Area Loot")
        .icon(AreaLootIcon)
        .priority(8)
        .panel(() => <AreaLootPanel plugin={plugin} />)
        .build();
}
