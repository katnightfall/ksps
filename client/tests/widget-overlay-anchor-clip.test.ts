import assert from "node:assert/strict";

// Upstream issue #6213: Status Bars on "Fixed - Classic" were invisible, then blinked.
//
// Anchored widget overlays (Status Bars) are drawn from inside the widget tree, right after
// their side-panel anchor, so later widgets stay on top. The bars hang BESIDE the anchor
// (RuneLite's Viewport offsets: 20 px left of it and at its right edge), and the tree used to
// call the overlays with the GL scissor still set to the anchor's parent:
//   - Fixed - Classic: 548:80 (side panels) lies in 548:17, a container of exactly its size;
//   - Resizable - Modern: 164:70 (side background) lies in 164:96, which starts 1 px left of it.
// Both cut the bars away whole. They then showed only in passes that never reached the anchor
// (a partial pass whose dirty rect is beside the panel is repaired without that scissor) and
// vanished again on the next full pass, which every prayer toggle causes (the bar's colour is in
// its signature). Resizable - Classic was spared because 161:97 is wider than the panel.
//
// The production tree traversal runs here against a recording GL surface. Boxes are the ones
// cache osrs-242 gives the fixed layout at 765x503.

const noop = () => {};
const W = 765, H = 503;
type Rect = { x: number; y: number; w: number; h: number };

const canvas: any = { width: W, height: H, style: {}, addEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    __textureCache: { beginFrame: noop, endFrame: noop } };
(globalThis as any).window ??= { addEventListener: noop, devicePixelRatio: 1 };
(globalThis as any).document ??= { createElement: () => canvas, addEventListener: noop };

const ROOT = (548 << 16) | 0;
const SIDE_HOLDER = (548 << 16) | 17;
const SIDE_PANELS = (548 << 16) | 80;
const TAB = (548 << 16) | 81;
const TAB_CONTENT = (149 << 16) | 0;

const PANEL: Rect = { x: 547, y: 205, w: 190, h: 261 };
const LEFT_BAR: Rect = { x: PANEL.x - 20, y: PANEL.y + 4, w: 20, h: 252 };
const RIGHT_BAR: Rect = { x: PANEL.x + PANEL.w, y: PANEL.y + 4, w: 20, h: 252 };

const inside = (inner: Rect, outer: Rect) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

