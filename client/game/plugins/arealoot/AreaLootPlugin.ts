import { createElement, lazy, type ReactNode } from "react";
import { ConfigChanged } from "@runelite/api/events";
import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { sendChat } from "../../../network/ServerConnection";
import { ItemIconRenderer } from "../../../ui/item/ItemIconRenderer";
import type { OsrsClient } from "../../OsrsClient";
import type { ClientPlugin } from "../ClientPluginManager";
import {
    clampPosition, DEFAULT_SETTINGS, lootCommand, lootInRange, parsePosition, readSettings, sameRows, windowOpen,
    type AreaLootPosition, type AreaLootRow, type AreaLootSettings,
} from "./areaLoot";

// Loaded when first drawn: the window brings its stylesheet with it.
const AreaLootWindow = lazy(() => import("./AreaLootWindow").then((m) => ({ default: m.AreaLootWindow })));

export const AreaLootConfig = ConfigGroup("arealoot", {
    autoOpen: ConfigItem({
        name: "Open by itself",
        description: "The loot window opens when something you can pick up drops near you. Off: it opens when you type ::lootwindow.",
        position: 0,
        default: true,
    }),
    position: ConfigItem({ name: "Window position", description: "Where the loot window was last dragged to.", hidden: true, default: "12,48" }),
});

export type AreaLootState = {
    rows: readonly AreaLootRow[];
    settings: AreaLootSettings;
    open: boolean;
    position: AreaLootPosition;
    version: number;
};
type Listener = () => void;

/** How often the ground is looked at again: the player walks, piles appear and expire. */
const REFRESH_MS = 600;
const ICON_CACHE = 400;

/**
 * Ours. Area loot: an in-game window that lists the drops within the world's loot distance and
 * picks them up without walking to each (the server's ::loot does the taking:
 * server/plugins/world/AreaLoot.plugin.js). It opens by itself when something drops in reach,
 * "Take all" is ::loot, a click on an item is ::loot for that pile. The server decides what may
 * be taken, by its own pick-up rules, so the window is a view, never a promise.
 *
 * ::lootwindow opens or closes it by hand.
 */
export class AreaLootPlugin extends Plugin implements ClientPlugin {
    static descriptor: PluginDescriptor = {
        name: "Area Loot",
        description: "A window in the game that lists the items on the ground around you and picks them up in one click",
        tags: ["loot", "drops", "items", "ground", "pickup"],
        configKey: "arealootplugin",
    };

    static config = AreaLootConfig;

    private readonly client = inject<OsrsClient>(CLIENT_TOKEN);
    private readonly configManager = inject(ConfigManager);
    private readonly listeners = new Set<Listener>();
    private timer?: ReturnType<typeof setInterval>;
    private settings: AreaLootSettings = DEFAULT_SETTINGS;
    private autoOpen = true;
    /** The piles that were listed when the window was closed: it stays closed until another appears. */
    private dismissed = new Set<number>();
    /** Opened by hand (::lootwindow), whatever "Open by itself" says. */
    private forced = false;
    private position: AreaLootPosition = { x: 12, y: 48 };
    private state: AreaLootState = { rows: [], settings: DEFAULT_SETTINGS, open: false, position: this.position, version: 0 };
    private iconRenderer?: { loader: unknown; renderer: ItemIconRenderer };
    private readonly icons = new Map<string, string | undefined>();
    /** For tests: what a command is sent with. */
    send: (command: string) => void = (command) => sendChat(command, "public", 0);

    protected async startUp(): Promise<void> {
        this.readConfig();
        this.loadSettings();
        this.timer = setInterval(() => this.refresh(), REFRESH_MS);
        this.refresh(true);
    }

