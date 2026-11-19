# NPC combat sounds

An NPC makes three sounds in a fight. Live sends each as a **private synth** (a plain `SynthSound` packet, no position) to the player in the fight, in the tick of the event:

| Event | Who hears it | Hook |
| --- | --- | --- |
| The NPC takes a hit | the player who hit it | `CombatFactory`, after the hit resolves |
| The NPC starts an attack | the player it attacks | `Combat`, right after the combat method's `start` |
| The NPC dies | every player who damaged it | `NPCDeathTask` |

`NpcCombatSounds` (`server/src/main/typescript/elvarg/game/definition/NpcCombatSounds.ts`) plays them from `server/data/definitions/npc-combat-sounds.json`: `npcs[id]` has `hit`, `attack` and `death`, each a list of `[sound, delay]`; one is picked at random per event. A death sound in the definition itself (`npc-combat-defs.json` `sounds.death`) wins over the captured one.

The NPC attack and death sounds used to go out as area sounds of range 0, which the client drops, so they were silent; they now reach the player.

## Ids the recordings never met

The table is keyed by NPC id, and the recordings met only some ids of most monsters (4 of the 12 Cyclops ids), which left the rest silent (upstream issue #4745). An NPC with no sound of its own for an event takes the one recorded for an NPC of the **same name playing the same animation**: the attack animation for an attack, the death animation for a death, the block and death animations for a hit. Where recorded NPCs of one name and animation differ, nothing is shared. This gives about 530 more ids a hit sound, 230 an attack sound and 320 a death sound, with no new sound ids.

An NPC has no attack sound outside this table: `NPC.getAttackSound()` is null. It used to answer one fixed sound (394, `defiler_hit` in the cache) that every NPC melee swing sent as a range-0 area sound, which the client drops.

The cache names every sound effect (gameval group 16: `giant_hit`, `gem_stone_crab_hit_01`, ...). `tests/spell-sounds.test.cjs` reads them that way. A name is not a recording of when or to whom live sends the sound, so the table is still built from recordings only.

## Where the data comes from

The packet names no NPC, so `server/scripts/mine-npc-combat-sounds.mjs` ties a sound to an NPC id by how reliably it shows up in that NPC's ticks in the rsprox captures. The header of the script has the exact rules and the command to rebuild the file. It reads the text RSProx's own decoder (`net.rsprox.proxy.cli.BinaryToStringCommandKt`) writes for a `.bin` recording, **not** the `rsprox_transcripts/` format, and with `--out` it refuses to overwrite the table (exit 1) when the input is in another format. In short:

- a tick is a "hit" tick for an NPC that took a hitsplat and played no attack animation, an "attack" tick when it played an attack animation and took no hitsplat, a "death" tick when it played its death animation (animations are classed with `npc-captured-animations.json`);
- a sound is kept for an NPC when it is in at least 60% of that NPC's ticks of the kind, at least 8 times;
- a sound is NPC-specific only if the NPCs it was kept for account for at least 30% of every tick it was sent in, which drops weapon swings, armour and voices that ride along;
- a sound the server already plays elsewhere is left out, so nothing is sent twice.

## Not covered

Bosses that script their own sounds keep doing so. The player's own weapon-swing and armour/shield hit sounds are not here: they depend on the worn item, and per-item association in the captures is confounded by whole sets being worn together.
