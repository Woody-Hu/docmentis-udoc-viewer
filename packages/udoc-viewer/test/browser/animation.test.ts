import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UDocClient } from "../../src/index.js";
import type { WorkerClient } from "../../src/worker/index.js";
import type { UDocViewer } from "../../src/index.js";
import {
    activeSlideAnimationStep,
    advanceActiveSlideAnimation,
    hasPendingSlideAnimation,
    knownToAnimate,
} from "../../src/ui/viewer/animation.js";
import animatedUrl from "../fixtures/animated.pptx?url";
import effectsUrl from "../fixtures/effects.pptx?url";

let container: HTMLDivElement;
let client: UDocClient | null = null;
let viewer: UDocViewer | null = null;

beforeEach(() => {
    container = document.createElement("div");
    container.style.width = "900px";
    container.style.height = "700px";
    document.body.appendChild(container);
});

afterEach(() => {
    viewer?.destroy();
    viewer = null;
    client?.destroy();
    client = null;
    container.remove();
});

/** Load the animated deck and wait for its first render to settle. */
async function openAnimatedDeck(page: number, enableAnimations = true, url = animatedUrl): Promise<void> {
    client = await UDocClient.create({ googleFonts: false, disableUpdateCheck: true });
    viewer = await client.createViewer({ container, enableAnimations });

    const loaded = new Promise<void>((resolve) => {
        viewer!.on("document:load", () => resolve());
    });
    await viewer.load(url);
    await loaded;

    if (page !== 1) viewer.goToPage(page);
    if (enableAnimations) await waitFor(() => layerCanvases().length > 0, "animation layers to mount");
}

function layerCanvases(): HTMLCanvasElement[] {
    return Array.from(container.querySelectorAll<HTMLCanvasElement>(".udoc-spread__animation-layer"));
}

/** Layers currently painted, i.e. not held back by an unplayed entrance. */
function visibleLayerCount(): number {
    return layerCanvases().filter((c) => c.style.opacity !== "0").length;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

/** Let queued WAAPI animations commit their final styles. */
async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 120));
}

describe("PPTX slide build sequences", () => {
    it("mounts a layer stack for an animated slide", async () => {
        // Slide 3 builds three bullets, then two shapes, over five clicks.
        await openAnimatedDeck(3);

        const layers = layerCanvases();
        expect(layers.length).toBeGreaterThan(1);
        // The plain page canvas steps aside while the build is on screen.
        const pageCanvas = container.querySelector<HTMLCanvasElement>(".udoc-spread__canvas");
        expect(pageCanvas?.style.visibility).toBe("hidden");
    });

    it("holds entrance targets back until their step plays", async () => {
        await openAnimatedDeck(3);
        await settle();

        const total = layerCanvases().length;
        const atStart = visibleLayerCount();
        expect(atStart).toBeLessThan(total);
        expect(hasPendingSlideAnimation()).toBe(true);
    });

    it("reveals more of the slide with each advance", async () => {
        await openAnimatedDeck(3);
        await settle();

        const counts: number[] = [visibleLayerCount()];
        let advances = 0;
        while (advanceActiveSlideAnimation()) {
            advances += 1;
            await settle();
            counts.push(visibleLayerCount());
        }

        // Slide 3 has five click steps.
        expect(advances).toBe(5);
        // Never fewer layers than before — a build only adds.
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
        // And it ends with strictly more on screen than it started.
        expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]);
        expect(hasPendingSlideAnimation()).toBe(false);
    });

    it("leaves slides without animations on the plain canvas", async () => {
        // Slide 2's timing holds only the root node, so nothing should mount.
        await openAnimatedDeck(3);
        viewer!.goToPage(2);
        await waitFor(() => layerCanvases().length === 0, "layers to be torn down");

        const pageCanvas = container.querySelector<HTMLCanvasElement>(".udoc-spread__canvas");
        expect(pageCanvas?.style.visibility).not.toBe("hidden");
    });
    it("never shows the finished slide before rewinding it to step 0", async () => {
        // The plain canvas must be hidden by the time any layer exists — if it
        // were still visible the viewer would flash the completed slide.
        await openAnimatedDeck(3);

        const pageCanvas = container.querySelector<HTMLCanvasElement>(".udoc-spread__canvas");
        expect(pageCanvas?.style.visibility).toBe("hidden");

        // And with the answer cached, arriving again hides it without waiting
        // on the worker at all.
        const docId = viewer!.documentId!;
        expect(knownToAnimate(docId, 2)).toBe(true);
    });

    it("advances the build when the slide is clicked", async () => {
        await openAnimatedDeck(3);
        await settle();

        expect(activeSlideAnimationStep()).toBe(0);
        const slot = container.querySelector<HTMLElement>(".udoc-spread__slot");
        slot!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
        await settle();

        expect(activeSlideAnimationStep()).toBe(1);
    });

    it("ignores clicks that land on an interactive layer", async () => {
        await openAnimatedDeck(3);
        await settle();

        const before = activeSlideAnimationStep();
        const annotations = container.querySelector<HTMLElement>(".udoc-spread__annotation-layer");
        annotations!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
        await settle();

        expect(activeSlideAnimationStep()).toBe(before);
    });

    it("stays off unless the beta flag is set", async () => {
        // Same deck, same slide, feature disabled: no layers, no hidden canvas,
        // and a click must not consume the advance.
        await openAnimatedDeck(3, false);
        await settle();

        expect(layerCanvases()).toHaveLength(0);
        expect(activeSlideAnimationStep()).toBeNull();

        const pageCanvas = container.querySelector<HTMLCanvasElement>(".udoc-spread__canvas");
        expect(pageCanvas?.style.visibility).not.toBe("hidden");

        const slot = container.querySelector<HTMLElement>(".udoc-spread__slot");
        slot!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
        await settle();
        expect(activeSlideAnimationStep()).toBeNull();
    });
});

