// Fixture for tests/plugin-references.test.cjs (scripts/scan-plain-tiles.cjs): never loaded as a plugin.
// Lines marked MISS call a method on a tile that arrives as a plain { x, y, z }; lines marked OK do not.
"use strict";
const Helper = require("./ZzTilesHelper");

function atGate(location) {
  return location.getX() === 3200 && location.getY() === 3200; // MISS, MISS
}

function safeAt(location) {
  const x = location.getX?.() ?? location.x; // OK
  const y = typeof location.getY === "function" ? location.getY() : location.y; // OK
  return x + y + (location.z ?? location.getZ()); // OK
}

module.exports = {
  name: "ZzTiles",
  register(api) {
    api.onObjectInteraction((event) => {
      if (atGate(event.location)) event.handled = true;
      const real = event.object.getLocation();
      real.getX(); // OK: the object's own Location
      const either = event.object?.getLocation?.() ?? event.location;
      either.getZ(); // OK: the object's Location wins whenever there is an object
      safeAt(event.location);
      api.emitCustomEvent("zz:toggle", { player: event.player, location: event.location });
    });
    api.onNpcInteraction("Hans", { "Talk-to": ({ location }) => location.getZ() }); // MISS
    api.onItemOnObject(Helper.useItem);
    api.onCustomEvent("zz:toggle", (request) => {
      const { location } = request;
      return location.getDistance(request.player.getLocation()); // MISS
    });
    api.onPlayerLocationChange((event) => event.location.getX()); // OK: this hook hands over a real Location
  },
};
