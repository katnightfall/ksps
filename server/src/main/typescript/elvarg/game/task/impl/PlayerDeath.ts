import { GameConstants } from "../../GameConstants";
import { MORTAL_DEVELOPER_ATTRIBUTE } from "../../entity/impl/Mobile";
import { CombatFactory } from "../../content/combat/CombatFactory";
import { ItemOnGroundManager } from "../../entity/impl/grounditem/ItemOnGroundManager";
import { Player } from "../../entity/impl/player/Player";
import { PlayerRights } from "../../model/rights/PlayerRights";
import { Task } from "../Task";
import { Item } from "../../model/Item";
import { Bank } from "../../model/container/impl/Bank";
import { SkullType } from "../../model/SkullType";
import { PrayerData, PrayerHandler } from "../../content/PrayerHandler";
import { Skill } from "../../model/Skill";
import { Location } from "../../model/Location";
import { Animation } from "../../model/Animation";
import { PluginManager } from "../../../plugins/PluginManager";
import { ItemIdentifiers } from "../../../util/ItemIdentifiers";
import { Barrows } from "../../content/combat/Barrows";
import { CombatSpecial } from "../../content/combat/CombatSpecial";
import { Wilderness } from "../../content/wilderness/Wilderness";
import { ArceuusThralls } from "../../content/combat/magic/ArceuusThralls";

export class PlayerDeathTask extends Task {
    /** The usual death line (Wiki: Death). */
    public static readonly DEATH_MESSAGE = "Oh dear, you are dead!";
    private player: Player;
    private killer: Player | undefined;
    private loseItems = true;
    private itemsToKeep: Item[] = [];
    // rsprox 426, 1084, 1085 and 2508: respawn four ticks after animation 836 starts.
    private ticks = 4;
    /** False when a plugin says the death line itself (onPlayerBeforeDeath's announce). */
    private announce: boolean;
    /** The respawn tick's line: a plugin's own (onPlayerBeforeDeath's message), or the usual one. */
    private message: string;


    constructor(player: Player, announce = true, message: string = PlayerDeathTask.DEATH_MESSAGE) {
        super(1, false);
        this.player = player;
        this.announce = announce;
        this.message = message;
        (this.player as any).__recentDeathDamagerEntries =
            this.player.getCombat().getRecentDamagerEntries();
        this.killer = player.getCombat().getKiller(true);
    }

    private resolveBotRespawnLocation(): Location | null {
        if (!this.player?.isPlayerBot?.()) {
            return null;
        }
        const resolver = (this.player as any).__botResolveRespawnLocation;
        if (typeof resolver === "function") {
            try {
                const resolved = resolver();
                return Location.readTile(resolved);
            } catch (err) {
                console.error("[PlayerDeathTask] bot respawn resolver failed", err);
            }
        }
        return null;
    }

