import type { Client, NPC } from "@runelite/api/Client";
import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged, GameStateChanged, NpcSpawned } from "@runelite/api/events";
import type { ConfigOf } from "@runelite/client/config/ConfigItem";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Notifier } from "@runelite/client/Notifier";
import { openConfiguration } from "@runelite/client/plugins/config/configurationRequests";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { overlayFont } from "@runelite/client/ui/overlay/OverlayFonts";
import { OverlayPosition } from "@runelite/client/ui/overlay/OverlayPosition";
import { ClientImpl } from "../../../runelite/impl/ClientImpl";
import { skillIconSprite } from "../../../rs/skill/skillIcons";
import { SkillId } from "../../../rs/skill/skills";
import { drawTextGL } from "../../../widgets/components/TextRenderer";
import type { OsrsClient } from "../../OsrsClient";
import { COMBAT_INFOBOX_SIZE } from "../../widgets/MobileHudLayout";
import type { OverlayMenuEntry, WidgetOverlay, WidgetOverlayDrawContext } from "../ClientPluginManager";
import { multiBorders } from "../multilines/multiLines";
import { argbToRgba } from "../npcindicators/NpcIndicatorsConfig";
import { fromCSV, wildcardMatches } from "../npcindicators/npcMatching";
import { AggroAreaTracker, isInWilderness, timerText, type SavedAggroArea } from "./aggroArea";
import { NpcAggroAreaConfig } from "./NpcAggroAreaConfig";

type Rgba = [number, number, number, number];
type Rect = { x: number; y: number; w: number; h: number };
type Line = { points: [number, number][]; color: Rgba };
type NotifyClient = { notify(message: string): void };

/** RuneLite's MAX_LOCAL_DRAW_LENGTH: lines are drawn up to 20 tiles from the player. */
const DRAW_RADIUS = 20;
/** RuneLite strokes 1 px on its own canvas; ours is scaled with the game, so a line needs 2 to show. */
const LINE_WIDTH = 2;
const WHITE = 0xffffff;
/** Color.RED.brighter(). */
const RED_BRIGHTER = 0xff0000;
const rgba = (r: number, g: number, b: number, a = 255): Rgba => [r / 255, g / 255, b / 255, a / 255];
/** RuneLite's ComponentConstants.STANDARD_BACKGROUND_COLOR and the infobox outline. */
const BACKGROUND = rgba(70, 61, 50, 156);
const OUTLINE = rgba(56, 48, 35, 255);
const INFOBOX_SIZE = COMBAT_INFOBOX_SIZE;
const INFOBOX_GAP = 2;
const INFOBOX_ICON = 22;

/**
 * RuneLite's NPC Aggression Timer (NpcAggroAreaPlugin, Copyright (c) 2018, Woox
 * <https://github.com/wooxsolo>, BSD 2-Clause): a timer until nearby NPCs stop being aggressive,
 * and the border of the area whose crossing restarts it. The tracking is aggroArea.ts; this file
 * is the plugin's wiring, its NPC matching and its two overlays.
 */
