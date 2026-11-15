/**
 * Attack styles: a rule of our world, not of OSRS. Some weapons train differently here than in
 * the real game.
 *
 * What a style trains comes from data/definitions/item-combat-styles.json, but that file is
 * made from the game cache and checked against it, so our changes are made here instead, once
 * the styles are loaded. A style is one of a weapon type's slots, shared by every weapon of the
 * type: SCYTHE_JAB is the Jab of every scythe, the Scythe of vitur in all its forms included.
 *
 * To change another, add its key in item-combat-styles.json ("fightTypes") to STYLES below with
 * ACCURATE (Attack XP), AGGRESSIVE (Strength), DEFENSIVE (Defence) or CONTROLLED (shared).
 * The style also sets the small level bonus a swing gets, as in OSRS: a shared style gives +1
 * to Attack, Strength and Defence where an aggressive one gives +3 Strength.
 */
const STYLES = {
  // Jab trains Attack, Strength and Defence together (it was Strength only).
  SCYTHE_JAB: "CONTROLLED",
};

module.exports = {
  name: "AttackStyles",
  description: "Changes what some weapons' attack styles train on this world: the scythes' Jab gives shared XP (Attack, Strength and Defence) instead of Strength.",
  register(api) {
    const { FightType, FightStyle } = api.core;
    for (const [key, style] of Object.entries(STYLES)) {
      const fightType = FightType[key];
      const fightStyle = FightStyle[style];
      if (!fightType || !fightStyle) {
        console.warn(`[attack-styles] ${key}: no such style or kind (${style}); left as it is`);
        continue;
      }
      // FightType keeps its style in a field it only reads (getStyle).
      fightType.style = fightStyle;
    }
  },
  _test: { STYLES },
};
