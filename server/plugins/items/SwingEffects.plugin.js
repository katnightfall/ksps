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

/** Every form of the Scythe of vitur: plain, holy, sanguine and corrupted, charged or not. */
const SCYTHE_OF_VITUR = /(^|_)SCYTHE_OF_VITUR(_|$)/;

function weaponGraphics(ItemIdentifiers) {
  const graphics = new Map([
    [ItemIdentifiers.BLURITE_SWORD, REDEMPTION_GRAPHIC],
  ]);
  for (const [name, id] of Object.entries(ItemIdentifiers)) {
    if (SCYTHE_OF_VITUR.test(name)) graphics.set(id, REDEMPTION_GRAPHIC);
  }
  return graphics;
}

function attackStarted({ attacker }) {
  if (!attacker?.isPlayer?.()) return;
  const weapon = attacker.getEquipment().get(core.Equipment.WEAPON_SLOT)?.getId?.() ?? -1;
  const graphic = swingGraphics.get(weapon);
  if (graphic !== undefined) attacker.performGraphic(new core.Graphic(graphic));
}

module.exports = {
  name: "SwingEffects",
  description: "Plays a show-only graphic on the wielder with each swing of certain weapons: the Blurite sword and every Scythe of vitur show the Redemption prayer's effect.",
  register(api) {
    core = api.core;
    swingGraphics = weaponGraphics(core.ItemIdentifiers);
    api.onCustomEvent("combat:attack-started", attackStarted);
  },
  _test: { attackStarted, weaponGraphics },
};