export class NpcAggroAreaPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "NPC Aggression Timer",
        enabledByDefault: false,
        description: "Highlights the unaggressive area of NPCs nearby and timer until it becomes active",
        tags: ["highlight", "lines", "unaggro", "aggro", "aggressive", "npcs", "area", "slayer"],
        configKey: "npcaggroareaplugin",
    };

    static config = NpcAggroAreaConfig;

    readonly config: ConfigOf<typeof NpcAggroAreaConfig>;
    readonly tracker = new AggroAreaTracker();
    private readonly configManager: ConfigManager;
    private readonly client: Client;
    private readonly notifier: NotifyClient;
    private readonly overlays: WidgetOverlay[];
    private active = false;
    private npcNamePatterns: string[] = [];
    private loggingIn = false;
    private pendingLogin = false;
    private accountName: string | null = null;
    /** Overridable wall clock. */
    now: () => number = () => Date.now();

    constructor(private readonly osrsClient?: OsrsClient, deps?: { client?: Client; configManager?: ConfigManager; notifier?: NotifyClient }) {
        super();
        if (!deps?.client) this.osrsClient ??= inject<OsrsClient>(CLIENT_TOKEN);
        this.client = deps?.client ?? new ClientImpl(this.osrsClient!);
        this.configManager = deps?.configManager ?? inject(ConfigManager);
        this.config = this.configManager.getConfig(NpcAggroAreaConfig);
        this.notifier = deps?.notifier ?? new Notifier(this.osrsClient!);
        this.overlays = [new NpcAggroAreaOverlay(this), new AggressionInfoBoxOverlay(this)];
    }

    protected async startUp(): Promise<void> {
        this.npcNamePatterns = fromCSV(String(this.config.npcNamePatterns() ?? ""));
        this.loggingIn = this.client.getGameState() !== GameState.LOGGED_IN;
        this.scanNpcs();
    }

    protected async shutDown(): Promise<void> {
        this.tracker.reset();
        this.loggingIn = false;
        this.pendingLogin = false;
        this.npcNamePatterns = [];
        this.active = false;
    }

    widgetOverlays(): WidgetOverlay[] {
        return this.isStarted() ? this.overlays : [];
    }

    isActive(): boolean {
        return this.active;
    }

    /** RuneLite's shouldDisplayTimer. */
    shouldDisplayTimer(): boolean {
        return this.active && this.config.showTimer() === true;
    }

    getOsrsClient(): OsrsClient | undefined {
        return this.osrsClient;
    }

    openSettings(): void {
        openConfiguration(NpcAggroAreaPlugin);
    }

    /** The player's tile, when logged in. */
    playerTile(): { x: number; y: number; plane: number } | undefined {
        if (this.client.getGameState() !== GameState.LOGGED_IN) return undefined;
        const location = this.client.getLocalPlayer()?.getWorldLocation();
        return location ? { x: location.getX(), y: location.getY(), plane: location.getPlane() } : undefined;
    }

    private isNpcMatch(npc: NPC): boolean {
        const composition = npc.getComposition();
        const name = composition?.getName();
        const player = this.client.getLocalPlayer();
        if (!composition || !name || !player) return false;
        // Most NPCs stop aggroing when the player has more than double its combat level.
        const playerLevel = player.getCombatLevel();
        const npcLevel = composition.getCombatLevel();
        if (npcLevel > 0 && playerLevel > npcLevel * 2 && !isInWilderness(npc.getWorldLocation())) return false;
        const npcName = name.toLowerCase();
        return this.npcNamePatterns.some((pattern) => wildcardMatches(pattern, npcName));
    }

    private scanNpcs(): void {
        this.active = this.config.alwaysActive() === true || this.client.getNpcs().some((npc) => this.isNpcMatch(npc));
    }

    onNpcSpawned(event: NpcSpawned): void {
        if (this.active) return;
        const npc = this.client.getNpcByIndex(event.getNpc().index);
        if (npc && this.isNpcMatch(npc)) this.active = true;
    }

    onGameTick(): void {
        const player = this.client.getLocalPlayer();
        if (!player) return;
        const location = player.getWorldLocation();
        const now = this.now();
        this.accountName = player.getName() || this.accountName;
        if (this.pendingLogin) {
            this.pendingLogin = false;
            this.tracker.login(this.takeSaved(), location, now);
            this.scanNpcs();
        }
        if (this.active && this.tracker.takeExpiry(now) && this.config.notifyExpire() === true) {
            this.notifier.notify("NPC aggression has expired!");
        }
        this.tracker.tick(location, now);
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() !== NpcAggroAreaConfig.group) return;
        switch (event.getKey()) {
            case "npcUnaggroAlwaysActive":
                this.scanNpcs();
                break;
            case "npcUnaggroNames":
                this.npcNamePatterns = fromCSV(String(this.config.npcNamePatterns() ?? ""));
                this.scanNpcs();
                break;
        }
    }

    onGameStateChanged(event: GameStateChanged): void {
        switch (event.getGameState()) {
            case GameState.LOGGED_IN:
                if (this.loggingIn) {
                    this.loggingIn = false;
                    // The player isn't in the scene yet: the first tick takes up the saved area.
                    this.pendingLogin = true;
                }
                this.scanNpcs();
                break;
            case GameState.LOGGING_IN:
                this.loggingIn = true;
                break;
            case GameState.LOGIN_SCREEN:
                if (this.tracker.lastPlayerLocation) this.save();
                this.tracker.reset();
                this.loggingIn = true;
                break;
        }
    }

    /** RuneLite keeps these per RS profile; here they are one key per account name. */
    private savedKey(): string | null {
        return this.accountName ? `saved.${this.accountName.toLowerCase()}` : null;
    }

    private save(): void {
        const key = this.savedKey();
        if (!key) return;
        const saved = this.tracker.save(this.now());
        if (saved) this.configManager.setConfiguration(NpcAggroAreaConfig.group, key, JSON.stringify(saved));
        else this.configManager.unsetConfiguration(NpcAggroAreaConfig.group, key);
    }

    /** What the last logout saved, removed as it is read (RuneLite's loadConfig then resetConfig). */
    private takeSaved(): SavedAggroArea | null {
        const key = this.savedKey();
        if (!key) return null;
        const text = this.configManager.getConfiguration(NpcAggroAreaConfig.group, key);
        if (text === undefined) return null;
        this.configManager.unsetConfiguration(NpcAggroAreaConfig.group, key);
        try {
            return JSON.parse(text) as SavedAggroArea;
        } catch {
            return null;
        }
    }
}

