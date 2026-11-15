import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { openClientUrl } from "../../../common/openUrl";
import { markWidgetInteractionDirty } from "../../../widgets/WidgetInteraction";
import type { WidgetNode } from "../../../widgets/WidgetNode";
import type { OsrsClient } from "../../OsrsClient";
import type { WidgetActionEvent } from "../../widgets/widgetActionPayload";

/**
 * The Account tab's "Useful Links", made ours. The cache fills that list with eight links to the
 * official game's own site (its website, support, shop, account deletion...), and their buttons
 * only tell the server they were pressed, which here does nothing. This puts our links on the
 * first buttons, hides the rest, and opens a link in the browser when its button is clicked.
 *
 * To change the list, edit USEFUL_LINKS: at most eight, shown in this order.
 */
export type UsefulLink = { name: string; url: () => string };

export const USEFUL_LINKS: readonly UsefulLink[] = [
    { name: "Kat-Net<br>Website", url: () => "https://kat-net.us" },
    // Our own hiscores page, on the site this client was loaded from.
    { name: "Hiscores", url: () => new URL("/hiscores", window.location.href).toString() },
    { name: "Old School<br>Wiki", url: () => "https://oldschool.runescape.wiki" },
];

/** The Account tab (interface 109). */
const ACCOUNT_GROUP = 109;
/** Its eight link buttons, components 87 to 94 (the cache's enum 2321 lists them in order). */
const FIRST_LINK_BUTTON = 87;
const LINK_BUTTONS = 8;
/** The cache script that builds the list from enum 2320; it runs again whenever the tab is rebuilt. */
const USEFUL_LINKS_BUILD_SCRIPT = 2833;
/** A text component. */
const TYPE_TEXT = 4;

const buttonUid = (index: number) => (ACCOUNT_GROUP << 16) | (FIRST_LINK_BUTTON + index);
/** A button's label without the game's markup: "Kat-Net Website". */
const plainName = (link: UsefulLink) => link.name.replace(/<br>/g, " ");

type Widgets = {
    getWidgetByUid(uid: number): WidgetNode | null | undefined;
    invalidateWidgetRender(widget: WidgetNode): void;
    invalidateWidget(widget: WidgetNode, source?: string): void;
};

export class UsefulLinksPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Useful Links",
        description: "Our own links in the Account tab's Useful Links",
        // Part of how our world's client works, not a choice: it is not listed with the plugins.
        hidden: true,
        configKey: "usefullinksplugin",
    };

    constructor(
        private readonly widgets?: () => Widgets | undefined,
        private readonly open: (url: string) => void = (url) => { openClientUrl(url); },
        private readonly links: readonly UsefulLink[] = USEFUL_LINKS,
    ) {
        super();
        if (!this.widgets) {
            const client = inject<OsrsClient>(CLIENT_TOKEN);
            this.widgets = () => client.widgetManager as unknown as Widgets | undefined;
        }
    }

    onScriptFinished(scriptId: number): void {
        if (scriptId === USEFUL_LINKS_BUILD_SCRIPT && this.isStarted()) this.apply();
    }

    /** Relabels the first buttons with our links and hides the others. */
    apply(): void {
        const widgets = this.widgets?.();
        if (!widgets) return;
        for (let index = 0; index < LINK_BUTTONS; index++) {
            const button = widgets.getWidgetByUid(buttonUid(index));
            if (!button) continue;
            const link = this.links[index];
            const hidden = link === undefined;
            if (link) {
                // The script made the label as a child of the button (cc_create); the rest are its sprites.
                for (const child of button.children ?? []) {
                    if (child && child.type === TYPE_TEXT && child.text !== link.name) {
                        child.text = link.name;
                        widgets.invalidateWidgetRender(child);
                    }
                }
                // What the right-click menu reads: "Open <name>".
                button.opBase = `<col=ff9040>${plainName(link)}</col>`;
                markWidgetInteractionDirty(button);
            }
            if (button.hidden !== hidden || button.isHidden !== hidden) {
                button.hidden = hidden;
                button.isHidden = hidden;
                if (hidden) widgets.invalidateWidgetRender(button);
                else widgets.invalidateWidget(button, "useful-links");
            }
        }
    }

    /** A click on one of our buttons opens its link here; the server is not told. */
    handleWidgetAction(event: WidgetActionEvent): boolean {
        if (!this.isStarted()) return false;
        const uid = Number(event.widget?.uid);
        const index = (uid & 0xffff) - FIRST_LINK_BUTTON;
        if (uid >>> 16 !== ACCOUNT_GROUP || index < 0 || index >= LINK_BUTTONS) return false;
        const link = this.links[index];
        if (link) this.open(link.url());
        return true;
    }
}
