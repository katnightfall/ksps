# Items kept on death

How `PlayerDeathTask` (`server/src/main/typescript/elvarg/game/task/impl/PlayerDeath.ts`) decides what a player keeps, and what an upgraded Nightmare staff turns into when it's lost to a player.

## The kept items (Wiki: Items Kept on Death)

- **How many:** 3, or 0 when skulled; Protect Item adds one (a red skull keeps none).
- **Which:** the most valuable items carried, **tradeable and untradeable alike**. An untradeable item among them takes one of the slots. Before, untradeable items were left out of the ranking, so a cheaper tradeable item took the slot: with Protect Item and a skull, a 125k light ballista was kept over a 4.6m volatile Nightmare staff.
- **Ranked by:** each item's Grand Exchange guide price (`item-prices.json`), or its high alchemy value when it has no price (Wiki: "the highest value determined first by effective Grand Exchange value, and then by alchemy value"). A stack is ranked by one item's price, as before. Before, items were ranked by their cache store value, which can run the other way: unskulled with a rune platebody, platelegs and kiteshield (store 54,400-65,000) and ranger boots, a berserker ring and dragon boots (store 200-20,000, but each worth more on the Grand Exchange), a death kept the rune armour.
- **Untradeable items outside the kept ones** go to the player's grave on a PvM death ([gravestones](gravestones.md)). On a PvP death, or with graves turned off, they are still kept, as before, unless they split (below), lose a kit or come apart (What a PvP death takes apart, below), break ([broken items](broken-items.md)), are never kept (below, on any unsafe death), or are quest rewards that become coins for the killer: barrows gloves and the barrelchest anchor (Quest rewards that become coins, below).
- **Ornamented items** are kept beyond the count on a non-PvP death outside the Wilderness unless the player turns "Death protection from cosmetics" off ([settings](settings.md#death-protection-from-cosmetics-row-386)).
- **Preset items** (from `::presets`, flagged with item metadata) are always lost and never take a kept slot. That's by design: they're free.

## Never kept on death (Wiki: Items Kept on Death, "Items that are never kept")

These items are destroyed on any unsafe death, PvP or PvM: they take no kept slot (even as the most valuable item, or with Protect Item), are not dropped for a killer, go to no grave and are not given back. The Wiki gives a PvP-only qualifier for the rune and bolt pouches alone.

- **Rune pouch and divine rune pouch** (`runepouch/Death.RunePouch.js`), on a PvP death only: the runes inside still drop for the killer ([rune pouch](rune-pouch.md)).
- **The rest** (`NeverKeptOnDeath.plugin.js`, names in `plugins/items/data/never-kept-on-death.json`): the clue box, the Chronicle, League trophies, the degraded amulet of the damned, and the items with no ground state: the Flamtaer bag, Lunar equipment and staff, the Ring of Charos, Steel gauntlets and their enchanted forms, and the magic butterfly net. Items with a death rule of their own (looting bag, jar generator, salamanders) keep it. A noted clue box is a tradeable stack and is not one of them. The Items Kept on Death screen marks these items deleted (368), through `items:never-kept-on-death` { item, neverKept }.
- **Not covered:** a rune pouch can still take a kept slot on a PvP death. "Most untradeable event rewards" and ancient artefacts, which the Wiki also lists, are not named.

## Quest rewards that become coins (Wiki: Items Kept on Death, Barrows gloves, Barrelchest anchor)

Untradeable quest rewards with combat stats that are bought from an NPC turn into coins for the killer on a PvP death, unless they are among the kept items. The item is lost, and the coins drop for the killer as the rest of the loot does (an Ironman killer's go to the victim). A preset copy gives no coins.

- **Items** (`QuestRewardDeathCoins.plugin.js`, ids and amounts in `plugins/items/data/quest-reward-death-coins.json`): barrows gloves, 78,000 coins; the barrelchest anchor, 230,000 coins. They are matched by id: the broken barrelchest anchor and a second barrows gloves item share the names but give no coins.
- **PvM deaths** leave them to the grave, as any other untradeable.
- **Not covered:** the Wiki names no other items or amounts for this rule. It also says metal gloves become a cash drop, without an amount, so they are left as they were.

## The Items Kept on Death interface (rsprox captures)

Opened from the Worn Equipment tab (`deathkeep`, group 4), it shows what a death would keep, from the same ranking (`PlayerDeathTask.getItemsToKeep`), for the count its skull and Protect Item toggles give.

- **Untradeable items are among the kept ones**: recordings 430 and 1463 list `skillcape_max_worn` and `infernal_defender` in `deathkeep_init`'s kept items. Before, the interface left untradeable items out of its ranking, so it could show a different set from the one a death kept.
- **Guide risk value** adds up every item the death does not keep: lost, sent to the gravestone or deleted, untradeables included. Coins and platinum tokens count at face value; other items at their Grand Exchange price, else their alchemy value (`PlayerDeathTask.keepValue`). With the PvP and Wilderness toggles on, an item that death breaks (fire and infernal capes, defenders, Void and the rest of `broken-items.json`) counts at its Perdu repair cost instead, or 500,000 for a locked one that mangles, whether the broken item stays with the player or is lost (Wiki, Items Kept on Death (Interface): "Repair costs if the item becomes broken and must be repaired via Perdu"; BrokenItems answers `broken-items:death-cost`). Recording 1463 shows one: an unkept infernal max cape (repair 225,000) with the PvP toggle on (clientscript 972 args `[0,0,21,0]`, then `[0,0,21,1]`) gives a 305,832,958 risk, which agrees with this pricing. Recorded difference: the PvM preview there shows the same 305,832,958, so live seems to count the repair cost in the PvM preview too (its six unkept items come to 141,274 at our PvM prices against 323,334 recorded; adding the cape at 225,000 comes within about 2,000). The Wiki ties the repair cost to the PvP preview, so the PvM preview keeps its prices. In recording 430, turning Protect Item on moved a sanfew serum(4) (store value 300) to the kept side and the risk value fell from 108,118 to 89,549: 18,569, over sixty times its store value. In recording 1463, 305,509,624 lost coins sit in a 305,832,958 risk, and in recording 435 keeping the untradeable Barrows gloves as the fourth item lowers it by 74,400. Ours: live prices some untradeables by its own value (those gloves at 74,400, here their 60,000 alchemy value).
- **Item markers** (`diango_hols_sack`, inventory 468, one object per listed item; clientscript 974 sorts the items by them): 323 kept; 367 to the gravestone, with a count of the item's grave fee plus one (1, 1,001, 10,001 or 100,001, per the [gravestone](gravestones.md) fee bands); 1991 lost to the killer, or dropped where the player dies; 7531 to the grave as coins; any other object deleted. Recordings 430, 780 and 4266 mark every unkept item 367 on a PvM preview, with 100,001 on the 10m+ items in 780 and 4266, and 1991 only once the PvP toggle is on (430). The Wilderness toggle doesn't change the markers (430). The looting bag is marked 368, deleted: the Wiki says it "disappears completely". Before, every unkept item was 1991, so a PvM preview listed it as lost to a killer and showed no grave fee.
- **Not covered:** the "as coins" (7531) and "deleted" sections for anything but the looting bag (Wilderness supplies, never-kept items on a PvP death): no recording shows them. The Rusty coin has no death rule on the server or the Wiki, so it goes to the grave like other untradeables.
- **Bounty Hunter risk skulls** (`RiskSkulls.BountyHunter.js`) price the lost tradeables the same way (untradeables and coins left out), so the skull tier matches what a death in Daimon's Crater would drop. Tradeable is asked as the death asks it, between players (`isPlayerTradeable`): asking for the Grand Exchange flag left out items a death drops, such as godsword shards. Before, they ranked the kept items by store value item by item, so with ranger boots and rune platebody, platelegs and sq shield the skull priced the boots as lost while a death dropped the shield.

## What a PvP death takes apart (Wiki: Items Kept on Death, Mechanics)

A PvP death is a death to another player in the Wilderness, on any other `pvp` zone of world.json (a PvP world), or in Bounty Hunter's arena (`PlayerDeathTask.isPvpDeath`; the arena answers `player-death:pvp-ground`, as no `pvp` zone covers Daimon's Crater: Wiki, Bounty Hunter, "the standard item loss to PvP death"). The crater has no Wilderness level, so nothing there counts as above level 20.

Before the items are dealt with, each one the death does not protect is offered to content through `player-death:pvp-item-parts` { player, killer, item, parts }. An answer lists what the item becomes, and each part then meets the death as an item of its own: dropped for the killer if it trades, kept (or broken) if it does not. Protected items are never asked about, so a kept item keeps its kit, its charges and its coins. Preset copies are deleted first, as before, and a bot's kit is left to the bots' own loot rules.

- **Ornamented and recoloured items** (`OrnamentKits.plugin.js`, the table in `ornament-kits.json`): the item is lost as its plain form. A kit that dismantling gives back comes off with it: a tradeable kit drops for the killer too (Armadyl godsword (or): the godsword and the kit), an untradeable one stays the victim's (the Bounty Hunter kits: Elder chaos (or), Dragon (cr)), and so does any other untradeable kit that was used up making the item (Osmumten's fang (or)'s cursed phalanx). A tradeable kit or recolour that dismantling does not give back is gone (Volcanic abyssal whip: an abyssal whip for the killer and no mix). An untradeable item with a tradeable kit (Rune defender (t), Trailblazer Graceful, Void (or)) loses the kit to the killer and is then treated as the plain item: kept, or broken with its repair cost paid. Where nothing would change hands (a dyed Graceful piece, Fighter torso (or), the robes of the Eye) the item is left as it is. Before, every ornamented item counted as an untradeable and came back whole, skulled or not.
- **The abyssal tentacle** (`AbyssalTentacle.plugin.js`; Wiki: "If the abyssal tentacle is not protected upon death, it will fully degrade into a kraken tentacle"): the killer gets a kraken tentacle, and an (or) tentacle's kit. A death to a monster still sends it to the grave whole.
- **Ancient Warriors' equipment from the Bounty Hunter Store** (`BountyHunterEquipment.plugin.js`; Wiki: "Upon dying in PvP, the coins used to activate the item are given to the killer, and players are left with the inactive item"): the piece goes inactive and stays with the victim, and the coins it was charged with drop for the killer (Ancient Warriors' equipment, below).
- **Weapons made with a Bounty Hunter imbue scroll** (`BountyHunterEquipment.plugin.js`; Wiki, Dark bow (bh), Barrelchest anchor (bh), Dragon mace (bh), Dragon longsword (bh), Abyssal dagger (bh): "If the player dies in Bounty Hunter with the item, the imbue scroll is kept, but the weapon is lost"): the weapon is lost as the weapon it was made from, which then meets the death as that weapon does (a Dark bow drops for the killer, a Barrelchest anchor becomes its coins), and the victim keeps the scroll.
- **A bot's death in Bounty Hunter's arena is not a PvP death** for these rules: a crater bot leaves its killer what it did before (its tradeable kit), and its Nightmare staff, capes, defenders, (bh) pieces and imbued weapons stay as they are.
- **The Items Kept on Death screen** marks an ornamented tradeable item, and an imbued weapon made from a tradeable one, lost on its PvP preview (`items:lost-to-pvp-killer`).
- **Not covered:** the screen's guide risk value does not count a kit or the coins a piece holds; the kit of a locked `(l)(or)` item; a death to a monster with a tentacle.

## Ancient Warriors' equipment from the Bounty Hunter Store (Wiki: Ancient Warriors' equipment, Bounty Hunter#Equipment, each item's page)

`BountyHunterEquipment.plugin.js`, with the amounts in `plugins/items/data/bounty-hunter-equipment.json`.

- **Activate:** the store sells every piece inactive (`... (bh)(inactive)`), which cannot be worn. Activate charges it with coins from the inventory and makes it the wearable `(bh)` piece: armour, Vesta's spear, Zuriel's staff and Morrigan's throwing axe 5,000,000; Statius's warhammer and Morrigan's javelin 10,000,000; Vesta's longsword 50,000,000; each corrupted piece of armour 1,500,000. Before, nothing answered Activate, so a piece bought from the store could never be used.
- **The coins stay on the item** (metadata `bounty-hunter:activation-fee`), through the bank, a grave and a save.
- **A PvP death** leaves an unprotected piece inactive with the victim and drops the coins it holds for the killer, with the rest of the loot (a loot key, or the victim's own pile for an Ironman killer). A protected piece stays activated with its coins (Wiki, Vesta's longsword (bh)). A death to a monster leaves the piece as it is.
- **A piece nobody charged** (one spawned by a preset, a command or a bot's kit) holds no coins: it goes inactive and pays nothing. A preset copy is deleted with the rest of the preset, and a bot's piece is left alone.
- **Ours** (the Wiki names the options and the amounts, and nothing else): Uncharge makes the piece inactive and gives the coins it holds back to the player, who needs room for them; a Yes/No before Activate takes the coins; every message. The Corrupted Warrior refuses a charged piece whose corrupted (or plain) form takes a different amount ("Uncharge it first"), or a corrupted piece's 1,500,000 coins could become a 5,000,000 piece; inactive and uncharged pieces convert as before, and the piece stays the same item, so a preset copy keeps its restrictions.
- **Not covered:** using the imbue scrolls the store sells (Dark bow, Barrelchest anchor, Dragon mace, Dragon longsword, Abyssal dagger) on a weapon, and Dismantle on an imbued weapon: nothing answers either yet, so a player has an imbued weapon only where one was spawned.

## Charged, assembled and imbued equipment on a PvP death (Wiki: Items Kept on Death, Mechanics, and each item's page)

The items below are untradeable. Before, a PvP death treated each as any untradeable: it came back whole to whoever died with it, skulled or not, and the killer got nothing. Now each item's own plugin answers `player-death:pvp-item-parts` (What a PvP death takes apart, above) with what the Wiki says the item becomes, using the item's own Revert, Empty, Dismantle or "Remove all pages" code where it has one, so a death hands out what that option would and nothing the item did not hold. Each part then meets the death as an item of its own: one that trades drops for the killer with the rest of the loot (a loot key, or the victim's own pile for an Ironman killer), one that does not stays with the victim.

- **Kept as it is:** a protected item (the three-item rule, Protect Item) keeps its charges, parts and imbue; so does every item on a death to a monster or outside PvP ground (to the grave, or back whole, as before). A preset copy is deleted with the rest of the preset and gives nobody anything; a bot's copy is left as it is.
- **The Items Kept on Death screen** marks each item below lost on its PvP preview where what the killer gets trades (`items:lost-to-pvp-killer`).

| Item | The killer gets | Stays with the victim | Destroyed | Wiki |
| --- | --- | --- | --- | --- |
| Blade of Saeldor, Bow of Faerdhinen, charged (`CrystalWeapon.js`) | the inactive weapon | nothing | the charges, and the shards that bought them | Blade of Saeldor, Bow of Faerdhinen: "On unprotected death in PvP, the inactive blade is dropped, and all shards used to charge it will be lost" |
| Blade of Saeldor (c), Bow of Faerdhinen (c), every colour (`CrystalWeapon.js`) | the inactive weapon | nothing | the corruption (the shards that made it) and the colour | ours (below), from the (c) pages and Items Kept on Death, "Chargable items" |
| Crystal helm, body and legs, any colour, active or inactive (`CrystalArmour.plugin.js`) | 1, 3 and 2 crystal armour seeds, as Revert gives | nothing | the charges and the colour | Crystal helm, body, legs: "the crystal body will revert to 3 crystal armour seeds, which will then be dropped for the killer. All crystal shards will be lost should this happen" |
| Crystal bow, shield and halberd: active, inactive, and the older staged and (i) forms (`CrystalEquipmentDeath.plugin.js`) | a crystal weapon seed | nothing | the charges, and an (i) form's imbue | Crystal equipment: "Upon death in the Wilderness, the killer will receive the seed form of the crystal equipment"; Crystal bow, shield, halberd, Changes: "Crystal equipment now reverts to a seed when dropped on death" |
| Crystal axe, pickaxe and harpoon, active or inactive (`CrystalEquipmentDeath.plugin.js`) | the dragon axe, pickaxe or harpoon | nothing | the charges and the crystal tool seed | Crystal axe, pickaxe, harpoon: "A dangerous death in PvP causes the crystal axe to revert to a dragon axe, which will then be dropped for the killer. All crystal shards will be lost should this happen" |
| Crystal felling axe, active or inactive (`CrystalEquipmentDeath.plugin.js`) | a dragon felling axe | nothing | the charges and the crystal tool seed | ours (below) |

- **Ours, where the Wiki's pages are silent or disagree:**
  - *The corrupted blade and bow:* their pages have no death rule, only "While untradeable, the blade can be uncharged, but the crystal shards used to upgrade it will not be returned". They follow Items Kept on Death's "Chargable items" row ("Dropped to the PKer as the tradeable uncharged item"): the killer gets the inactive weapon their Uncharge makes, and the colour, which the inactive weapon does not have, is gone.
  - *The crystal felling axe:* its page has no death rule, only that "the standard process of reverting crystal to dragon does apply". It is lost as the other crystal tools are.
  - *The crystal tool seed:* the tool pages name only the dragon tool as what the killer gets, so the seed is gone with the shards.
- **Not covered:** Uncharge on the Blade of Saeldor and Bow of Faerdhinen, and Revert on the crystal bow, shield, halberd and tools: nothing answers those options yet, so the death's answers for them are written from the Wiki and not from that code. The Gauntlet's own crystal equipment never leaves the Gauntlet and is not listed.

## Upgraded Nightmare staffs (Wiki)

The harmonised, volatile and eldritch Nightmare staffs are untradeable. When one is lost on a PvP death, the killer gets the Nightmare staff and the orb.

- **Data:** `deathComponents` on the item in `item-gameplay.json`: `[24422, <orb>]` for each staff (orbs 24511, 24514, 24517). Other items with tradeable components can use the same field.
- **When:** the death is a PvP death (`PlayerDeathTask.isPvpDeath`: a player killer, in the Wilderness, on a PvP world's ground or in Bounty Hunter's arena), and the staff isn't one of the kept items. The components then go through the normal drop, so they land on the floor for the killer, or in a loot key.
- **Never for preset items:** they're deleted first, so a killer can't get a free staff and orb from spawned gear.
- **Everywhere else** (PvM deaths, minigames that handle their own deaths) the staff is kept as before.

## Special attack graphics (cache)

There are no captures of either staff, so these come from the cache's names:

| Special | Caster | Target |
| --- | --- | --- |
| Immolate (volatile) | `nightmare_staff_special` (8532), `nightmare_staff_volatile_cast_spotanim` (1760) | `nightmare_staff_volatile_hit_spotanim` (1759) |
| Invocate (eldritch) | 8532, `nightmare_staff_eldritch_cast_spotanim` (1762) | `nightmare_staff_eldritch_hit_spotanim` (1761) |

- A miss shows the usual magic splash (85) instead of the hit graphic.
- **Immolate's animation never showed before:** ending the special reset combat with the reset animation on the same tick, which cancelled `nightmare_staff_special`. It now resets without it.
- Immolate has no projectile (Wiki).
- **Inferred:** the Wiki gives Invocate its own attack animation; `nightmare_staff_special` is the only special attack animation the cache has for these staffs. Before, Invocate had no animation or graphics, and Immolate no graphics.

## Not covered

- **Stacks:** neither the Wiki page nor the captures show whether a stack of a valuable item fills one kept slot or is counted item by item, so a stack is still kept or lost whole.
- **Dismantle and attaching orbs** (the Wiki's "reverted to its tradeable components at any time").