    public execute() {
        if (!this.player) {
            this.stop();
            return;
        }
        try {
            switch (this.ticks) {
                case 0: {
                    // Send death message with jingle 90 on the respawn tick, four ticks after animation 836
                    // starts (rsprox 426, 431, 732, 1084, 1085, 4028, 4037, 4041, 4095: message, jingle and map
                    // rebuild share one tick).
                    if (this.announce) {
                        this.player.sendMessage(this.message);
                        this.player.getPacketSender().sendJingle(90);
                    }

                    if (this.player.isPlayerBot && this.player.isPlayerBot()) {
                        (this.player as any).getCombatInteraction?.().handleDeath?.(this.killer);
                    }
                    const pluginShouldDropItems =
                        PluginManager.emitShouldDropItemsOnDeath(this.player, this.killer ?? null);
                    this.loseItems = pluginShouldDropItems ?? true;
                    const deathPosition = this.player.getLocation();
                    const bones = { player: this.player, killer: this.killer ?? null, location: deathPosition, allow: true };
                    PluginManager.emitCustomEvent("player:death-bones", bones);
                    if (bones.allow) {
                        ItemOnGroundManager.registerLocation(
                            this.killer ? this.killer : this.player,
                            new Item(ItemIdentifiers.BONES),
                            deathPosition
                        );
                    }
                    if (this.loseItems) {
                        this.itemsToKeep = PlayerDeathTask.dropItems(this.player, this.killer, deathPosition);
                    }
                    // Restore the player's default attributes (such as stats)..
                    this.player.resetAttributes();
                    ArceuusThralls.dismiss(this.player);
                    // Energy isn't restored, but the restore timer starts over on the respawn tick
                    // (rsprox captures: docs/special-attack-energy.md).
                    CombatSpecial.restartRestoreTimer(this.player, CombatSpecial.restoreDelayTicks(this.player));
                    // Hits still on their way (queued during the death animation, delayed projectiles,
                    // the rest of a multi-hit special) and the player's own pending damage (a poison
                    // tick) belong to the life that just ended: dropped, they can't land after the
                    // respawn. clearIncoming also cancels deferred hits by bumping the queue generation.
                    const hitQueue = this.player.getCombat?.()?.getHitQueue?.();
                    hitQueue?.clearIncoming();
                    hitQueue?.clear();

                    // If the player lost items, the ones a death keeps come back.
                    if (this.loseItems) {
                        PlayerDeathTask.returnKeptItems(this.player, this.itemsToKeep);
                        this.itemsToKeep = [];
                    }

                    // Notify defeat hooks for all deaths so plugins can apply
                    // post-death cleanup even when no killer is present.
                    PluginManager.emitPlayerDefeated(this.killer ?? null, this.player);
                    (this.player as any).__recentDeathDamagerEntries = null;

                    GameConstants.PLAYER_PERSISTENCE.requestSave(this.player, "death");
                    const handledDeath = PluginManager.emitPlayerDeath({
                        player: this.player,
                        killer: this.killer ?? null,
                        itemsLost: this.loseItems,
                        handled: false,
                    });
                    // Every observer hears the death, whichever death hook took it: `onPlayerDeath`
                    // stops at the first handler that sets `handled` (a quest's own respawn).
                    PluginManager.emitCustomEvent("player:died", {
                        player: this.player,
                        killer: this.killer ?? null,
                        itemsLost: this.loseItems,
                    });

                    if (!handledDeath) {
                        // Respawn policies run after every dangerous-death observer, including Hardcore.
                        const respawn = { player: this.player, killer: this.killer ?? null, handled: false };
                        PluginManager.emitCustomEvent("player:respawn", respawn);
                        if (!respawn.handled) {
                            const botRespawn = this.resolveBotRespawnLocation();
                            this.player.moveTo(botRespawn ?? GameConstants.DEFAULT_LOCATION);
                        }
                    }
                    GameConstants.PLAYER_PERSISTENCE.requestSave(this.player, "respawn");

                    // Stop the event..
                    this.stop();
                    break;
                }

                case 4: {
                    if (this.player.isPlayerBot && this.player.isPlayerBot()) {
                        (this.player as any).getCombatInteraction?.().handleDying?.(this.killer);
                    }

                    // Reset combat..
                    this.player.getCombat().reset();
                    this.player.getCombat().setUnderAttack(null);
                    this.player.setFollowing(null);
                    this.player.setMobileInteraction(null);
                    this.player.setPositionToFace(null);
                    this.player.setForceMovement(null);

                    // Reset movement queue and disable it..
                    this.player.getMovementQueue().setBlockMovement(true).reset();

                    // Mark us as untargetable..
                    this.player.setUntargetable(true);

                    // Close all open interfaces..
                    this.player.getPacketSender().sendInterfaceRemoval();

                    // Perform death animation..
                    this.player.performAnimation(new Animation(836));
                    PluginManager.emitCustomEvent("player:dying", { player: this.player, killer: this.killer ?? null });

                    break;
                }
            }
            this.ticks--;
        } catch (e) {
            super.stop();
            console.error(e);
            this.player.resetAttributes();
            this.player.moveTo(this.resolveBotRespawnLocation() ?? GameConstants.DEFAULT_LOCATION);
        }
    }

