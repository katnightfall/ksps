/**
 * The Birds and the Wasps: the bee dealer by the Grand Exchange's east entrance (3187, 3493; he shows only at baw 10-15)
 * and the bee box he hands over.
 *
 * Lines and boxes: Transcript:The Birds and the Wasps. The box (Wiki: Bee box, The Birds and the Wasps): while it is
 * carried, the insects now and then get agitated ("Best give them a shake.", in red), and the box moves to a random
 * place in the inventory; left agitated, they sting through the holes for 1 damage, which can kill; Shake calms them,
 * and shaking calm insects stings too.
 *
 * Not documented, so ours: how long the insects stay calm (30 to 60 ticks), how long agitated insects wait before
 * each sting (10 ticks), and the shake having no animation of its own.
 */
module.exports = function createBees(api, common) {
  const { Task, TaskManager, HitDamage, HitMask, Item } = api.core;
  const { STAGE, NPC, ITEM, play, stageOf, setStage, carried, banked } = common;
  const D = (text) => ({ npc: NPC.DEALER, text });
  const P = (text) => ({ player: text });

  const CALM_MIN_TICKS = 30;
  const CALM_MAX_TICKS = 60;
  const STING_TICKS = 10;
  const STING_DAMAGE = 1;
  const AGITATED = "You can sense the insects in the box getting agitated. Best give them a shake.";
  const LASH_OUT = "The agitated insects lash out and sting you through the holes in the box.";
  const CALMED = "You give the box a firm shake and the insects seem to calm down.";
  const SHOOK_CALM = "The insects don't seem to appreciate being shook and sting you through the holes in the box.";

  /** player -> { agitated, due, task } while they carry the box. */
  const boxes = new Map();

  // ------------------------------------------------------------------ the dealer

  function talk({ player }) {
    const stage = stageOf(player);
    if (stage === STAGE.STARTED) {
      play(player, [
        D("Need any... bees?"),
        P("I've come to collect Bea's bees."),
        D("Then you've come to the right place."),
        { item: ITEM.BEE_BOX, text: "Out of nowhere, the dealer produces a rather insecure looking box." },
        D("Before I hand you this box, I should tell you about proper insect handling."),
        D("If they get annoyed, give them a shake. If they don't, don't ever shake them."),
        P("That's it?"),
        D("That's it."),
      ], () => handOver(player, "The dealer shoves the box into your hands."));
      return true;
    }
    if (stage === STAGE.BEES_COLLECTED && (carried(player, ITEM.BEE_BOX) > 0 || banked(player, ITEM.BEE_BOX))) {
      play(player, [D("Need any... bees?"), P("Thanks, but I'm already at my stinging insect quota right now.")]);
      return true;
    }
    if (stage === STAGE.BEES_COLLECTED) {
      play(player, [D("Need any... bees?"), P("I've lost Bea's bees."), D("Plenty more where they came from.")],
        () => handOver(player, "The dealer shoves a box into your hands."));
    }
    // At any other stage the cache does not show him (baw_bee_dealer_multi: baw 10-15).
    return true;
  }

  function handOver(player, text) {
    if (player.getInventory().getFreeSlots() <= 0) {
      play(player, [D("But you'll need to make some more space to carry them.")]);
      return;
    }
    play(player, [{ item: ITEM.BEE_BOX, text, on: () => {
      const stage = stageOf(player);
      if ((stage !== STAGE.STARTED && stage !== STAGE.BEES_COLLECTED) || player.getInventory().getFreeSlots() <= 0) return;
      player.getInventory().adds(ITEM.BEE_BOX, 1);
      if (stage === STAGE.STARTED) setStage(player, STAGE.BEES_COLLECTED);
      watch(player);
    } }]);
  }

  // ------------------------------------------------------------------ the box

  const highlight = (player, colour, text) => {
    const transparent = player.getPacketSender?.()?.getVarbit?.(4608) === 1; // chatbox_transparency, as QuestRuntime.questLink
    return api.core.resolveChatHighlights(`@mes_hl_${colour}@${text}</col>`, transparent);
  };
  const calmFor = () => CALM_MIN_TICKS + Math.floor(Math.random() * (CALM_MAX_TICKS - CALM_MIN_TICKS + 1));

  function sting(player) {
    player.getCombat().getHitQueue().addPendingDamage([new HitDamage(STING_DAMAGE, HitMask.RED)]);
  }

  /** The box goes to a random place in the inventory (Wiki: Bee box). */
  function jostle(player) {
    const inventory = player.getInventory();
    const from = inventory.getItems().findIndex((item) => item?.getId?.() === ITEM.BEE_BOX);
    if (from < 0) return;
    const to = Math.floor(Math.random() * inventory.capacity());
    if (to === from) return;
    if (!inventory.getItems()[to]) inventory.setItem(to, new Item(-1, 0));
    inventory.swap(from, to);
    inventory.refreshItems();
  }

  /** Starts the box's mood for a player carrying it (handed over, or at login). */
  function watch(player) {
    if (boxes.has(player) || carried(player, ITEM.BEE_BOX) <= 0) return;
    const state = { agitated: false, due: calmFor(), task: null };
    state.task = new (class extends Task {
      constructor() { super(1, player, false); }
      execute() {
        if (!player.isRegistered?.() || carried(player, ITEM.BEE_BOX) <= 0) { stop(player); return; }
        if (--state.due > 0) return;
        if (!state.agitated) {
          state.agitated = true;
          player.sendMessage(highlight(player, "red", AGITATED));
          jostle(player);
        } else {
          player.sendMessage(highlight(player, "red", LASH_OUT));
          sting(player);
        }
        state.due = STING_TICKS;
      }
    })();
    boxes.set(player, state);
    TaskManager.submit(state.task);
  }

  function stop(player) {
    const state = boxes.get(player);
    if (!state) return;
    boxes.delete(player);
    state.task?.stop?.();
  }

  function shake({ player }) {
    if (carried(player, ITEM.BEE_BOX) <= 0) return true;
    watch(player);
    const state = boxes.get(player);
    if (state?.agitated) {
      state.agitated = false;
      state.due = calmFor();
      play(player, [{ item: ITEM.BEE_BOX, text: CALMED }]);
      player.sendMessage(highlight(player, "gre", CALMED));
    } else {
      play(player, [{ item: ITEM.BEE_BOX, text: SHOOK_CALM }]);
      sting(player);
    }
    return true;
  }

  return {
    talk, shake, watch, stop,
    agitated: (player) => boxes.get(player)?.agitated === true,
    /** Test and admin hook: make the box's next tick the one that changes its mood. */
    hurry: (player) => { const state = boxes.get(player); if (state) state.due = 1; },
  };
};
