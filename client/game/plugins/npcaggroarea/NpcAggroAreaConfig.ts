import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/**
 * RuneLite's NpcAggroAreaConfig: group, keys, names, descriptions and defaults as in RuneLite.
 * Its Notification item is an on/off switch here. Not ported: "Hide when out of combat" (the
 * client API has no health scale to read) and "Show on slayer task" (no Slayer plugin service).
 */
export const NpcAggroAreaConfig = ConfigGroup("npcUnaggroArea", {
    alwaysActive: ConfigItem({
        keyName: "npcUnaggroAlwaysActive",
        name: "Always active",
        description: "Always show this plugin's overlays. Otherwise, they will only be shown when any NPC name matches the list.",
        position: 1,
        default: false,
    }),
    npcNamePatterns: ConfigItem({
        keyName: "npcUnaggroNames",
        name: "NPC names",
        description: "Enter names of NPCs where you wish to use this plugin.",
        position: 2,
        default: "",
    }),
    showTimer: ConfigItem({
        keyName: "npcUnaggroShowTimer",
        name: "Show timer",
        description: "Display a timer until NPCs become unaggressive.",
        position: 3,
        default: true,
    }),
    showAreaLines: ConfigItem({
        keyName: "npcUnaggroShowAreaLines",
        name: "Show area lines",
        description: "Display lines, when walked past, the unaggressive timer resets.",
        position: 4,
        default: false,
    }),
    aggroAreaColor: ConfigItem({
        keyName: "npcAggroAreaColor",
        name: "Aggressive color",
        description: "Choose color to use for marking NPC unaggressive area when NPCs are aggressive.",
        position: 5,
        color: true,
        alpha: true,
        default: 0x64ffff00,
    }),
    unaggroAreaColor: ConfigItem({
        keyName: "npcUnaggroAreaColor",
        name: "Unaggressive color",
        description: "Choose color to use for marking NPC unaggressive area after NPCs have lost aggression.",
        position: 6,
        color: true,
        alpha: true,
        default: 0xffffff00,
    }),
    notifyExpire: ConfigItem({
        name: "Notify expiration",
        description: "Send a notification when the unaggressive timer expires.",
        position: 7,
        default: false,
    }),
});
