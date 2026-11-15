/**
 * Our world's credit line in the chatbox, straight under the login greeting ("Welcome to ...").
 * It answers "welcome-screen:greeted", which WelcomeScreen.plugin.js sends right after the
 * greeting; this file loads before LoginTips, so the line comes before the "Did you know?" tip.
 * The welcome screen's scroll carries the same line through "WelcomeScreen:messageOfTheWeek"
 * in data/definitions/world.json.
 */
const CREDIT_LINE = "Edited and hosted for free by kat-net.us";

function sendCredit({ player }) {
  if (!player || player.isPlayerBot?.() === true) return;
  player.sendMessage(CREDIT_LINE);
}

module.exports = {
  name: "HostCredit",
  description: "Adds our world's credit line to the chatbox under the login greeting.",
  CREDIT_LINE,
  register(api) {
    api.onCustomEvent("welcome-screen:greeted", sendCredit);
  },
};