    /**
     * A death's item loss at `position`: the items a death keeps are set aside and returned, the
     * rest go to the death-drops hooks (a grave) or the floor, and the inventory and equipment
     * are emptied. `returnKeptItems` gives the kept ones back.
     */
    public static dropItems(player: Player, killer: Player | null | undefined, position: Location): Item[] {
        const kept = PlayerDeathTask.getItemsToKeep(player, PlayerDeathTask.getAmountToKeep(player),
            PlayerDeathTask.protectsCosmetics(player, killer));
        const itemsToKeep: Item[] = Array.isArray(kept) ? kept : [];
        const playerItems = PlayerDeathTask.splitIntoComponents(player, killer, itemsToKeep,
            player.getInventory().getValidItems().concat(player.getEquipment().getValidItems()));
        const droppedItems: Item[] = [];
        const lostUntradeables: Item[] = [];
        const layout = PlayerDeathTask.slotLayout(player);
        let dropped = false;
        let pluginHandledDrop = false;

        for (const item of playerItems) {
            const dropEligible =
                (item.isPlayerTradeable() || (!item.isLostOnDeath() && Barrows.isBarrowsItem(item.getId()))) &&
                !itemsToKeep.includes(item) &&
                !PlayerDeathTask.keepsEverything(player);
            const deathDropEvent = {
                player,
                killer: killer ?? null,
                item,
                kept: itemsToKeep.includes(item),
                location: position,
                shouldDropItems: !PlayerDeathTask.keepsEverything(player),
                dropEligible,
                suppressDefaultDrop: false,
                handled: false,
                extraDrops: [] as Item[],
            };
            const handled = PluginManager.emitPlayerDeathItemDrop(deathDropEvent);
            // Items a hook adds to the death (a ring's imbue paid out as coins) are lost with it: to the grave or the
            // floor, as the rest are, or kept where the death keeps everything.
            for (const extra of deathDropEvent.extraDrops) {
                if (PlayerDeathTask.keepsEverything(player)) itemsToKeep.push(extra);
                else droppedItems.push(extra);
            }
            if (handled) {
                pluginHandledDrop = true;
                continue;
            }

            if (deathDropEvent.suppressDefaultDrop && deathDropEvent.dropEligible) {
                dropped = true;
                continue;
            }

            // Owners and developers keep everything.
            if (PlayerDeathTask.keepsEverything(player)) {
                if (!item.isLostOnDeath() && !itemsToKeep.includes(item)) {
                    itemsToKeep.push(item);
                }
                continue;
            }
            if (item.isLostOnDeath() || itemsToKeep.includes(item)) {
                continue;
            }
            // Untradeables are kept unless a death-drops hook takes them (a grave) or a mode
            // says they are never kept (Ultimate Ironman). The keep hook already excluded
            // them from the kept slots; honour that answer here too instead of returning them.
            if (!item.isPlayerTradeable() && !Barrows.isBarrowsItem(item.getId())) {
                if (PluginManager.emitShouldKeepItemOnDeath(player, item) === false) {
                    droppedItems.push(item);
                } else {
                    lostUntradeables.push(item);
                }
                continue;
            }
            droppedItems.push(item);
        }

        // Emitted with nothing lost too: a death still changes an existing grave.
        if (!PlayerDeathTask.keepsEverything(player)) {
            const before = droppedItems.length + lostUntradeables.length;
            PluginManager.emitPlayerDeathDrops({
                player,
                killer: killer ?? null,
                location: position,
                items: droppedItems,
                untradeables: lostUntradeables,
                layout,
            });
            if (droppedItems.length + lostUntradeables.length < before) {
                pluginHandledDrop = true;
            }
        }
        // Asked after the item hooks: one can make an item tradeable (an emptied Webweaver bow, an unimbued ring), so it
        // reaches here past the hooks' own eligibility check.
        const owner = PlayerDeathTask.lootOwner(player, killer);
        for (const item of droppedItems) {
            // A mode may give its death drops a different lifetime (Ultimate Ironman's one-hour
            // deathpile); the options are generic so the mode plugin owns the policy.
            const options: { despawnDelay?: number } = {};
            PluginManager.emitCustomEvent("player-death:drop-options", { player, item, options });
            const groundItem = ItemOnGroundManager.registerLocation(owner, item, position, undefined, {
                despawnDelay: options.despawnDelay,
            });
            PluginManager.emitCustomEvent("player-death:dropped", { player, item, groundItem });
            dropped = true;
        }
        itemsToKeep.push(...lostUntradeables);

        // Handle defeat..
        if (killer && !dropped && !pluginHandledDrop) {
            killer.sendMessage(`${player.getDisplayName()} had no valuable items to be dropped.`);
        }

        // Reset items
        player.getInventory().resetItems().refreshItems();
        player.getEquipment().resetItems().refreshItems();
        return itemsToKeep;
    }

