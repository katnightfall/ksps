import fs = require("fs");
import path = require("path");

import type { NPC } from "../entity/impl/npc/NPC";
import type { Player } from "../entity/impl/player/Player";
import { Sound } from "../Sound";
import { Sounds } from "../Sounds";
import { NpcDefinition } from "./NpcDefinition";

/** A sound and its delay in client ticks (20 ms each). */
type SoundEntry = readonly [sound: number, delay: number];

interface NpcSounds {
    hit?: SoundEntry[];
    attack?: SoundEntry[];
    death?: SoundEntry[];
}

const FILE = "data/definitions/npc-combat-sounds.json";

/**
 * The sounds an NPC makes in a fight, from data/definitions/npc-combat-sounds.json (rsprox captures,
 * scripts/mine-npc-combat-sounds.mjs). Live sends them as private synths to the player in the fight,
 * in the tick of the event: the NPC taking a hit, starting an attack, or dying. A positioned sound of
 * range 0 is dropped by the client, so none of these go out as area sounds.
 */
export class NpcCombatSounds {
    private static data: Record<string, NpcSounds> | null = null;
    /** Sounds by name and animation (shareKey); null where the recorded NPCs of that key disagree. */
    private static shared: Map<string, SoundEntry[] | null> | null = null;

    /** The player hits `npc`: they hear its hit sound. */
    public static hit(npc: NPC, attacker: Player): void {
        NpcCombatSounds.play(attacker, NpcCombatSounds.pick(npc, "hit"));
    }

    /** `npc` starts an attack: the player it targets hears the attack sound. */
    public static attack(npc: NPC, target: Player): void {
        NpcCombatSounds.play(target, NpcCombatSounds.pick(npc, "attack"));
    }

    /**
     * `npc` dies: every player who fought it hears its death sound, the definition's own
     * (npc-combat-defs.json `sounds.death`) before the captured one.
     */
    public static death(npc: NPC, listeners: Iterable<Player>): void {
        const own = npc.getCurrentDefinition().getDeathSound();
        const entry: SoundEntry | undefined = own > 0 ? [own, 0] : NpcCombatSounds.pick(npc, "death");
        if (!entry) return;
        for (const listener of listeners) NpcCombatSounds.play(listener, entry);
    }

    private static pick(npc: NPC, kind: keyof NpcSounds): SoundEntry | undefined {
        const definition = npc.getCurrentDefinition();
        const own = NpcCombatSounds.load()[definition.getId()]?.[kind];
        const entries = own?.length ? own : NpcCombatSounds.sharedEntries(definition, kind);
        if (!entries?.length) return undefined;
        return entries[entries.length === 1 ? 0 : Math.floor(Math.random() * entries.length)];
    }

    /**
     * Ours (upstream issue #4745): the table is keyed by NPC id, and the recordings met only some ids of
     * most monsters (4 of the 12 Cyclops ids, say), which left the rest silent. An NPC with no sound of
     * its own for an event takes the one recorded for an NPC of the same name that plays the same
     * animation for it: the attack animation for an attack, the death animation for a death, the block
     * and death animations for a hit. Where recorded NPCs of one name and animation differ, none is
     * shared.
     */
    private static sharedEntries(definition: NpcDefinition, kind: keyof NpcSounds): SoundEntry[] | undefined {
        const key = NpcCombatSounds.shareKey(definition, kind);
        if (key == null) return undefined;
        return NpcCombatSounds.sharedIndex().get(key) ?? undefined;
    }

    private static shareKey(definition: NpcDefinition | undefined, kind: keyof NpcSounds): string | null {
        const name = definition?.getName?.();
        if (!name || name === "null") return null;
        const animation = kind === "attack" ? definition.getAttackAnim?.() : definition.getDeathAnim?.();
        if (!(animation > 0)) return null;
        return kind === "hit" ? `${name}|hit|${definition.getDefenceAnim?.()}|${animation}` : `${name}|${kind}|${animation}`;
    }

    private static sharedIndex(): Map<string, SoundEntry[] | null> {
        if (NpcCombatSounds.shared) return NpcCombatSounds.shared;
        const index = new Map<string, SoundEntry[] | null>();
        for (const [id, sounds] of Object.entries(NpcCombatSounds.load())) {
            const definition = NpcDefinition.forId(Number(id));
            for (const kind of ["hit", "attack", "death"] as const) {
                const entries = sounds[kind];
                const key = entries?.length ? NpcCombatSounds.shareKey(definition, kind) : null;
                if (key == null) continue;
                const known = index.get(key);
                if (known === undefined) index.set(key, entries!);
                else if (known !== null && JSON.stringify(known) !== JSON.stringify(entries)) index.set(key, null);
            }
        }
        return NpcCombatSounds.shared = index;
    }

    private static play(player: Player, entry: SoundEntry | undefined): void {
        if (!entry || !player?.isRegistered?.()) return;
        Sounds.sendSound(player, new Sound(entry[0], 1, entry[1], 0));
    }

    private static load(): Record<string, NpcSounds> {
        NpcCombatSounds.data ??= (JSON.parse(fs.readFileSync(path.resolve(FILE), "utf8")) as { npcs: Record<string, NpcSounds> }).npcs;
        return NpcCombatSounds.data;
    }
}
