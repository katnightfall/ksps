const path = require("path");
const { initPvpTierLoadouts } = require("./behaviours/pvp/PvpTierLoadouts.PlayerBots");
const { GameConstants } = require("../../src/main/typescript/elvarg/game/GameConstants");
const { Wilderness } = require("../../src/main/typescript/elvarg/game/content/wilderness/Wilderness");
const { ObjectIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const {
  resetMovementState,
  initPlayerBotStateCoreAccess,
} = require("./behaviours/state/State.PlayerBots");
const { registerBotCommands } = require("./runtime/RegisterBotCommands.PlayerBots");
const { registerBotEvents } = require("./runtime/RegisterBotEvents.PlayerBots");
const { registerPvpChatter } = require("./behaviours/pvp/PvpChatter.PlayerBots");
const { createBotPluginLogging } = require("./runtime/PluginLogging.PlayerBots");
const { bootPlayerBotsRuntime } = require("./runtime/PluginBoot.PlayerBots");
const { createBotBenchmark } = require("./runtime/Benchmark.PlayerBots");
const { startBotSites } = require("./brain/SiteSpawner.PlayerBots");
const { attachBotExchange } = require("./brain/actions/Exchange.PlayerBots");
const { createAmbition, worldHasAmbition } = require("./brain/Ambition.PlayerBots");
const { createBotPotions } = require("./brain/BotPotions.PlayerBots");
const { createBotTalk } = require("./brain/BotTalk.PlayerBots");
const { createBotGroups, worldBotsGroup } = require("./brain/BotGroups.PlayerBots");
const { createBotWintertodt } = require("./brain/BotWintertodt.PlayerBots");
const { setActiveBotRuntime } = require("./runtime/RuntimeRegistry.PlayerBots");
const { PVP_BOT_SETTINGS } = require("./behaviours/pvp/WildernessHotspotRegistry.PlayerBots");
const {
  registerBotStatusInteractions,
} = require("./runtime/RegisterBotStatusInteractions.PlayerBots");
const { registerAiBots } = require("./ai/RegisterAiBots.PlayerBots");
const { AI_BOT_ATTRIBUTE } = require("./ai/Config.PlayerBots");

const BOT_BEHAVIOR_MODE = Object.freeze({
  ROAMING: "roaming",
  WOODCUTTING: "woodcutting",
  MINING: "mining",
  BANK_RUN: "bank_run",
  PVP: "pvp",
});
function parseEnvInt(name, fallback, min = 0) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.floor(value));
}

const BOT_EAT_OPTIONS = Object.freeze({
  botEatLowHpRatio: 0.45,
});