    /**
     * Who a PvP death's loot is dropped for: the killer, unless content says otherwise
     * (`player-death:loot-owner` { player, killer, owner }; an Ironman killer takes no other player's loot). Plugins
     * that drop death loot of their own (repair coins, ether, fees) ask here too, so there is one answer.
     */
    public static lootOwner(player: Player, killer: Player | null | undefined): Player {
        if (!killer || killer === player) return player;
        const query = { player, killer, owner: killer as Player };
        PluginManager.emitCustomEvent("player-death:loot-owner", query);
        return query.owner ?? player;
    }

    /** The items a death let the player keep, back in the inventory. */
    public static returnKeptItems(player: Player, items: Item[]): void {
        // Ours: a death can keep more than a backpack holds (every untradeable is kept when no grave takes them:
        // a death to another player, a world without graves), and what did not fit was gone with no more than
        // "You couldn't hold all those items.". The rest goes to the bank, or lies where the player died.
        const inventory = player.getInventory();
        let banked = false;
        let dropped = false;
        for (const it of items) {
            const kept = it.clone();
            const fits = Math.min(kept.getAmount(), inventory.getAddableAmount(kept));
            if (fits >= kept.getAmount()) {
                inventory.addItem(kept);
                continue;
            }
            if (fits > 0) inventory.addItem(kept.clone().setAmount(fits));
            let rest = kept.getAmount() - fits;
            // A note is banked as its item, as a deposit does.
            const spare = kept.clone().setId(kept.getDefinition().unNote()).setAmount(rest);
            const bank = player.getBank(Bank.getTabForItem(player, spare.getId()));
            const room = spare.isUnbankable() ? 0 : Math.min(rest, bank.getAddableAmount(spare));
            if (room > 0) {
                bank.add(spare.clone().setAmount(room), false);
                rest -= room;
                banked = true;
            }
            if (rest > 0) {
                ItemOnGroundManager.registers(player, kept.clone().setAmount(rest));
                dropped = true;
            }
        }
        if (banked) player.sendMessage("You kept more than you can carry: the rest has been sent to your bank.");
        if (dropped) player.sendMessage("You kept more than you can carry: the rest lies where you died.");
    }

    /**
     * Loses items as a death at `position` would, without the death itself: a raid that holds
     * its dead until the whole party falls takes their items then (The Fractured Archive).
     */
    public static loseItemsAsDeath(player: Player, position: Location): void {
        PlayerDeathTask.returnKeptItems(player, PlayerDeathTask.dropItems(player, null, position));
        GameConstants.PLAYER_PERSISTENCE.requestSave(player, "death");
    }

    public static getAmountToKeep(player: Player): number {
        if (
            player.getSkullTimer() > 0 &&
            player.getSkullType() == SkullType.RED_SKULL
        ) {
            return 0;
        }
        const protectItem = player.getSkillManager().getMaxLevel(Skill.PRAYER) >= PrayerData.PROTECT_ITEM.requirement &&
            player.getSkillManager().getCurrentLevel(Skill.PRAYER) > 0 &&
            PrayerHandler.isActivated(player, PrayerHandler.PROTECT_ITEM);
        return (player.getSkullTimer() > 0 ? 0 : 3) + (protectItem ? 1 : 0);
    }

    /** The item id in each inventory and equipment slot, -1 where empty. */
    private static slotLayout(player: Player): { inventory: number[]; equipment: number[] } {
        const ids = (items: Item[]) => items.map((item) => (item && item.getId() > 0 && item.getAmount() > 0 ? item.getId() : -1));
        return {
            inventory: ids(player.getInventory().getItems()),
            equipment: ids(player.getEquipment().getItems()),
        };
    }

    /** Owners and developers keep everything, unless they made themselves mortal (::mortal). */
    private static keepsEverything(player: Player): boolean {
        const rights = player.getRights();
        return (rights === PlayerRights.OWNER || rights === PlayerRights.DEVELOPER)
            && player.getAttribute(MORTAL_DEVELOPER_ATTRIBUTE) !== true;
    }

    /**
     * A death to another player on dangerous PvP ground (Wiki: Items Kept on Death, "PvP death"): the
     * Wilderness and every other `pvp` zone of world.json, or ground that content says counts the same
     * (`player-death:pvp-ground` { player, killer, pvp }).
     */
    // Ours (upstream issue #6002): Bounty Hunter's arena is PvP ground that no `pvp` zone covers, so the
    // rules below never ran there and an upgraded Nightmare staff, a fire cape or a Slayer helmet came
    // back whole from a death to a player in Daimon's Crater.
    public static isPvpDeath(player: Player, killer: Player | null | undefined): boolean {
        if (!killer || killer === player) return false;
        if (Wilderness.isIn(player)) return true;
        const query = { player, killer, pvp: false };
        PluginManager.emitCustomEvent("player-death:pvp-ground", query);
        return query.pvp === true;
    }