    protected async shutDown(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.state = { ...this.state, rows: [], open: false, version: this.state.version + 1 };
        for (const listener of this.listeners) listener();
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() !== AreaLootConfig.group) return;
        this.readConfig();
        this.refresh(true);
    }

    private readConfig(): void {
        const config = this.configManager.getConfig(AreaLootConfig);
        this.autoOpen = config.autoOpen() !== false;
        this.position = parsePosition(String(config.position() ?? ""), this.position);
    }

    /** The world's loot distance; a world without the feature answers nothing and the defaults stand. */
    loadSettings(): Promise<void> {
        return Promise.resolve()
            .then(() => fetchContent("/api/area-loot"))
            .then((raw: unknown) => {
                this.settings = readSettings(raw);
                this.refresh(true);
            })
            .catch(() => {});
    }

    /** DOM over the game canvas: the window, while the plugin is on. */
    renderHud(_client: OsrsClient): ReactNode {
        return this.isEnabled() ? createElement(AreaLootWindow, { plugin: this }) : null;
    }

    /** ::lootwindow opens the window, or closes it. */
    handleClientCommand(command: string): boolean {
        if (!this.isEnabled() || command.trim().toLowerCase() !== "lootwindow") return false;
        if (this.state.open) this.dismiss();
        else {
            this.forced = true;
            this.dismissed.clear();
            this.refresh(true);
        }
        return true;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getState(): AreaLootState {
        return this.state;
    }

    private playerTile(): { x: number; y: number; level: number } | undefined {
        const client: any = this.client;
        const players = client.playerEcs;
        const index = players?.getIndexForServerId?.(client.controlledPlayerServerId);
        if (index === undefined || index === null || index < 0) return undefined;
        return { x: players.getX(index) >> 7, y: players.getY(index) >> 7, level: players.getLevel(index) | 0 };
    }

    /** Reads the ground again; listeners hear only when what is shown changed. */
    refresh(force = false): void {
        let rows: AreaLootRow[] = [];
        try {
            rows = this.settings.enabled ? lootInRange(this.client.groundItems.getAllStacks(), this.playerTile(), this.settings.radius) : [];
        } catch {
            rows = [];
        }
        if (rows.length === 0) {
            // Nothing left: the next drop opens the window afresh.
            this.dismissed.clear();
            this.forced = false;
        }
        const open = windowOpen(rows, this.dismissed, this.autoOpen, this.forced);
        if (!force && open === this.state.open && sameRows(rows, this.state.rows) && this.settings === this.state.settings
            && this.position === this.state.position) return;
        this.state = { rows, settings: this.settings, open, position: this.position, version: this.state.version + 1 };
        for (const listener of this.listeners) listener();
    }

    takeAll(): void {
        this.send(lootCommand());
    }

    take(row: AreaLootRow): void {
        this.send(lootCommand(row));
    }

    /** The cross: closed until a pile that is not listed now appears. */
    dismiss(): void {
        this.forced = false;
        this.dismissed = new Set(this.state.rows.map((row) => row.id));
        this.refresh(true);
    }

    /** A drag: the window follows, kept inside the game view. */
    moveTo(x: number, y: number, view?: { width: number; height: number }, size?: { width: number; height: number }): void {
        this.position = clampPosition({ x, y }, view, size);
        this.refresh(true);
    }

    /** The drag is over: where the window is now is where it opens next time. */
    savePosition(): void {
        this.configManager.setConfigValue(AreaLootConfig, "position", `${this.position.x},${this.position.y}`);
    }

    /** An item's inventory picture with its amount on it, as a data address; undefined when it cannot be drawn. */
    iconFor(itemId: number, quantity: number): string | undefined {
        const key = `${itemId}:${quantity}`;
        if (this.icons.has(key)) return this.icons.get(key);
        let icon: string | undefined;
        try {
            const { objTypeLoader, modelLoader, textureLoader, cacheSystem } = this.client as any;
            if (objTypeLoader && modelLoader && textureLoader) {
                if (this.iconRenderer?.loader !== objTypeLoader) {
                    this.iconRenderer = { loader: objTypeLoader, renderer: new ItemIconRenderer(objTypeLoader, modelLoader, textureLoader, cacheSystem) };
                    this.icons.clear();
                }
                icon = this.iconRenderer?.renderer.renderToCanvas(itemId, quantity, { outline: 1, shadow: 3153952, quantityMode: 2 })?.toDataURL();
            }
        } catch {
            icon = undefined;
        }
        if (this.icons.size >= ICON_CACHE) this.icons.clear();
        this.icons.set(key, icon);
        return icon;
    }
}
