/**
 * Fletching (docs/fletching.md): every recipe on the Wiki's Fletching page, from
 * data/fletching.json, with menus, messages and animations from rsprox captures.
 */

const Shared = require("./fletching/Shared.Fletching");

/** "fletching:shafts": the arrow shafts request.logId fletches into, how many and the XP, for content that fletches as it chops (a league relic); a log with no arrow-shaft recipe answers nothing. */
function answerShafts(request) {
  const shaft = Shared.getCore().ItemIdentifiers.ARROW_SHAFT;
  const recipe = Shared.getRecipes().find((candidate) => candidate.outputId === shaft
    && candidate.materials.some((material) => material.ids.includes(request.logId)));
  if (!recipe) return;
  request.itemId = recipe.outputId;
  request.amount = recipe.amount;
  request.xp = recipe.xp;
}

const UNITS = [
  Shared,
  require("./fletching/Recipes.Fletching"),
  require("./fletching/Spool.Fletching"),
  require("./fletching/Diaries.Fletching"),
];

module.exports = {
  answerShafts,
  name: "Fletching",
  description: "Fletching: every Wiki recipe for bows, arrows, bolts and more, with menus and animations, plus an arrow shaft event for other content.",
  members: true,
  config: {
    "Fletching:maxSets": {
      type: "number", label: "Most sets of arrows, bolts, darts and javelins from one choice", default: 0, integer: true, min: 0, max: 10000,
      help: "0 is OSRS: up to 10 sets. Above 0, that many sets can be made from one choice, as long as the materials last; above 28 the menu's All is every set that can be made, and a 100 button shows when more than 100 can.",
    },
  },
  register(api) {
    for (const unit of UNITS) unit.init?.(api);
    for (const unit of UNITS) unit.attach?.(api);
    api.onCustomEvent("fletching:shafts", answerShafts);
  },
};
