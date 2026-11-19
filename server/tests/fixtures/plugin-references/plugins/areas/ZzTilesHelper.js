// Fixture for tests/plugin-references.test.cjs: a handler in a required module.
"use strict";
module.exports = {
  useItem(event) {
    return event.location.getY(); // MISS
  },
};
