/**
 * Swing effects: a rule of our world, not of OSRS. Some weapons play a graphic on their wielder
 * with every attack, for show only: nothing is healed, drained or changed.
 *
 * It answers "combat:attack-started", which Combat sends as each swing begins, special attacks
 * included. To give another weapon an effect, add it to SWING_GRAPHICS below.
 */
/** The Redemption prayer's heal effect (the graphic CombatFactory.handleRedemption plays). */
const REDEMPTION_GRAPHIC = 436;

let core;
/** Weapon item id -> the graphic played on its wielder with each swing. */
let swingGraphics;

function weaponGraphics(ItemIdentifiers) {
  return new Map([
    [ItemIdentifiers.BLURITE_SWORD, REDEMPTION_GRAPHIC],
  ]);
}

function attackStarted({ attacker }) {
  if (!attacker?.isPlayer?.()) return;
  const weapon = attacker.getEquipment().get(core.Equipment.WEAPON_SLOT)?.getId?.() ?? -1;
  const graphic = swingGraphics.get(weapon);
  if (graphic !== undefined) attacker.performGraphic(new core.Graphic(graphic));
}

module.exports = {
  name: "SwingEffects",
  description: "Plays a show-only graphic on the wielder with each swing of certain weapons: the Blurite sword shows the Redemption prayer's effect.",
  register(api) {
    core = api.core;
    swingGraphics = weaponGraphics(core.ItemIdentifiers);
    api.onCustomEvent("combat:attack-started", attackStarted);
  },
  _test: { attackStarted },
};
