/**
 * The Birds and the Wasps: Farmer Bea, on her farm south west of the Digsite (3316, 3376), from the start to the reward,
 * and after it: her Talk-to menu, Trade (Bea's Hunting Gear) and Swap-darts.
 *
 * Every line is the Wiki's (Transcript:The Birds and the Wasps; after the quest Transcript:Farmer Bea). The three scenes
 * are played as their dialogue: the transcript's stage directions ("Farmer Bea places the insects in the beehive. A
 * swarm of wasps appears.", the honey buzzards chasing the wasps, the killer wasps and black honey buzzards) are not
 * shown, as no camera or animation of them is documented.
 */
module.exports = function createBea(api, common, { giveSnares, beeBoxDelivered }) {
  const { STAGE, NPC, ITEM, ATTRIBUTE, VARBIT, play, stageOf, setStage, carried, count, setFlag } = common;
  const B = (text, extra) => ({ npc: NPC.BEA, text, ...extra });
  const BA = (text, extra) => ({ npc: NPC.BEA_AFTER, text, ...extra });
  const P = (text, extra) => ({ player: text, ...extra });

  const SHOP_NAME = "Bea's Hunting Gear";
  /** Ours: the shop's id while the generated shops.json (the Wiki dump) has no Bea's Hunting Gear. */
  const OWN_SHOP_ID = 690221;

  // ------------------------------------------------------------------ before and during the quest

  function talk(player) {
    const stage = stageOf(player);
    if (stage >= STAGE.COMPLETE) return afterQuest(player);
    if (stage < STAGE.STARTED) return startingOff(player);
    if (stage === STAGE.BEES_COLLECTED && carried(player, ITEM.BEE_BOX) > 0) return deliverBees(player);
    if (stage < STAGE.BEES_DELIVERED) {
      return play(player, [B("Alright, me luvver! When yer've got me bees from the bloke in the Grand Exchange, just pop back."), P("Will do!")]);
    }
    if (stage === STAGE.BEES_DELIVERED) return hiveScene(player);
    if (stage < STAGE.BIRDS) {
      if (carried(player, ITEM.WASP_STING) >= common.WASPS_NEEDED) return showStings(player);
      return play(player, [
        B("Ain't got two bees t'rub togetha' and now we got wasps squattin' in me 'ives!"),
        P("Could you remind me how to get rid of them?"),
        ...waspInstructions(),
      ]);
    }
    if (stage < STAGE.DARTS) {
      const birds = stage >= STAGE.BIRDS_CAUGHT || count(player, ATTRIBUTE.BIRDS_CAUGHT) >= common.BIRDS_NEEDED;
      if (birds && carried(player, ITEM.BROWN_FEATHER) >= common.FEATHERS_NEEDED) return showFeathers(player);
      return play(player, [P("Could you remind me how to deal with those birds?")], () => snares(player));
    }
    const darts = carried(player, ITEM.WASP_DART);
    if (darts >= common.DARTS_NEEDED) return finish(player);
    if (darts > 0) {
      return play(player, [
        P("I've made some darts using the stings and feathers I gathered. I reckon they could be useful for something, but I'm going to make some more first."),
        B("Well, at least we're makin' the best o' a bad job."),
      ]);
    }
    return play(player, [
      P("What did you want me to do again?"),
      B("See if y'can make anythin' useful by puttin' those bird feathers 'n' stings you gathered togetha."),
      P("Can't hurt to try."),
    ]);
  }

  function startingOff(player) {
    play(player, [
      B("Alright, me luvver! Welcome to me farm!"),
      P("Thank you! What exactly do you farm here?"),
      B("Well, this place is new i'nt it? Bea's farm be a bee farm, just as soon as we set 'er up. Don't s'pose yer could give us an 'and with that, could yer?"),
      { menu: "Start The Birds and the Wasps quest?", options: [
        ["Yes.", () => accept(player)],
        ["No.", () => play(player, [P("Actually, I think I might be allergic to bees."), B("Well, tha's a shame ain't it?")])],
      ] },
    ]);
  }

  function accept(player) {
    if (stageOf(player) >= STAGE.STARTED) return;
    setStage(player, STAGE.STARTED);
    player.sendMessage(require("../QuestRuntime").questStartMessage(player, common.QUEST_NAME));
    play(player, [
      P("Of course! What do you need?"),
      B("I'm wantin' to fill up me hives with bees. I ordered some from a dealer in Varrock. 'e was a bit o' a shady bloke, 'angin' around the east entrance o' the Grand Exchange, but 'e seemed to know 'is stuff."),
      B("Would ya mind goin' an pickin' 'em up for me?"),
      P("I'm sure I can help with that!"),
      B("Want a glass o' cider first? Just the thing to give ya a bit o' energy before yer go."),
      { menu: "Select an option", options: [
        ["I'd love one.", () => play(player, [
          P("I'd love one."),
          { item: api.core.ItemIdentifiers.CIDER, text: "Bea hands you a glass of cider. You drink it right away and find yourself feeling refreshed.",
            on: () => drinkCider(player) },
          B("When yer've got me bees from the bloke in the Grand Exchange, just pop back."),
          P("Will do!"),
        ])],
        ["No thank you.", () => play(player, [
          P("No thank you."),
          B("Fair enough. When yer've got me bees from the bloke in the Grand Exchange, just pop back."),
          P("Will do!"),
        ])],
      ] },
    ]);
  }

  /** Wiki (The Birds and the Wasps): the cider "will fully restore run energy". The cache keeps baw_had_cider. */
  function drinkCider(player) {
    player.setRunEnergy(100);
    setFlag(player, ATTRIBUTE.HAD_CIDER, VARBIT.HAD_CIDER);
  }

  function deliverBees(player) {
    play(player, [
      P("Here are your bees!"),
      { item: ITEM.BEE_BOX, text: "You hand over the box of disgruntled insects.", on: () => handOverBox(player) },
      B("Great! I'll get these lovelies in their new 'ome. You wanna watch 'em move in?"),
      P("I'd be delighted!"),
    ], () => hiveScene(player));
  }

  function handOverBox(player) {
    if (stageOf(player) !== STAGE.BEES_COLLECTED || carried(player, ITEM.BEE_BOX) <= 0) return;
    player.getInventory().deleteNumber(ITEM.BEE_BOX, 1);
    beeBoxDelivered(player);
    setStage(player, STAGE.BEES_DELIVERED);
  }

  function waspInstructions() {
    return [
      B("Grab some kit outta me box 'ere. You'll need a net t'catch 'em, somethin' to protect yerself and a bit o' the ol' bug spray to calm 'em down."),
      B("Catch 50 o' the blighters to thin 'em out, then bring me some proof ya done it, right?"),
      P("Alright, I'll gear up and catch some wasps."),
    ];
  }

  /** The bees go into the hive and turn out to be wasps. The stage moves on as Bea sends the player for her kit. */
  function hiveScene(player) {
    if (stageOf(player) !== STAGE.BEES_DELIVERED) return;
    const [kit, ...rest] = waspInstructions();
    play(player, [
      B("Right, lets get these lil' fuzzy bumblers moved in."),
      P("Are they...?"),
      B("Wasps?!"),
      P("They look mad!"),
      B("Every farmer fer 'emself!"),
      B("Wot kind o' bees turn inta wasps on transit!"),
      P("I'm not sure they were ever bees."),
      B("Well, I'd appreciate a bit more o ya help! Ain't got two bees t'rub togetha' and now we got wasps squattin' in me 'ives!"),
      P("How can I get rid of wasps?"),
      { ...kit, on: () => { if (stageOf(player) === STAGE.BEES_DELIVERED) setStage(player, STAGE.WASPS); } },
      ...rest,
    ]);
  }

  /** Back with 50 stings: Bea sees them, then the honey buzzards come for the wasps. */
  function showStings(player) {
    play(player, [
      P("I've caught 50 wasps. Here, I have some of their stings as proof."),
      { item: ITEM.WASP_STING, text: "You show the wasp stings to Bea." },
      B("Reckon the wasps ain't gonna be 'appy 'bout that. They're still all o'er the shop tho'."),
      B("Well, I s'pose we'd best..."),
      B("... Did ye hear tha'?"),
      P("We should probably go and find out what's going on..."),
      B("See anythin'?"),
      P("Yeah, I spotted something."),
      B("Well, this won' do at all."),
      B("Birds really wasn't wot I was 'opin' to farm."),
      P("It's quite a diverse ecosystem you are building up here!"),
      B("If we do get any bees, these birds'll wipe 'em out."),
      P("In that case, how can I deal with them?", { on: () => {
        const stage = stageOf(player);
        if (stage >= STAGE.WASPS && stage < STAGE.BIRDS) setStage(player, STAGE.BIRDS);
      } }),
    ], () => snares(player));
  }

  /** Bea's bird snares, two for none carried and one for one (Wiki: Bird snare, "Two bird snares are given ... by Farmer Bea"). */
  function snares(player) {
    const given = giveSnares(player);
    if (given === null) {
      return play(player, [B("You'll need a bit more space to 'elp. Got some bird snares for ya here.")]);
    }
    play(player, [
      given === 2 ? { items: [ITEM.SNARE, ITEM.SNARE], text: "Bea hands you some bird snares." }
        : given === 1 ? { item: ITEM.SNARE, text: "Bea hands you a bird snare." } : null,
      B("If ye set yer bird snares up around the birds, there's a good chance they'll land an' get caught in 'em."),
      B("Catch us five birds at least, and bring 50 o' their feathers to prove it."),
      P("Alright, back in a bit!"),
    ]);
  }

  /** Back with five birds and 50 brown feathers: the replacement bees, which are killer wasps. */
  function showFeathers(player) {
    play(player, [
      P("I've culled some birds and collected 50 of their feathers."),
      B("Good job! While yer were doin' that, I went an' gave that bee dealer a piece o' me mind. Got us some replacement bees, I did. Got 'nother spot picked out for 'em just up there."),
      P("Let's go get them set up then."),
      { box: "You head over to the new hives, excited to finally introduce some bees to their new homes..." },
      { box: "However, some time later..." },
      P("So you say these killer wasps are much worse than the normal ones?"),
      B("Yeah, I reckon they are..."),
      P("This bee dealer is leaving a lot to be desired."),
      B("I'm not gonna' get me 'oney am I?"),
      P("Doesn't look like it..."),
      B("Do me another solid will ya? See if y'can make anythin' useful by puttin' those bird feathers 'n' stings you gathered togetha. Might be we can still achieve somethin' 'ere.", { on: () => {
        const stage = stageOf(player);
        if (stage >= STAGE.BIRDS && stage < STAGE.DARTS) setStage(player, STAGE.DARTS);
      } }),
      P("Can't hurt to try."),
    ]);
  }

  function finish(player) {
    play(player, [
      P("I've made 50 darts using the stings and feathers I gathered. I can't see myself ever having a use for them, but maybe someone else will want them."),
      B("Can probably sell 'em to the local guards. They ain't too picky with the gear they use. Feel free to give me any ya make an' I can pay yer back in useful supplies."),
      P("Sounds good to me."),
      { box: "You glance around at the mess of insects and birds on the plot of land." },
      P("It's certainly a unique farm we've created here."),
      B("It's a shame I won't get me 'oney, but at least we ain't come away with nothin'. Yer help's been wonderful, it has!"),
      P("Happy to be a part of it!"),
    ], () => {
      if (stageOf(player) >= STAGE.DARTS && carried(player, ITEM.WASP_DART) >= common.DARTS_NEEDED) common.quest().complete(player);
    });
  }

  // ------------------------------------------------------------------ after the quest (Transcript:Farmer Bea)

  function afterQuest(player) {
    play(player, [BA("Alright, me luvver!")], () => menu(player));
  }

  function menu(player) {
    play(player, [{ menu: "Select an option", options: [
      ["How's the farm going, Bea?", () => play(player, [
        P("How's the farm going Bea?"),
        BA("It's alright. Not surrounded by 'oney like what I intended, but I'm getting by."),
        P("Good to hear! I suppose you won't mind if I hunt some more of your creatures?"),
        BA("Not at all. Take as many as yer like! Remember, if yer make more darts, I can swap 'em for stuff."),
      ], () => menu(player))],
      ["Do you have anything for sale?", () => play(player, [
        P("Do you have anything for sale?"),
        BA("I've got a stock o' hunting gear, given me farm seems t'revolve 'round it."),
      ], () => openShop(player))],
      ["Can I trade in some darts?", () => tradeDarts(player)],
      ["Do you have any hunting tips for me?", () => play(player, [
        P("Do you have any hunting tips for me?"),
        BA("As it 'appens, the bloke who sold me the 'untin' stock fer me shop wouldn' stop talkin', so I picked a bit up. Got some local info, or further out. Whatcha wantin'?"),
      ], () => tips(player))],
      ["I'd best be off.", () => play(player, [P("I'd best be off.")])],
    ] }]);
  }

  function tips(player) {
    play(player, [{ menu: "Select an option", options: [
      ["Could you tell me about hunting locally?", () => play(player, [
        P("Could you tell me about hunting locally?"),
        BA("Well, if yer want ye can hunt some more o' the birds an' wasps here. If ya don't fancy that, I 'eard lots o' funny coloured birds 'ave popped up recently in places not too far from 'ere."),
        BA("Some north o' Al Kharid, some at Musa Point and a few north o' Falador. Apparently there's some butterflies at Falador as well."),
        BA("Birds I reckon yer know 'ow to catch. An' for butterflies, just catch 'em like wasps, ya do. Need jars for 'em though."),
      ], () => tips(player))],
      ["Could you tell me about hunting further afield?", () => play(player, [
        P("Could you tell me about hunting further afield?"),
        BA("When ye have a bit o' experience, yer best bet is the Hunter Guild in Varlamore, I reckon. Else, there are a few big 'untin' grounds to try..."),
        BA("Piscatoris 'as a load o' woodland creatures to trap. If ya don't mind the cold, north of Rellekka there's plenty o' animals in the ice 'n' snow. Finally, the Feldip Hills 'as a lot of jungle critters for 'untin'."),
      ], () => tips(player))],
      ["Actually, let's talk about something else.", () => play(player, [P("Let's talk about something else.")], () => menu(player))],
    ] }]);
  }

  /** How many supply bags the carried darts buy: 35 wasp darts or 20 killer wasp darts each. */
  function bagsFor(player) {
    return Math.floor(carried(player, ITEM.WASP_DART) / common.WASP_DARTS_PER_BAG)
      + Math.floor(carried(player, ITEM.KILLER_WASP_DART) / common.KILLER_WASP_DARTS_PER_BAG);
  }

  function tradeDarts(player) {
    if (bagsFor(player) === 0) {
      return play(player, [
        P("Can I trade in some darts?"),
        BA("Yer can, but I'm 'fraid yer not got enough darts. For one supply bag it'll either be 35 wasp darts or 20 killer wasp darts."),
      ], () => menu(player));
    }
    play(player, [P("Can I trade in some darts?")], () => swapDarts(player));
  }

  /**
   * Every whole lot of darts for a supply bag each (Wiki: Farmer Bea, Bea's supplies). The Wiki's transcript of the trade
   * itself is missing ("Incomplete: dart trade in dialogue"), so the box saying it is ours.
   */
  function swapDarts(player) {
    const inventory = player.getInventory();
    const waspLots = Math.floor(carried(player, ITEM.WASP_DART) / common.WASP_DARTS_PER_BAG);
    const killerLots = Math.floor(carried(player, ITEM.KILLER_WASP_DART) / common.KILLER_WASP_DARTS_PER_BAG);
    const bags = waspLots + killerLots;
    if (bags === 0) {
      return play(player, [BA("Yer can, but I'm 'fraid yer not got enough darts. For one supply bag it'll either be 35 wasp darts or 20 killer wasp darts.")]);
    }
    // The bags stack: room for one stack, or one already carried.
    const fits = inventory.getAmount(ITEM.SUPPLIES) > 0 || inventory.getFreeSlots() > 0
      || (waspLots * common.WASP_DARTS_PER_BAG === carried(player, ITEM.WASP_DART) && waspLots > 0)
      || (killerLots * common.KILLER_WASP_DARTS_PER_BAG === carried(player, ITEM.KILLER_WASP_DART) && killerLots > 0);
    if (!fits) {
      inventory.full();
      return;
    }
    if (waspLots > 0) inventory.deleteNumber(ITEM.WASP_DART, waspLots * common.WASP_DARTS_PER_BAG);
    if (killerLots > 0) inventory.deleteNumber(ITEM.KILLER_WASP_DART, killerLots * common.KILLER_WASP_DARTS_PER_BAG);
    inventory.adds(ITEM.SUPPLIES, bags);
    play(player, [{ item: ITEM.SUPPLIES, text: bags === 1 ? "You swap some darts with Bea for a bag of her supplies."
      : `You swap some darts with Bea for ${bags} bags of her supplies.` }]);
  }

  /**
   * Bea's Hunting Gear (Wiki: Bea's Hunting Gear, Farmer Bea): the generated shops.json's shop of that name once the Wiki
   * dump has it, else this one, registered here with the Wiki's stock and prices.
   */
  function openShop(player) {
    const { ShopDefinition, ShopManager, ItemIdentifiers: I } = api.core;
    const listed = ShopDefinition.all().find((shop) => shop.getName() === SHOP_NAME && shop.getId() !== OWN_SHOP_ID);
    if (listed) return ShopManager.open(player, listed.getId());
    if (!ShopManager.hasShop(OWN_SHOP_ID)) {
      // { stock, restock } per the Wiki's StoreLines; sells at 130%, buys at 40%, 2% a step (its StoreTableHead).
      const stock = [[I.BUTTERFLY_JAR, 100, 10], [I.MAGIC_BOX, 30, 50], [I.NOOSE_WAND, 50, 5], [I.BIRD_SNARE, 50, 5],
        [I.BOX_TRAP, 25, 10], [I.TEASING_STICK, 5, 10], [I.UNLIT_TORCH, 20, 10], [I.RABBIT_SNARE, 10, 10], [I.NET_TRAP, 25, 10],
        [I.BIRD_SNARE_PACK, 3, 10], [I.BOX_TRAP_PACK, 3, 10], [I.MAGIC_IMP_BOX_PACK, 3, 10]]
        .map(([id, amount, restockTicks]) => ({ id, amount, restockTicks, price: null }));
      ShopManager.registerShop(new ShopDefinition(OWN_SHOP_ID, SHOP_NAME, "COINS", stock, 4, 4, 100, "the-birds-and-the-wasps",
        { sellsAt: 1300, buysAt: 400, changePer: 20 }));
    }
    ShopManager.open(player, OWN_SHOP_ID);
  }

  function trade({ player }) {
    if (stageOf(player) < STAGE.COMPLETE) return false;
    openShop(player);
    return true;
  }

  function swap({ player }) {
    if (stageOf(player) < STAGE.COMPLETE) return false;
    swapDarts(player);
    return true;
  }

  return { talk: ({ player }) => { talk(player); return true; }, trade, swap, OWN_SHOP_ID, SHOP_NAME };
};
