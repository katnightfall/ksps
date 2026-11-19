"use strict";

/**
 * Ours (upstream issue #4101): the Jungle Demon's attacks.
 *
 * The monster data gives it two styles ("slash", "magic") and the engine takes one default style from
 * that list, so it only ever swung in melee and a player who kept away was never attacked at all.
 *
 * The Wiki (Jungle Demon): "alternates between all four wave spells, each hitting for up to 32 damage";
 * "when in range, it uses a halberd-like attack that can hit two tiles away, with a max hit of 32";
 * staying "three or more squares away" avoids the melee attack; standing still after the teleport "the
 * demon won't move until you do, though it will still use magic". So: within two tiles it swings, further
 * off it casts the next wave in turn, and it attacks from casting range rather than walking in first.
 *
 * The cache names its sequences demon_attack and demon_casting. The waves are the standard spellbook's own
 * (their projectiles and graphics), cast with the demon's sequence and the Wiki's maximum.
 *
 * Not sourced, ours: the order of the four waves (the spellbook's: wind, water, earth, fire). The 10th
 * Squad's gnomes, who wear the demon down in live, are not part of this.
 */
const MAX_HIT = 32;
const MELEE_REACH = 2;
const WAVES = ["WIND_WAVE", "WATER_WAVE", "EARTH_WAVE", "FIRE_WAVE"];

module.exports = function attachJungleDemon(api, { npcId }) {
  const { Animation, CacheDefinitions, CombatMethod, CombatSpells, MagicCombatMethod, MeleeCombatMethod } = api.core;
  const spells = new Map();

  const sequence = (name) => {
    const id = CacheDefinitions.getSeqId(name);
    return Number.isInteger(id) && id >= 0 ? id : null;
  };

  function wave(name) {
    if (spells.has(name)) return spells.get(name);
    const spell = Object.create(CombatSpells[name]);
    const cast = sequence("demon_casting");
    if (cast != null) spell.castAnimation = () => new Animation(cast);
    spell.maximumHit = () => MAX_HIT;
    spells.set(name, spell);
    return spell;
  }

  /** Tiles between the demon's footprint and the target, 0 when they overlap or touch corners inside it. */
  function distance(npc, target) {
    const at = npc.getLocation();
    const to = target.getLocation();
    const size = npc.getSize();
    return Math.max(0, at.getX() - to.getX(), to.getX() - (at.getX() + size - 1),
      at.getY() - to.getY(), to.getY() - (at.getY() + size - 1));
  }

  /** Which wave each demon casts next. The method object is made afresh for every attack; this is not. */
  const nextWave = new WeakMap();

  class JungleDemonCombat extends CombatMethod {
    constructor(npc) {
      super();
      this.melee = new MeleeCombatMethod();
      this.magic = new MagicCombatMethod();
      // Asked for its style before the attack starts (the pursuit and the reach): as the target stands now.
      const target = npc?.getCombat?.().getTarget?.();
      this.active = target && distance(npc, target) <= MELEE_REACH ? this.melee : this.magic;
    }

    type() {
      return this.active.type();
    }

    // It casts from where it stands; the swing is chosen at the attack, when the target is close enough.
    attackDistance(npc) {
      return this.magic.attackDistance(npc);
    }

    attackSpeed(npc) {
      return this.melee.attackSpeed(npc);
    }

    start(npc, target) {
      if (distance(npc, target) <= MELEE_REACH) {
        this.active = this.melee;
        npc.getCombat().setCastSpell(null);
        this.melee.start(npc, target);
        const swing = sequence("demon_attack");
        if (swing != null) npc.performAnimation(new Animation(swing));
        return;
      }
      this.active = this.magic;
      const turn = nextWave.get(npc) ?? 0;
      nextWave.set(npc, (turn + 1) % WAVES.length);
      npc.getCombat().setCastSpell(wave(WAVES[turn]));
      this.magic.start(npc, target);
    }

    hits(npc, target) {
      return this.active.hits(npc, target);
    }

    handleAfterHitEffects(hit) {
      this.active.handleAfterHitEffects(hit);
    }

    finished(npc, target) {
      this.active.finished(npc, target);
      npc.getCombat().setCastSpell(null);
    }
  }

  api.registerNpcCombatMethodProvider([npcId], JungleDemonCombat, { singleton: false });
  return { JungleDemonCombat, distance, MAX_HIT, MELEE_REACH, WAVES };
};