const BOT_CONFIG = Object.freeze({
  behaviorMode: BOT_BEHAVIOR_MODE,
  botCount: 0,
  // PvP bot pool and spread live in bot-sites.json ("pvp"); hotspots are its PvP sites.
  // Active-region snapshots are radius=1 (3x3 around each player region); the inset
  // targets only the true active core for regional wilderness bots.
  wildernessRoamerBotCount: PVP_BOT_SETTINGS.botPool,
  wildernessActiveRegionBotsPerRegion: PVP_BOT_SETTINGS.activeRegionBotsPerRegion,
  wildernessActiveRegionBotsByRegion: PVP_BOT_SETTINGS.activeRegionBotsByRegion,
  wildernessActiveRegionInset: PVP_BOT_SETTINGS.activeRegionInset,
  botWalkRadius: 10,
  objectIndexCachePath: path.join(__dirname, "data", "object-index.json"),
  // Run the scheduler every game tick; near-player throttling is handled by
  // LOD/budget logic so PvP bots do not move in visible waves.
  botDecisionTicks: 1,
  botBaseCooldownMs: 1200,
  ditchAttemptCooldownMs: 1200,
  roamingDitchCrossMaxDistanceY: 12,
  ditchPostCrossRetryDelayMs: 0,
  npcAggroBlockedModes: [
    BOT_BEHAVIOR_MODE.WOODCUTTING,
    BOT_BEHAVIOR_MODE.MINING,
    BOT_BEHAVIOR_MODE.BANK_RUN,
  ],
  taskProfiler: Object.freeze({
    // Hot-path profiler is useful for diagnostics but expensive at scale.
    // Keep disabled by default and enable explicitly when needed.
    enabled: (process.env.BOT_TASK_PROFILER_ENABLED ?? "0") === "1",
    intervalMs: parseEnvInt("BOT_TASK_PROFILER_INTERVAL_MS", 10000, 1000),
    sampleStride: parseEnvInt("BOT_TASK_PROFILER_SAMPLE_STRIDE", 4, 1),
  }),
  tickMetrics: Object.freeze({
    // Per-bot tick and per-cycle percentiles plus heap movement, logged per
    // window. Opt-in because sampling every entry is not free.
    enabled: (process.env.BOT_TICK_METRICS_ENABLED ?? "0") === "1",
    windowMs: parseEnvInt("BOT_TICK_METRICS_WINDOW_MS", 30000, 5000),
    maxSamples: parseEnvInt("BOT_TICK_METRICS_MAX_SAMPLES", 200000, 1000),
  }),
  executionBudget: Object.freeze({
    enabled: (process.env.BOT_EXECUTION_BUDGET_ENABLED ?? "1") === "1",
    maxMs: parseEnvInt("BOT_EXECUTION_BUDGET_MS", 60, 5),
    minEntriesPerCycle: parseEnvInt("BOT_EXECUTION_MIN_ENTRIES_PER_CYCLE", 24, 1),
    logCooldownMs: parseEnvInt("BOT_EXECUTION_BUDGET_LOG_COOLDOWN_MS", 5000, 1000),
  }),
  timingDesyncMs: parseEnvInt("BOT_TIMING_DESYNC_MS", 900, 0),
  botSpawnRadius: 14,
  botSpawnMinDistance: 2,
  botSpawnMaxAttempts: 80,
  playerAttackFleeChance: 0.5,
  // Throttle brain ticks for calm/idle bots:
  // 1 = every bot every cycle, 2 = every second cycle, 3 = every third, etc.
  // Combat/traversal/transient bots still run every cycle.
  idleEntryStride: 4,
  // Bot LOD simulation:
  // Near real players, bots tick every cycle for responsiveness.
  // Further away, brain ticks are downsampled.
  lodConfig: Object.freeze({
    enabled: true,
    refreshIntervalMs: 1400,
    nearDistanceTiles: 12,
    mediumDistanceTiles: 48,
    chunkSizeTiles: 32,
    nearStride: 1,
    // Far bots every 4 cycles (2.4s): slower left them standing ~10s between
    // decisions and walk legs; a profile showed bots under 10% of server CPU.
    mediumStride: 2,
    farStride: 4,
  }),
  wildernessDitchObjectId: ObjectIds.WILDERNESS_DITCH,
  logging: Object.freeze({
    logPath: path.join(process.cwd(), "logs", "player-bots.log"),
    runtimeEventLoggingEnabled:
      (process.env.BOT_RUNTIME_EVENT_LOGGING ?? "0") === "1",
    // Mirroring high-frequency bot runtime logs into the core server logger is
    // expensive because server.log uses synchronous disk writes.
    mirrorToServerLogger: (process.env.BOT_MIRROR_CORE_LOGGING ?? "0") === "1",
    mirrorErrorsToServerLogger:
      (process.env.BOT_MIRROR_ERRORS_TO_CORE_LOGGING ?? "1") === "1",
    fileLogWritesEnabled:
      (process.env.BOT_FILE_LOG_WRITES_ENABLED ??
        (GameConstants.SERVER_LOG_WRITES_ENABLED ? "1" : "0")) === "1",
    telemetryEnabled:
      (process.env.BOT_RUNTIME_TELEMETRY_ENABLED ?? "1") === "1",
    telemetryLogPath: path.join(process.cwd(), "logs", "bot-runtime-telemetry.log"),
    telemetryIntervalMs: parseEnvInt(
      "BOT_RUNTIME_TELEMETRY_INTERVAL_MS",
      10000,
      1000
    ),
    recentLogLimit: 24,
  }),
  status: Object.freeze({
    interactionSlot: 1,
    optionLabel: "Status",
    recentLogLines: 8,
    diagnoseLogPath: path.join(process.cwd(), "logs", "diagnose-stuck-bot.log"),
  }),
  eatOptions: BOT_EAT_OPTIONS,
  pvp: Object.freeze({
    pjOpportunityWindowMs: 6000,
    pjObserveDistanceTiles: 18,
    pjUseChanceByProfile: Object.freeze({
      novice: 0.42,
      standard: 0.66,
      veteran: 0.88,
      elite: 1,
    }),
    pjMaxResponders: 3,
    profileWeights: Object.freeze([
      Object.freeze({ value: "novice", weight: 18 }),
      Object.freeze({ value: "standard", weight: 48 }),
      Object.freeze({ value: "veteran", weight: 24 }),
      Object.freeze({ value: "elite", weight: 10 }),
    ]),
    loadoutWeights: Object.freeze([
      Object.freeze({ value: "edge_main_melee", weight: 28 }),
      Object.freeze({ value: "edge_ranged_melee", weight: 20 }),
      Object.freeze({ value: "low_level_pure", weight: 42 }),
      Object.freeze({ value: "rune_pure_members", weight: 9 }),
      Object.freeze({ value: "void_pure", weight: 8 }),
      Object.freeze({ value: "edge_void_melee", weight: 10 }),
      Object.freeze({ value: "mid_tank", weight: 8 }),
      Object.freeze({ value: "deep_wild_hybrid", weight: 15 }),
      Object.freeze({ value: "low_level_nh", weight: 7 }),
      Object.freeze({ value: "deep_wild_staff_spec", weight: 7 }),
      Object.freeze({ value: "anti_pk_hybrid", weight: 12 }),
      Object.freeze({ value: "budget_pk", weight: 17 }),
      Object.freeze({ value: "initiate_pure", weight: 10 }),
      Object.freeze({ value: "f2p_strength_pure", weight: 8 }),
      Object.freeze({ value: "f2p_rune_pure", weight: 10 }),
      Object.freeze({ value: "f2p_range_ko", weight: 7 }),
      Object.freeze({ value: "f2p_bind_pure", weight: 3 }),
      Object.freeze({ value: "f2p_addy_pure", weight: 7 }),
      Object.freeze({ value: "f2p_mage_pure", weight: 3 }),
      Object.freeze({ value: "f2p_bind_ko", weight: 4 }),
      Object.freeze({ value: "rusher", weight: 32 }),
    ]),
    hotspotWeights: Object.freeze([
      Object.freeze({ value: "edge_ditch", weight: 34 }),
      Object.freeze({ value: "varrock_ditch", weight: 16 }),
      Object.freeze({ value: "revs_entrance", weight: 12 }),
      Object.freeze({ value: "green_drags_gate", weight: 10 }),
    ]),
  }),
});