describe("PPTX effect behaviors", () => {
    /**
     * Advance until the step carrying `filterName` is the one playing, then
     * report the styles mid-flight. Reading the step list from the worker keeps
     * the test honest about which slide does what.
     */
    async function playFilter(filterName: string, page: number): Promise<CSSStyleDeclaration[]> {
        await openAnimatedDeck(page, true, effectsUrl);
        await settle();

        const wc = (client as unknown as { workerClient: WorkerClient }).workerClient;
        const docId = (viewer as unknown as { documentId: string }).documentId;
        const animation = await wc.getSlideAnimation(docId, page - 1);

        const stepIndex = animation!.steps.findIndex((step) =>
            step.effects.some((e) => e.behavior?.type === "filter" && e.behavior.name === filterName),
        );
        expect(stepIndex, `no ${filterName} step on this slide`).toBeGreaterThanOrEqual(0);

        for (let i = 0; i <= stepIndex; i++) {
            advanceActiveSlideAnimation();
            if (i < stepIndex) await settle();
        }
        // Effects run 600ms, so sample while still in flight.
        await new Promise((r) => setTimeout(r, 150));
        return layerCanvases().map((c) => getComputedStyle(c));
    }

    it("plays a zoom as a scale, not a fade", async () => {
        // effects.pptx is one effect per slide; slide 4 is Zoom In.
        const styles = await playFilter("zoom", 4);
        const scaling = styles.some((s) => s.transform !== "none" && s.transform !== "");
        expect(scaling).toBe(true);
    });

    it("plays a wipe as a clip, not a fade", async () => {
        // Slide 6 is Wipe Up.
        const styles = await playFilter("wipe", 6);
        const clipping = styles.some((s) => s.clipPath !== "none" && s.clipPath !== "");
        expect(clipping).toBe(true);
    });

    it("keeps a different document's cached timeline out of the way", async () => {
        // Document ids are recycled across clients, so a stale cache entry
        // would hand this deck the previous one's steps.
        await openAnimatedDeck(4, true, effectsUrl);
        const wc = (client as unknown as { workerClient: WorkerClient }).workerClient;
        const docId = (viewer as unknown as { documentId: string }).documentId;
        const animation = await wc.getSlideAnimation(docId, 3);
        // effects.pptx drives entrances with animEffect filters; animated.pptx
        // uses bare visibility sets. Seeing a filter proves we got this deck.
        expect(animation!.steps[0].effects[0].behavior?.type).toBe("filter");
    });
});