    /**
     * On a PvP death, an unkept item made of other items drops as those items, and the item itself
     * is gone (Wiki: Items Kept on Death). An upgraded Nightmare staff becomes the staff and its orb
     * (`deathComponents` in item-gameplay.json). Content answers for the rest through
     * `player-death:pvp-item-parts` { player, killer, item, parts }: `parts` lists what the item
     * becomes (an ornamented item: the plain item and its kit), and each part then meets the death
     * as an item of its own: dropped for the killer if it trades, kept or broken if it does not.
     */
    private static splitIntoComponents(player: Player, killer: Player | null | undefined, kept: Item[], items: Item[]): Item[] {
        if (!PlayerDeathTask.isPvpDeath(player, killer)) return items;
        if (PlayerDeathTask.keepsEverything(player)) return items;
        return items.flatMap((item) => {
            if (kept.includes(item) || item.isLostOnDeath()) return [item];
            const components = item.getDefinition().getDeathComponents();
            if (components.length > 0) return components.map((id) => new Item(id, item.getAmount()));
            const query = { player, killer, item, parts: null as Item[] | null };
            PluginManager.emitCustomEvent("player-death:pvp-item-parts", query);
            return Array.isArray(query.parts) && query.parts.length > 0 ? query.parts : [item];
        });
    }

    /**
     * What an item is worth when a death picks the kept ones: its Grand Exchange guide price, or its
     * high alchemy value when it has none (Wiki: Items Kept on Death; rsprox recording 430). Never
     * the store value as such: a 35m pair of ranger boots has a store value of 200. An item that
     * cannot be alchemised (a fire cape, a dragon defender) still ranks by the alchemy value its
     * store value gives (60%), as it did before item-alch.json cleared those: the Wiki names no
     * other value for it.
     *
     * Asked with the player who carries it, as the ranking asks, an item with no Grand Exchange price
     * of its own that a PvP death takes apart (a charged weapon; an ornamented, imbued or upgraded
     * item) is worth what that death would leave the killer (pvpLossValue): the Wiki ranks "first by
     * effective Grand Exchange value, and then by alchemy value if the item lacks an effective Grand
     * Exchange value".
     */
    // Ours (upstream issue #6002): a charged item has no price of its own and ranked by its alchemy value, so a charged
    // Scythe of Vitur (2.4m; uncharged 1,150m) ranked below a charged Sanguinesti staff (3m), and a skulled player with
    // Protect Item kept the staff and lost the scythe to the killer.
    public static keepValue(item: Item, player?: Player | null): number {
        const definition = item.getDefinition();
        if (definition.hasGrandExchangeValue()) return definition.getGrandExchangeValue();
        const lost = player ? PlayerDeathTask.pvpLossValue(player, item) : 0;
        if (lost > 0) return lost;
        const alch = definition.getHighAlchValue();
        return alch > 0 ? alch : Math.floor(Math.max(0, definition.getValue()) * 0.6);
    }

    /** Priced at face value, as the Items Kept on Death screen's guide risk value prices them. */
    private static readonly CURRENCY = new Set(["Coins", "Platinum token"]);

    /**
     * What a PvP death that does not protect `item` would leave the killer, for one of its stack: the parts it is taken
     * apart into that trade, each at its own price (coins and platinum tokens at face value); 0 where it is not taken
     * apart or none of its parts trade. The parts are the death's own (splitIntoComponents): `deathComponents`, else the
     * answers to `items:pvp-death-parts-preview` { player, killer, item, parts, preview: true }, the read-only twin of
     * `player-death:pvp-item-parts`, asked with a copy of the item so that nothing the player holds changes. A preset
     * copy and a bot's gear are not loot, and are not asked about.
     */
    private static pvpLossValue(player: Player, item: Item): number {
        if (item.getAmount() <= 0 || item.isLostOnDeath() || item.isPresetItem() || player.isPlayerBot?.() === true) return 0;
        const components: number[] = item.getDefinition().getDeathComponents();
        let parts: Item[] | null = components.length > 0 ? components.map((id) => new Item(id, item.getAmount())) : null;
        if (!parts) {
            const query = { player, killer: null, item: item.clone(), parts: null as Item[] | null, preview: true };
            PluginManager.emitCustomEvent("items:pvp-death-parts-preview", query);
            parts = Array.isArray(query.parts) ? query.parts : null;
        }
        let total = 0;
        for (const part of parts ?? []) {
            if (!part || part.getId() <= 0 || part.getAmount() <= 0 || !part.isPlayerTradeable()) continue;
            const definition = part.getDefinition();
            const each = PlayerDeathTask.CURRENCY.has(definition.getName())
                ? Math.max(0, definition.getValue())
                : PlayerDeathTask.keepValue(part);
            total += each * part.getAmount();
        }
        return total / item.getAmount();
    }