/** Scripted bots accept every duel; AI bots aren't scripted, so they are left out. */
function isScriptedBot(player) {
  return player?.isPlayerBot?.() === true && player.getAttribute?.(AI_BOT_ATTRIBUTE) !== true;
}

function registerDuelBotAcceptance(api) {
  const accept = (event) => {
    if (isScriptedBot(event?.player)) event.accept = true;
  };
  for (const eventName of ["duelarena:request", "duelarena:rules-changed", "duelarena:accept", "duelarena:accept-clicked"]) {
    api.onCustomEvent(eventName, accept);
  }
  api.onCustomEvent("duelarena:validate-winnings", (event) => {
    if (isScriptedBot(event?.player)) event.handled = true;
  });
  api.onCustomEvent("duelarena:settle-winnings", (event) => {
    if (isScriptedBot(event?.player)) event.handled = true;
  });
}

/**
 * Ours: the levelling bots' minds (brain/Ambition) and what hangs off them: potions for their
 * fights, what they say, and the groups they form. Each asks the world for the others, so a
 * world may turn any of them off.
 */
function startAmbition(api, boot) {
  const world = boot.brainWorld;
  const ambition = (world.ambition = createAmbition({ world }));
  if (api.getPluginConfig("PlayerBots:potions", true) !== false) createBotPotions({ world, ambition });
  // Its own setting is asked at every line, so the world config page turns chat off at once.
  const talk = (world.talk = createBotTalk({ world }));
  ambition.addTicker(talk.tick);
  api.onPlayerLevelUp(talk.levelUp);
  const groups = worldBotsGroup() ? (world.groups = createBotGroups({ world, runtime: boot.runtime, registry: boot.brainRegistry, ambition, talk })) : null;
  if (groups) ambition.addTicker(groups.tick);
  // One outing has a way of its own: the Wintertodt, across the sea. A world may turn it off;
  // the way home stays, so a bot that was over there when the setting changed is not left there.
  world.wintertodt = createBotWintertodt({
    world, groups, registry: boot.brainRegistry, ambition,
    emit: (name, payload) => api.emitCustomEvent(name, payload), spawnNpc: (spawn) => api.spawnNpc(spawn),
    goes: !!groups && api.getPluginConfig("PlayerBots:wintertodt", true) !== false,
  });
}