async function main() {
    const { renderWidgetTreeGL } = await import("../widgets/gl/widgetsGl/renderWidgetTree");

    const layer = (uid: number, parentUid: number, x: number, y: number, width: number, height: number): any =>
        ({ uid, id: uid, type: 0, isIf3: true, parentUid, x, y, width, height });
    const widgets: any[] = [
        layer(ROOT, -1, 0, 0, W, H),
        layer(SIDE_HOLDER, ROOT, PANEL.x, PANEL.y, PANEL.w, PANEL.h),
        layer(SIDE_PANELS, SIDE_HOLDER, 0, 0, PANEL.w, PANEL.h),
        layer(TAB, SIDE_PANELS, 0, 0, PANEL.w, PANEL.h),
        // Something the tab draws: a filled rectangle wider than the panel, so its scissor shows.
        { uid: TAB_CONTENT, id: TAB_CONTENT, type: 3, isIf3: true, parentUid: TAB, x: -40, y: 0, width: 300, height: 50, filled: true, fill: true, color: 0x123456 },
    ];
    const byUid = new Map(widgets.map((w) => [w.uid, w]));
    const wm: any = new Proxy({
        getWidgetByUid: (uid: number) => byUid.get(uid),
        getWidgetFlags: () => 0, getWidgetFlagsVersion: () => 0,
        getStaticChildrenByParentUid: (uid: number) => widgets.filter((w) => w.parentUid === uid),
        getDynamicChildrenByParent: () => [], interfaceParents: new Map(), groups: new Map(),
    }, { get: (obj, key) => (obj as any)[key] ?? noop });

    /** One pass of the real tree. Returns the scissor the overlays drew under, and the one the tab's content drew under. */
    function pass(rootClip?: { x0: number; y0: number; x1: number; y1: number }) {
        let scissor: Rect | undefined;
        // A batching renderer as the real one: rectangles wait for flush() and land under the
        // scissor in force at that moment.
        let pending: string[] = [];
        const landed: { what: string; clip: Rect | undefined }[] = [];
        const gl: any = new Proxy({
            scissor: (x: number, y: number, w: number, h: number) => { scissor = { x, y: H - (y + h), w, h }; },
        }, { get: (obj, key) => (obj as any)[key] ?? noop });
        const glr: any = new Proxy({
            canvas, gl, width: W, height: H,
            drawRect: (_x: number, _y: number, _w: number, _h: number) => { pending.push(drawing); },
            flush: () => { for (const what of pending) landed.push({ what, clip: scissor && { ...scissor } }); pending = []; },
        }, { get: (obj, key) => (obj as any)[key] ?? noop });
        let drawing = "widget";
        let anchorCalls = 0;
        // Each pass starts from a fresh scissor stack, as a new canvas would.
        delete canvas.__scissorStack;
        renderWidgetTreeGL(glr, byUid.get(ROOT), {
            widgetManager: wm, spriteIndex: {} as any, fontLoader: () => undefined, visible: new Map(),
            debug: false, hostW: W, hostH: H, skipTooltip: true,
            ...(rootClip ? { rootClip } : {}),
            widgetOverlayAnchors: new Set([SIDE_PANELS]),
            // As WidgetsOverlay.drawWidgetOverlays: draw both bars, then flush.
            widgetOverlayAnchorDrawn: () => {
                anchorCalls++;
                drawing = "bars";
                glr.drawRect(LEFT_BAR.x, LEFT_BAR.y, LEFT_BAR.w, LEFT_BAR.h);
                glr.drawRect(RIGHT_BAR.x, RIGHT_BAR.y, RIGHT_BAR.w, RIGHT_BAR.h);
                glr.flush();
                drawing = "widget";
            },
        } as any);
        glr.flush();
        return {
            anchorCalls,
            bars: landed.filter((d) => d.what === "bars").map((d) => d.clip),
            widgets: landed.filter((d) => d.what === "widget").map((d) => d.clip),
        };
    }

    // A full pass: both bars land whole, although neither is inside the side panels' holder.
    const full = pass();
    assert.equal(full.anchorCalls, 1, "the tree reaches the side-panel anchor once in a full pass");
    assert.equal(full.bars.length, 2);
    for (const [name, bar] of [["left", LEFT_BAR], ["right", RIGHT_BAR]] as const) {
        assert.ok(
            full.bars.every((clip) => !!clip && inside(bar, clip)),
            `the ${name} bar is not cut away by the anchor's parent (drawn under ${JSON.stringify(full.bars[0])})`,
        );
    }
    // The tab's own content is still held to the side panel: the wider clip is the overlays' alone.
    assert.ok(full.widgets.length > 0, "the tab's content was drawn");
    assert.ok(
        full.widgets.every((clip) => !!clip && inside(clip, PANEL)),
        `widgets under the anchor keep the panel's clip (drawn under ${JSON.stringify(full.widgets)})`,
    );

    // A partial pass over the left bar and a strip of the panel: the bars are held to the dirty
    // rect (what is outside it is still on the canvas), not to the panel and not to the canvas.
    const dirty: Rect = { x: LEFT_BAR.x, y: LEFT_BAR.y, w: 40, h: 100 };
    const partial = pass({ x0: dirty.x, y0: dirty.y, x1: dirty.x + dirty.w, y1: dirty.y + dirty.h });
    assert.equal(partial.anchorCalls, 1, "a dirty rect over the panel's edge reaches the anchor");
    assert.deepEqual(partial.bars, [dirty, dirty], "the overlays are clipped to the pass's dirty rect");
    assert.ok(partial.widgets.every((clip) => !!clip && inside(clip, PANEL) && inside(clip, dirty)));

    // A dirty rect that only covers the right bar never gets to the anchor: its holder is outside
    // the rect. WidgetsOverlay.redrawDirtyRects repairs those rects itself (tested in
    // widget-overlay-before-menu-partial); this is what made the bars come and go before.
    const beside = pass({ x0: RIGHT_BAR.x, y0: RIGHT_BAR.y, x1: RIGHT_BAR.x + RIGHT_BAR.w, y1: RIGHT_BAR.y + RIGHT_BAR.h });
    assert.equal(beside.anchorCalls, 0);

    console.log("widget overlay anchor clip: bars beside the fixed side panel are drawn whole at the anchor");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
