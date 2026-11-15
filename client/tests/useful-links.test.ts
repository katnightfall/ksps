import { strict as assert } from "node:assert";
import { USEFUL_LINKS, UsefulLinksPlugin } from "../game/plugins/usefullinks/UsefulLinksPlugin";

assert.equal(UsefulLinksPlugin.descriptor.hidden, true, "not a plugin players switch on or off");
assert.deepEqual(USEFUL_LINKS.map((link) => link.name), ["Kat-Net<br>Website", "Hiscores", "Old School<br>Wiki"]);
assert.equal(USEFUL_LINKS[0].url(), "https://kat-net.us");

// The Account tab's eight link buttons as the cache script leaves them: components 87-94 of
// interface 109, each with sprites and one text child.
const ACCOUNT = 109;
const names = ["Old School Website", "Customer Support", "Grand<br>Exchange", "Change Name", "Old School Wiki", "Merchandise", "Account Deletion", "Hiscores"];
const buttons = new Map<number, any>(names.map((name, index) => {
    const uid = (ACCOUNT << 16) | (87 + index);
    return [uid, { uid, type: 0, hidden: false, isHidden: false, opBase: `<col=ff9040>${name}</col>`, children: [{ type: 5 }, null, { type: 4, text: name }] }];
}));
const invalidated: number[] = [];
const widgets = {
    getWidgetByUid: (uid: number) => buttons.get(uid),
    invalidateWidgetRender: (widget: any) => { if (widget.uid) invalidated.push(widget.uid); },
    invalidateWidget: (widget: any) => { invalidated.push(widget.uid); },
};
const opened: string[] = [];
const links = [
    { name: "Kat-Net<br>Website", url: () => "https://kat-net.us" },
    { name: "Hiscores", url: () => "http://game.example/hiscores" },
];
const plugin = new UsefulLinksPlugin(() => widgets as any, (url) => opened.push(url), links);
const button = (index: number) => buttons.get((ACCOUNT << 16) | (87 + index));
const click = (uid: number) => plugin.handleWidgetAction({ widget: { uid }, option: "Open" });

(async () => {
    // Not started: nothing is touched.
    plugin.onScriptFinished(2833);
    assert.equal(button(0).children[2].text, "Old School Website");
    assert.equal(click(button(0).uid), false);

    await plugin.start();
    plugin.onScriptFinished(100);
    assert.equal(button(0).children[2].text, "Old School Website", "only the list's own build script");

    // After the cache script builds the list: our links on the first buttons, the others hidden.
    plugin.onScriptFinished(2833);
    assert.deepEqual([0, 1].map((i) => button(i).children[2].text), ["Kat-Net<br>Website", "Hiscores"]);
    assert.deepEqual([0, 1].map((i) => button(i).opBase), ["<col=ff9040>Kat-Net Website</col>", "<col=ff9040>Hiscores</col>"], "the right-click menu's name, on one line");
    assert.deepEqual(names.map((_, i) => button(i).hidden), [false, false, true, true, true, true, true, true]);
    assert.deepEqual(names.map((_, i) => button(i).isHidden), [false, false, true, true, true, true, true, true]);
    assert.equal(button(4).children[2].text, "Old School Wiki", "a hidden button keeps what it had");

    // The script runs again when the tab is rebuilt (it shows and relabels everything): ours are put back.
    names.forEach((name, i) => Object.assign(button(i), { hidden: false, isHidden: false, children: [{ type: 5 }, { type: 4, text: name }] }));
    plugin.onScriptFinished(2833);
    assert.equal(button(1).children[1].text, "Hiscores");
    assert.equal(button(7).hidden, true);

    // A click opens the link here and is kept from the server; a hidden button's click is swallowed too.
    assert.equal(click(button(0).uid), true);
    assert.equal(click(button(1).uid), true);
    assert.deepEqual(opened, ["https://kat-net.us", "http://game.example/hiscores"]);
    assert.equal(click(button(5).uid), true);
    assert.equal(opened.length, 2);
    // Other components of the tab (Name Changer is 109:51) and other interfaces are left alone.
    assert.equal(click((ACCOUNT << 16) | 51), false);
    assert.equal(click((110 << 16) | 87), false);
    assert.equal(plugin.handleWidgetAction({}), false);

    // A list as long as the buttons hides none; a missing interface is no error.
    const full = new UsefulLinksPlugin(() => widgets as any, () => {}, names.map((name) => ({ name, url: () => "https://kat-net.us" })));
    await full.start();
    full.apply();
    assert.ok(names.every((_, i) => button(i).hidden === false));
    const none = new UsefulLinksPlugin(() => undefined, () => {}, links);
    await none.start();
    none.apply();

    console.log("useful links tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