module.exports = {
  name: "PlayerBots",
  description: "Populates the world with player bots: PvP-loadout fighters and optional AI chat bots, with admin commands to manage them.",
  config: {
    "PlayerBots:earnOwnItems": {
      type: "boolean", label: "Levelling bots own what they use", default: true,
      help: "The bots of a progression site start with a new player's starter items and are handed nothing after that: tools, bait, arrows, runes, food and armour are what they carry, bank, buy in shops with coins they earned, or pick up. Off: they are given a tool, gear and food for their level, as other bots are.",
    },
    "PlayerBots:ambition": {
      type: "boolean", label: "Levelling bots set themselves goals", default: true,
      help: "The bots of a progression site that own what they use keep wanting the next better thing: a better tool, weapon and armour, bait, food and potions for their fights, and the next level that unlocks something. They turn more often to the work that gets them there, sell what they gather while they save, and go and buy what they can pay for at a shop or on the Grand Exchange. Off: they only look for a better tool or weapon when their work happens to.",
    },
    "PlayerBots:potions": {
      type: "boolean", label: "Levelling bots drink potions", default: true,
      help: "With goals on, a levelling bot that can well afford them buys potions for its combat style (and an antipoison once it has been poisoned), takes one of each to a fight and drinks a dose when the boost has worn off. A boost leaves these bots a point a minute, as it leaves a player. Off: they fight without potions.",
    },
    "PlayerBots:chat": {
      type: "boolean", label: "Levelling bots talk", default: true,
      help: "With goals on, a levelling bot now and then says a short line in public chat about what it is doing (what it is saving for, a level gained, something it bought) and may answer the bot beside it. A bot says at most one line of its own every few minutes, a player hears at most one such line every 20 seconds however many bots are around, and nothing is said with no player in earshot. Off: they say nothing, and form their groups in silence.",
    },
    "PlayerBots:chatSeconds": {
      type: "number", label: "Seconds between bot lines a player hears", default: 20, integer: true, min: 5, max: 3600,
      help: "A player hears at most one line from the levelling bots in this many seconds, however many bots stand around them; a group's proposal waits half as long again, and the couple of answers to a proposal that was said follow it. Beside a crowd of bots this is how often a line comes: 20 is three lines a minute, 60 is one. Raise it for quieter bots.",
    },
    "PlayerBots:groups": {
      type: "boolean", label: "Levelling bots form groups", default: true,
      help: "With goals on, a levelling bot now and then proposes something to do together (the outings in bot-groups.json, and Wintertodt for those with the Firemaking for it); bots near it, and bots further off that are after the same skill, may agree, and they travel there and do it side by side with their own tools and supplies. Off: every bot keeps to itself.",
    },
    "PlayerBots:wintertodt": {
      type: "boolean", label: "Levelling bots go to the Wintertodt", default: true,
      help: "With groups on, bots with 50 Firemaking, an axe and cooked food of their own may propose a trip to the Wintertodt: each packs at its bank, takes Veos's ship from Port Sarim, walks to the camp, and plays by the minigame's rules. Behind the doors each keeps a corner's brazier burning (chops roots and feeds them, lights it, mends it with a hammer from the crate), heals its pyromancer with a rejuvenation potion that Brew'ma mixes for it, and eats its food or drinks the potion against the cold. After a round or two it takes what it earned from the reward cart and comes home the same way. At most 40 bots of a world are on the trip at once. Brew'ma is put at her place by the crates when the first bot makes its potion, if she is not there already. Off: the Wintertodt outing is never proposed, and Firemaking is not a level bots go after; a bot that is over there when it is turned off still comes home.",
    },
    "PlayerBots:groupMinutes": {
      type: "json", label: "Minutes between a bot's group proposals", defaultText: "[30, 90]",
      help: "How often one levelling bot proposes a group outing, as [least, most] minutes; each bot draws its own time in between, e.g. [30, 90].",
    },
    "PlayerBots:allowedActivities": {
      type: "json", label: "Bot activities allowed", defaultText: "Every activity",
      help: "A list of the activities bots may be spawned for; any other spawn is refused, e.g. [\"bounty-hunter\", \"last-man-standing\"]. Activities: world (the world's own population: Wilderness roamers and the bot sites), ai, bounty-hunter, last-man-standing, castle-wars, soul-wars, pest-control, developer (bot commands, the benchmark, --stressTest).",
    },
    "PlayerBots:ai": {
      type: "json", label: "AI bots", defaultText: "AI bots off (3 bots when enabled)",
      help: "Settings for bots that chat through an AI model, merged over the shipped defaults, e.g. { \"enabled\": true, \"count\": 3, \"places\": [\"lumbridge\"] }. Also takes names, disclose, providers and gifts; API keys come from the server environment, never here.",
    },
    "PlayerBots:sites": {
      type: "json", label: "Bot site overrides", defaultText: "No overrides: the shipped bot-sites.json applies",
      help: "Maps a bot site id to the properties to change for it, e.g. { \"some_site\": { \"enabled\": false } }. Sites not named keep their shipped properties; a world.local.json value replaces the world.json one as a whole.",
    },
    "PlayerBots:activeRegionBotsByRegion": {
      type: "json", label: "Wilderness bots per map square", defaultText: "Shipped value in bot-sites.json",
      help: "Target number of bots in individual 64x64 map squares, keyed plane:regionX:regionY with whole-number counts. Replaces pvp.activeRegionBotsByRegion in bot-sites.json.",
    },
  },
  register(api) {
    registerPvpChatter(api);
    initPvpTierLoadouts(api);
    registerDuelBotAcceptance(api);
    initPlayerBotStateCoreAccess(api);
    const { botApi, recentBotLogsByUsername } = createBotPluginLogging({
      api,
      logPath: BOT_CONFIG.logging.logPath,
      runtimeEventLoggingEnabled: BOT_CONFIG.logging.runtimeEventLoggingEnabled,
      mirrorToServerLogger: BOT_CONFIG.logging.mirrorToServerLogger,
      mirrorErrorsToServerLogger: BOT_CONFIG.logging.mirrorErrorsToServerLogger,
      fileLogWritesEnabled: BOT_CONFIG.logging.fileLogWritesEnabled,
      telemetryEnabled: BOT_CONFIG.logging.telemetryEnabled,
      telemetryLogPath: BOT_CONFIG.logging.telemetryLogPath,
      telemetryIntervalMs: BOT_CONFIG.logging.telemetryIntervalMs,
      recentLogLimit: BOT_CONFIG.logging.recentLogLimit,
    });

    const boot = bootPlayerBotsRuntime({
      api,
      botApi,
      recentBotLogsByUsername,
      config: BOT_CONFIG,
    });
    setActiveBotRuntime(boot.runtime, BOT_CONFIG.behaviorMode, boot.brainRegistry);
    // Ours: the levelling bots trade on the Grand Exchange, and players' offers meet theirs first.
    attachBotExchange(api);
    // Ours: and each has a mind of its own about what to get next (the brain asks the world for it).
    if (worldHasAmbition()) startAmbition(api, boot);

    createBotBenchmark({
      api,
      botApi,
      runtime: boot.runtime,
      tickMetrics: boot.tickMetrics,
      resetMovementState,
      brainRegistry: boot.brainRegistry,
      brainWorld: boot.brainWorld,
    });

    startBotSites({
      api,
      botApi,
      runtime: boot.runtime,
      registry: boot.brainRegistry,
      world: boot.brainWorld,
      resetMovementState,
    });

    registerBotStatusInteractions({
      api,
      botStatusReporter: boot.botStatusReporter,
      statusOptionLabel: BOT_CONFIG.status.optionLabel,
      statusInteractionSlot: BOT_CONFIG.status.interactionSlot,
      runtime: boot.runtime,
      behaviorMode: BOT_CONFIG.behaviorMode,
    });

    registerBotCommands({
      api,
      botApi,
      runtime: boot.runtime,
      behaviorMode: BOT_CONFIG.behaviorMode,
      resetMovementState,
      taskManager: api.getTaskManager(),
      flashHintArrowTaskFactory: boot.flashHintArrowTaskFactory,
      brainRegistry: boot.brainRegistry,
    });

    const aiRuntime = registerAiBots({
      api,
      botApi,
      runtime: boot.runtime,
      registry: boot.brainRegistry,
      world: boot.brainWorld,
      resetMovementState,
    });
    boot.brainRegistry.aiAgentAvailable = typeof aiRuntime?.getAiGraphAgent === "function";

    registerBotEvents({
      api,
      botApi,
      runtime: boot.runtime,
      behaviorMode: BOT_CONFIG.behaviorMode,
      playerPersistence: GameConstants.PLAYER_PERSISTENCE,
      npcAggroBlockedModes: BOT_CONFIG.npcAggroBlockedModes,
      playerAttackFleeChance: BOT_CONFIG.playerAttackFleeChance,
      avengeOpponentPolicy: boot.avengeOpponentPolicy,
      pvpJumpOnKillPolicy: boot.pvpJumpOnKillPolicy,
    });

    api.onSpellRuneBypass((event) => {
      const player = event?.player;
      if (player?.isPlayerBot?.() === true) {
        event.bypass = true;
      }
    });

    botApi.log("registered", {
      spawned: boot.runtime.getSpawnedCount(),
      totalConfigured: BOT_CONFIG.botCount,
      wildernessRegionalPool: BOT_CONFIG.wildernessRoamerBotCount,
      wildernessActiveRegionBotsPerRegion: BOT_CONFIG.wildernessActiveRegionBotsPerRegion,
      wildernessRoamerBotCount: BOT_CONFIG.wildernessRoamerBotCount,
      walkRadius: BOT_CONFIG.botWalkRadius,
      decisionTicks: BOT_CONFIG.botDecisionTicks,
      baseCooldownMs: BOT_CONFIG.botBaseCooldownMs,
      ditchObjectId: BOT_CONFIG.wildernessDitchObjectId,
      roamingDitchCrossMaxDistanceY: BOT_CONFIG.roamingDitchCrossMaxDistanceY,
      roamRadius: BOT_CONFIG.botWalkRadius,
    });
  },
  registerDuelBotAcceptance,
};
