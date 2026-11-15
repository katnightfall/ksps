/**
 * /api/item-examines: the examine texts our world has changed (the `examine` fields of
 * data/definitions/item-overrides.json), by item id.
 *
 * The server answers an examine in the bank, a shop or on the ground from its own item
 * definitions, which ItemDefinitionLoader already overrides. An item in the backpack or worn is
 * examined by the web client alone, from the game cache, so it needs our texts too: it loads
 * this table at login (client/network/serverConnection/domain/itemExamines.ts).
 */
const fs = require("node:fs");
const path = require("node:path");

/** The longest examine ItemDefinitionLoader accepts for an override. */
const MAX_EXAMINE_LENGTH = 200;
let examines;

function readExamines() {
  const table = {};
  try {
    const overrides = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data", "definitions", "item-overrides.json"), "utf8"));
    for (const [id, fields] of Object.entries(overrides ?? {})) {
      const examine = fields?.examine;
      if (/^\d+$/.test(id) && typeof examine === "string" && examine.length > 0 && examine.length <= MAX_EXAMINE_LENGTH) table[id] = examine;
    }
  } catch (error) {
    // No overrides file is the usual case for a world that changes nothing.
    if (error.code !== "ENOENT") console.warn("[item-examines] item-overrides.json could not be read", error.message);
  }
  return table;
}

/** The overrides are read at start-up like the definitions themselves, so one read serves every request. */
function itemExamines(_query, segments) {
  if (segments.length) return undefined;
  return (examines ??= readExamines());
}

module.exports = {
  name: "ItemExamines",
  description: "Serves the examine texts our world changed (item-overrides.json) to the client, which examines backpack and worn items by itself.",
  register(api) {
    api.registerContentEndpoint("item-examines", itemExamines);
  },
  _test: { itemExamines, readExamines },
};