    /**
     * Whether a death keeps ornamented items beyond the kept count (Wiki: Ornament kit): not when
     * killed by another player or in the Wilderness, and not once the player turns "Death
     * protection from cosmetics" (All Settings row 386) off.
     */
    public static protectsCosmetics(player: Player, killer: Player | null | undefined): boolean {
        if (killer && killer !== player) return false;
        if (Wilderness.isIn(player)) return false;
        return PlayerDeathTask.cosmeticProtectionOn(player);
    }

    /** Row 386: varbit 10987 (death_waivecosmeticsprotection) is 1 when the player waived it. */
    public static cosmeticProtectionOn(player: Player): boolean {
        return (player.getPacketSender?.() as any)?.getVarbit?.(PlayerDeathTask.WAIVE_COSMETICS_PROTECTION_VARBIT) !== 1;
    }

    private static readonly WAIVE_COSMETICS_PROTECTION_VARBIT = 10987;

    /**
     * The items a death lets the player keep: the three most valuable (four with Protect Item, none
     * skulled). The Items Kept on Death interface passes the count its own toggles give.
     */
    public static getItemsToKeep(player: Player, amountToKeep = PlayerDeathTask.getAmountToKeep(player), cosmetics = false): Item[] {
        const { ranked, always, cosmetic } = PlayerDeathTask.getKeptItems(player, amountToKeep, cosmetics);
        return [...ranked, ...always, ...cosmetic];
    }

    /**
     * The kept items by why they are kept: `ranked` the most valuable up to the count, `always`
     * those a plugin keeps beyond it, and `cosmetic` the ornamented items `cosmetics` protects that
     * were not valuable enough for a ranked slot. An ornamented item valuable enough takes its slot
     * as any other does (Wiki: Items Kept on Death).
     */
    public static getKeptItems(player: Player, amountToKeep = PlayerDeathTask.getAmountToKeep(player), cosmetics = false):
        { ranked: Item[]; always: Item[]; cosmetic: Item[] } {
        const items: Item[] = [];
        const alwaysKept: Item[] = [];
        for (const item of [...player.getInventory().getItems(), ...player.getEquipment().getItems()]) {
            // Untradeable items compete for the kept slots too, by value (Wiki: Items Kept on
            // Death). Preset items are always lost, so they never take one.
            if (
                item == null ||
                item.getId() <= 0 ||
                item.getAmount() <= 0 ||
                item.isLostOnDeath()
            ) {
                continue;
            }
            const keep = PluginManager.emitShouldKeepItemOnDeath(player, item);
            if (keep === false) {
                continue;
            }
            // A plugin's keep=true puts the item beyond the normal keep count.
            if (keep === true) {
                alwaysKept.push(item);
                continue;
            }
            items.push(item);
        }

        // Each item is valued once: keepValue asks content what a PvP death makes of an item with no price of its own.
        const values = new Map<Item, number>();
        for (const item of items) values.set(item, PlayerDeathTask.keepValue(item, player));
        items.sort((a: Item, b: Item) => (values.get(b) ?? 0) - (values.get(a) ?? 0));
        const ranked = items.slice(0, amountToKeep);
        const cosmetic = cosmetics ? items.slice(amountToKeep).filter((item) => PlayerDeathTask.isCosmetic(player, item)) : [];
        return { ranked, always: alwaysKept, cosmetic };
    }

    /** An item a cosmetic upgrade protects (`player-death:cosmetic` { player, item, cosmetic }; OrnamentKits answers). */
    private static isCosmetic(player: Player, item: Item): boolean {
        const query = { player, item, cosmetic: false };
        PluginManager.emitCustomEvent("player-death:cosmetic", query);
        return query.cosmetic === true;
    }
}