/** RuneLite's NpcAggroAreaOverlay: the border of the two safe squares, on the ground. */
export class NpcAggroAreaOverlay implements WidgetOverlay {
    /** RuneLite's OverlayLayer.ABOVE_SCENE. */
    readonly drawBelowWidgets = true;
    private lines?: Line[];

    constructor(private readonly plugin: NpcAggroAreaPlugin) {}

    signature(): string {
        this.lines = this.build();
        return this.lines.length === 0 ? "" : JSON.stringify(this.lines.map((l) => [l.points.map(([x, y]) => [Math.round(x), Math.round(y)]), l.color]));
    }

    draw(context: WidgetOverlayDrawContext): Rect[] {
        const lines = this.lines ?? this.build();
        this.lines = undefined;
        const glr = context.renderer as any;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const { points, color } of lines) {
            glr.drawPolyline?.(points, LINE_WIDTH, color, false);
            for (const [x, y] of points) {
                minX = Math.min(minX, x - LINE_WIDTH); minY = Math.min(minY, y - LINE_WIDTH);
                maxX = Math.max(maxX, x + LINE_WIDTH); maxY = Math.max(maxY, y + LINE_WIDTH);
            }
        }
        return Number.isFinite(minX) ? [{ x: minX, y: minY, w: maxX - minX, h: maxY - minY }] : [];
    }

    private build(): Line[] {
        const plugin = this.plugin;
        const { tracker, config } = plugin;
        if (!plugin.isStarted() || !plugin.isActive() || config.showAreaLines() !== true || tracker.safeCenters[1] === null) return [];
        const geometry = (plugin.getOsrsClient() as any)?.sceneGeometry;
        const p = plugin.playerTile();
        if (!geometry || !p) return [];
        const window = { minX: p.x - DRAW_RADIUS, maxX: p.x + DRAW_RADIUS, minY: p.y - DRAW_RADIUS, maxY: p.y + DRAW_RADIUS };
        // The aggressive colour while the timer runs, the unaggressive one once it is over.
        const aggressive = tracker.endTime !== null && plugin.now() < tracker.endTime;
        const color = argbToRgba(Number(aggressive ? config.aggroAreaColor() : config.unaggroAreaColor()) >>> 0);
        const out: Line[] = [];
        for (const s of multiBorders(tracker.boxes(p.plane), p.plane, window)) {
            // A point per tile along the run, so the line follows the terrain.
            const n = Math.max(s.x2 - s.x1, s.y2 - s.y1);
            const points: [number, number][] = [];
            for (let i = 0; i <= n; i++) {
                const x = s.x1 + (s.x2 > s.x1 ? i : 0), y = s.y1 + (s.y2 > s.y1 ? i : 0);
                const at = geometry.worldToScreen(x, geometry.tileHeight(x, y, p.plane), y);
                if (at) points.push([at[0], at[1]]);
            }
            if (points.length >= 2) out.push({ points, color });
        }
        return out;
    }
}

