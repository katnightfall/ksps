import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import type { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { fetchContent } from "../../../network/serverConnection/contentApi";
import { sendChat } from "../../../network/ServerConnection";
import type { OsrsClient } from "../../OsrsClient";
import { createAreaLootNavigationButton } from "./AreaLootPanel";
import { DEFAULT_SETTINGS, lootCommand, lootInRange, readSettings, sameRows, type AreaLootRow, type AreaLootSettings } from "./areaLoot";

export type AreaLootState = { rows: readonly AreaLootRow[]; settings: AreaLootSettings; version: number };
type Listener = () => void;

/** How often the list is looked at again: the player walks, piles appear and expire. */
const REFRESH_MS = 600;

/**
 * Ours. Area loot: a sidebar panel that lists the ground items within the world's loot distance
 * and picks them up in one go, through the server's ::loot (server/plugins/world/AreaLoot.plugin.js).
 * "Take all" is ::loot; a click on a row is ::loot for that pile. The server decides what may
 * be taken (its own pick-up rules), so the list is a view, never a promise.
 */
export class AreaLootPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Area Loot",
        description: "List the items on the ground around you and pick them up in one click",
        tags: ["loot", "drops", "items", "ground", "pickup"],
        configKey: "arealootplugin",
    };

    private readonly client = inject<OsrsClient>(CLIENT_TOKEN);
    private readonly clientToolbar = inject(ClientToolbar);
    private readonly listeners = new Set<Listener>();
    private navButton?: NavigationButton;
    private timer?: ReturnType<typeof setInterval>;
    private settings: AreaLootSettings = DEFAULT_SETTINGS;
    private state: AreaLootState = { rows: [], settings: DEFAULT_SETTINGS, version: 0 };
    /** For tests: what a command is sent with. */
    send: (command: string) => void = (command) => sendChat(command, "public", 0);

    protected async startUp(): Promise<void> {
        this.navButton = createAreaLootNavigationButton(this);
        this.clientToolbar.addNavigation(this.navButton);
        this.loadSettings();
        this.timer = setInterval(() => this.refresh(), REFRESH_MS);
        this.refresh();
    }

    protected async shutDown(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (this.navButton) this.clientToolbar.removeNavigation(this.navButton);
        this.navButton = undefined;
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

    /** Reads the ground again; listeners hear only when what is listed changed. */
    refresh(force = false): void {
        let rows: AreaLootRow[] = [];
        try {
            rows = this.settings.enabled ? lootInRange(this.client.groundItems.getAllStacks(), this.playerTile(), this.settings.radius) : [];
        } catch {
            rows = [];
        }
        if (!force && sameRows(rows, this.state.rows) && this.settings === this.state.settings) return;
        this.state = { rows, settings: this.settings, version: this.state.version + 1 };
        for (const listener of this.listeners) listener();
    }

    takeAll(): void {
        this.send(lootCommand());
    }

    take(row: AreaLootRow): void {
        this.send(lootCommand(row));
    }
}