/**
 * RuneLite's two infoboxes as one movable box: UncalibratedInfobox ("?" until the second safe
 * tile is known) and AggressionTimer (the time left, red in the last minute).
 */
export class AggressionInfoBoxOverlay implements WidgetOverlay {
    readonly movable = { name: "NpcAggroAreaInfoBoxOverlay", position: OverlayPosition.TOP_LEFT };

    constructor(private readonly plugin: NpcAggroAreaPlugin) {}

    menuEntries(): OverlayMenuEntry[] {
        return [{ option: "Configure", target: "NPC Aggression Timer", onClick: () => this.plugin.openSettings() }];
    }

    /** The boxes to show now: [text, colour]. */
    entries(): [string, number][] {
        const plugin = this.plugin;
        if (!plugin.isStarted() || !plugin.playerTile()) return [];
        const { tracker } = plugin;
        const list: [string, number][] = [];
        if (tracker.safeCenters[1] === null) list.push(["?", WHITE]);
        const left = tracker.endTime === null ? 0 : tracker.endTime - plugin.now();
        if (plugin.shouldDisplayTimer() && left > 0) list.push([timerText(left), left < 60_000 ? RED_BRIGHTER : WHITE]);
        return list;
    }

    signature(): string {
        const list = this.entries();
        return list.length === 0 ? "" : JSON.stringify(list);
    }

    draw(context: WidgetOverlayDrawContext): Rect[] {
        const list = this.entries();
        if (list.length === 0) return [];
        const at = context.place(this, list.length * INFOBOX_SIZE + (list.length - 1) * INFOBOX_GAP, INFOBOX_SIZE);
        if (!at) return [];
        const { scaleX: sx, scaleY: sy } = at;
        const glr = context.renderer as any;
        const font = overlayFont("infobox");
        const textH = Math.round(12 * font.scale);
        const icon = context.sprite(skillIconSprite(SkillId.Slayer));
        return list.map(([value, color], i) => {
            const r = { x: at.x + i * (INFOBOX_SIZE + INFOBOX_GAP) * sx, y: at.y, w: INFOBOX_SIZE * sx, h: INFOBOX_SIZE * sy };
            glr.drawRect(r.x, r.y, r.w, r.h, BACKGROUND);
            glr.drawRect(r.x, r.y, r.w, sy, OUTLINE);
            glr.drawRect(r.x, r.y + r.h - sy, r.w, sy, OUTLINE);
            glr.drawRect(r.x, r.y + sy, sx, r.h - 2 * sy, OUTLINE);
            glr.drawRect(r.x + r.w - sx, r.y + sy, sx, r.h - 2 * sy, OUTLINE);
            if (icon) {
                const size = INFOBOX_ICON * sx;
                const fit = Math.min(size / icon.w, size / icon.h);
                const w = icon.w * fit, h = icon.h * fit;
                glr.drawTexture(icon, r.x + (r.w - w) / 2, r.y + 2 * sy + (size - h) / 2, w, h);
            }
            drawTextGL(context.renderer, context.fontLoader, value, r.x, r.y + r.h - (textH + 1) * sy, r.w, textH * sy, font.id, color, 1, 1, true, 1,
                undefined, sx * font.scale, sy * font.scale);
            return r;
        });
    }
}
