/**
 * Slide build sequences for PPTX animations.
 *
 * The WASM side rasterizes a slide into z-ordered layers — one per animated
 * shape, plus one per run of static content between them — and hands over a
 * timeline of click steps. This module stacks those layers as DOM elements and
 * plays the steps with the Web Animations API, so compositing stays on the GPU
 * and no re-render is needed per frame.
 *
 * Paragraph builds clip a text shape's single layer to the band occupied by
 * the revealed paragraphs, derived from the page's text layout. Paragraphs
 * never overlap, so clipping is exact.
 */

import type { AnimationEffect, AnimationLayer, LayoutPage, SlideAnimation, WorkerClient } from "../../worker/index.js";
import { resolveEasing, resolveMotion } from "./animation-presets.js";

/** A rendered layer mounted in the DOM. */
interface MountedLayer {
    /** Animated shape this layer belongs to, or undefined for static content. */
    shapeKey?: number;
    element: HTMLCanvasElement;
    /** Top edge of the layer within the page, as a fraction of page height. */
    topFraction: number;
    /** Height of the layer, as a fraction of page height. */
    heightFraction: number;
}

/** Vertical band of one paragraph, as fractions of the page height. */
interface ParagraphBand {
    top: number;
    bottom: number;
}

export interface SlideAnimationOptions {
    /** The build sequence to play. */
    animation: SlideAnimation;
    /** Rendered layers, back-to-front, as returned by `renderPageLayers`. */
    layers: AnimationLayer[];
    /** Device-pixel size the layers were rendered at. */
    renderWidth: number;
    renderHeight: number;
    /** Element the layer stack is mounted into; sized to the displayed page. */
    host: HTMLElement;
    /** Page text layout, used to locate paragraph bands. Optional. */
    layout?: LayoutPage;
}

/**
 * Plays one slide's build sequence over a stack of layer canvases.
 *
 * Step counting: `step` is the number of steps already played. At 0 nothing
 * has run, so entrance targets are hidden; at `stepCount` the build is
 * complete and the slide looks like a normal full-page render.
 */
export class SlideAnimationController {
    private readonly animation: SlideAnimation;
    private readonly host: HTMLElement;
    private readonly layers: MountedLayer[] = [];
    private readonly running = new Set<Animation>();

    /** Step at which each shape first enters, if it has an entrance effect. */
    private readonly entranceStep = new Map<number, number>();
    /** Step at which each shape first leaves, if it has an exit effect. */
    private readonly exitStep = new Map<number, number>();
    /** Paragraph bands per shape, for shapes built paragraph by paragraph. */
    private readonly paragraphBands = new Map<number, ParagraphBand[]>();
    /** Step at which each paragraph of a shape is revealed. */
    private readonly paragraphStep = new Map<string, number>();

    private currentStep = 0;

    constructor(options: SlideAnimationOptions) {
        this.animation = options.animation;
        this.host = options.host;

        this.indexEffects();
        this.indexParagraphBands(options.layout, options.renderHeight);
        this.mountLayers(options.layers, options.renderWidth, options.renderHeight);
        this.applyState(0, false);
    }

    /** Number of clicks this slide's build takes. */
    get stepCount(): number {
        return this.animation.steps.length;
    }

    /** Steps already played. */
    get step(): number {
        return this.currentStep;
    }

    /** Whether every step has played. */
    get isComplete(): boolean {
        return this.currentStep >= this.stepCount;
    }

    /**
     * Play the next step.
     *
     * Returns false when the build is already finished, which is the caller's
     * cue to advance the slide instead.
     */
    next(): boolean {
        if (this.isComplete) return false;
        this.currentStep += 1;
        this.applyState(this.currentStep, true);
        return true;
    }

    /** Jump to a step's resting state without animating. */
    seek(step: number): void {
        this.currentStep = Math.min(Math.max(step, 0), this.stepCount);
        this.applyState(this.currentStep, false);
    }

    /** Show the fully built slide, as when navigating backwards into it. */
    complete(): void {
        this.seek(this.stepCount);
    }

    /**
     * Whether this build is still mounted in `host` and on screen.
     *
     * A viewer that was destroyed and recreated leaves the old controller
     * pointing at detached nodes; reusing it would show no layers at all.
     */
    isMountedIn(host: HTMLElement): boolean {
        return this.host === host && host.isConnected;
    }

    /** Cancel in-flight animations and remove the layer stack. */
    destroy(): void {
        for (const animation of this.running) animation.cancel();
        this.running.clear();
        for (const layer of this.layers) layer.element.remove();
        this.layers.length = 0;
    }

    // ── Indexing ──

    /** Record, per shape, the steps at which it enters, leaves and builds. */
    private indexEffects(): void {
        this.animation.steps.forEach((step, index) => {
            for (const effect of step.effects) {
                const key = effect.shapeKey;
                if (effect.target.type === "paragraphs") {
                    for (let p = effect.target.start; p < effect.target.end; p++) {
                        const id = paragraphId(key, p);
                        if (!this.paragraphStep.has(id)) this.paragraphStep.set(id, index);
                    }
                    continue;
                }
                if (effect.class === "entrance" && !this.entranceStep.has(key)) {
                    this.entranceStep.set(key, index);
                } else if (effect.class === "exit" && !this.exitStep.has(key)) {
                    this.exitStep.set(key, index);
                }
            }
        });
    }

    /**
     * Derive each built shape's paragraph bands from the page text layout.
     *
     * Lines carry `isFirstLineOfPara`, so paragraphs are the runs between
     * those flags. Bands are stored as fractions of the page height so they
     * survive zoom without recomputation.
     */
    private indexParagraphBands(layout: LayoutPage | undefined, renderHeight: number): void {
        if (!layout || renderHeight <= 0) return;

        const built = new Set<number>();
        for (const id of this.paragraphStep.keys()) built.add(shapeOfParagraphId(id));
        if (built.size === 0) return;

        for (const frame of layout.frames) {
            const key = frame.shapeKey;
            if (key === undefined || !built.has(key) || !frame.parcel) continue;

            // Parcel coordinates are frame-local; the frame transform places
            // it on the page, and layout units are points like page.height.
            const frameTop = frame.transform.translateY + frame.parcel.y;
            const bands: ParagraphBand[] = [];
            for (const line of frame.parcel.lines) {
                const top = (frameTop + line.y - line.height) / layout.height;
                const bottom = (frameTop + line.y) / layout.height;
                if (line.isFirstLineOfPara || bands.length === 0) {
                    bands.push({ top, bottom });
                } else {
                    const last = bands[bands.length - 1];
                    last.top = Math.min(last.top, top);
                    last.bottom = Math.max(last.bottom, bottom);
                }
            }
            if (bands.length > 0) this.paragraphBands.set(key, bands);
        }
    }

    // ── Mounting ──

    private mountLayers(layers: AnimationLayer[], renderWidth: number, renderHeight: number): void {
        if (renderWidth <= 0 || renderHeight <= 0) return;

        for (const layer of layers) {
            if (layer.width === 0 || layer.height === 0) continue;

            const canvas = document.createElement("canvas");
            canvas.className = "udoc-spread__animation-layer";
            canvas.width = layer.width;
            canvas.height = layer.height;
            canvas.setAttribute("aria-hidden", "true");

            const context = canvas.getContext("2d");
            if (context) {
                // Copy rather than view the transferred buffer: ImageData
                // requires a plain ArrayBuffer, and the copy is one frame's
                // cost against a raster that is then reused for every step.
                const image = context.createImageData(layer.width, layer.height);
                image.data.set(layer.rgba);
                context.putImageData(image, 0, 0);
            }

            // Position as a percentage of the host so zooming needs no relayout.
            canvas.style.position = "absolute";
            canvas.style.left = `${(layer.x / renderWidth) * 100}%`;
            canvas.style.top = `${(layer.y / renderHeight) * 100}%`;
            canvas.style.width = `${(layer.width / renderWidth) * 100}%`;
            canvas.style.height = `${(layer.height / renderHeight) * 100}%`;
            canvas.style.transformOrigin = "center";

            this.host.appendChild(canvas);
            this.layers.push({
                shapeKey: layer.shapeKey,
                element: canvas,
                topFraction: layer.y / renderHeight,
                heightFraction: layer.height / renderHeight,
            });
        }
    }

    // ── Playback ──

    /**
     * Put every layer into its state after `step` steps.
     *
     * When `animate` is set, shapes whose state changes during this step play
     * their effect; everything else snaps, which is what makes `seek` cheap.
     */
    private applyState(step: number, animate: boolean): void {
        for (const animation of this.running) animation.cancel();
        this.running.clear();

        const playing = animate ? this.effectsOfStep(step - 1) : new Map<number, AnimationEffect>();

        for (const layer of this.layers) {
            const key = layer.shapeKey;
            if (key === undefined) {
                layer.element.style.opacity = "1";
                continue;
            }

            this.applyParagraphClip(layer, key, step);

            const visible = this.isVisibleAt(key, step);
            const effect = playing.get(key);
            if (effect) {
                this.play(layer, effect, visible);
            } else {
                layer.element.style.opacity = visible ? "1" : "0";
                layer.element.style.transform = "";
            }
        }
    }

    /** Effects belonging to a step, keyed by shape. */
    private effectsOfStep(index: number): Map<number, AnimationEffect> {
        const effects = new Map<number, AnimationEffect>();
        const step = this.animation.steps[index];
        if (!step) return effects;
        for (const effect of step.effects) {
            if (!effects.has(effect.shapeKey)) effects.set(effect.shapeKey, effect);
        }
        return effects;
    }

    private play(layer: MountedLayer, effect: AnimationEffect, endsVisible: boolean): void {
        const motion = resolveMotion(effect);
        if (!motion) {
            layer.element.style.opacity = endsVisible ? "1" : "0";
            return;
        }

        // A zero-length effect (Appear) still needs a frame to commit, so give
        // the animation a floor rather than special-casing instant effects.
        const duration = Math.max(effect.durationMs, 1);
        const animation = layer.element.animate(motion.keyframes, {
            duration,
            delay: effect.startMs,
            easing: resolveEasing(effect.accelerate, effect.decelerate),
            iterations: effect.repeatCount ?? Infinity,
            direction: effect.autoReverse ? "alternate" : "normal",
            fill: "both",
        });
        this.running.add(animation);
        animation.addEventListener("finish", () => {
            this.running.delete(animation);
            layer.element.style.opacity = motion.endsVisible ? "1" : "0";
            layer.element.style.transform = "";
            animation.cancel();
        });
    }

    /** Whether a shape is on screen once `step` steps have played. */
    private isVisibleAt(shapeKey: number, step: number): boolean {
        const entrance = this.entranceStep.get(shapeKey);
        if (entrance !== undefined && step <= entrance) return false;
        const exit = this.exitStep.get(shapeKey);
        if (exit !== undefined && step > exit) return false;
        return true;
    }

    /**
     * Clip a paragraph-built shape to the paragraphs revealed so far.
     *
     * Bands are page-relative, so they are rebased onto the layer's own box
     * before becoming an inset. Shapes without a build get no clip at all.
     */
    private applyParagraphClip(layer: MountedLayer, shapeKey: number, step: number): void {
        const bands = this.paragraphBands.get(shapeKey);
        if (!bands || layer.heightFraction <= 0) return;

        let revealed = -1;
        for (let index = 0; index < bands.length; index++) {
            const at = this.paragraphStep.get(paragraphId(shapeKey, index));
            // A paragraph with no effect of its own is part of the base text.
            if (at === undefined || step > at) revealed = index;
            else break;
        }

        if (revealed < 0) {
            layer.element.style.clipPath = "inset(0 0 100% 0)";
            return;
        }
        if (revealed >= bands.length - 1) {
            layer.element.style.clipPath = "";
            return;
        }

        const cutoff = bands[revealed].bottom;
        const bottomInset = 1 - (cutoff - layer.topFraction) / layer.heightFraction;
        layer.element.style.clipPath = `inset(0 0 ${(bottomInset * 100).toFixed(3)}% 0)`;
    }
}

function paragraphId(shapeKey: number, paragraph: number): string {
    return `${shapeKey}:${paragraph}`;
}

function shapeOfParagraphId(id: string): number {
    return Number(id.slice(0, id.indexOf(":")));
}

// ── The build currently on screen ──
//
// Exactly one slide is presented at a time in spread mode, so the active
// controller is shared rather than threaded through every component that can
// advance the deck.

let active: SlideAnimationController | null = null;
let activeRestore: (() => void) | null = null;
/** Identity of the mounted build, so re-renders can skip or resume it. */
let activeKey: string | null = null;
/** Bumped by every mount attempt so a superseded one discards its result. */
let mountGeneration = 0;
/**
 * Build sequences already fetched, keyed `docId:pageIndex`.
 *
 * Knowing whether a slide animates *before* its layers are ready is what lets
 * the viewer avoid showing the finished slide and then rewinding it to step 0.
 * `null` records "asked, and it has none".
 */
const animationCache = new Map<string, SlideAnimation | null>();

function cacheKey(docId: string, pageIndex: number): string {
    return `${docId}:${pageIndex}`;
}

/** Fetch a slide's build sequence, reusing the cached answer when there is one. */
async function loadAnimation(
    workerClient: WorkerClient,
    docId: string,
    pageIndex: number,
): Promise<SlideAnimation | null> {
    const key = cacheKey(docId, pageIndex);
    const cached = animationCache.get(key);
    if (cached !== undefined) return cached;

    const animation = (await workerClient.getSlideAnimation(docId, pageIndex)) ?? null;
    animationCache.set(key, animation);
    return animation;
}

/**
 * Whether a slide is known to animate, without waiting on the worker.
 *
 * `undefined` means "not asked yet" — the caller must not assume either way.
 */
export function knownToAnimate(docId: string, pageIndex: number): boolean | undefined {
    const cached = animationCache.get(cacheKey(docId, pageIndex));
    if (cached === undefined) return undefined;
    return cached !== null && cached.steps.length > 0;
}

/**
 * Warm the cache for a slide so arriving at it needs no worker round trip.
 *
 * Called for the slides on either side of the current one, which covers the
 * sequential stepping that presenting a deck actually consists of.
 */
export function prefetchSlideAnimation(workerClient: WorkerClient, docId: string, pageIndex: number): void {
    if (pageIndex < 0) return;
    if (animationCache.has(cacheKey(docId, pageIndex))) return;
    void loadAnimation(workerClient, docId, pageIndex).catch(() => {
        // A prefetch failure is not worth surfacing; the real mount retries.
        animationCache.delete(cacheKey(docId, pageIndex));
    });
}

/**
 * Drop cached build sequences, for one document or all of them.
 *
 * Document ids are recycled — a fresh client numbers from `doc_0` again — so a
 * stale entry would otherwise hand one document's timeline to another.
 */
export function forgetSlideAnimations(docId?: string): void {
    if (docId === undefined) {
        animationCache.clear();
        return;
    }
    for (const key of [...animationCache.keys()]) {
        if (key.startsWith(`${docId}:`)) animationCache.delete(key);
    }
}

/**
 * Advance the on-screen build by one step.
 *
 * Returns true when a step played, which means the caller must NOT turn the
 * page: the click belonged to the build, not to navigation.
 */
export function advanceActiveSlideAnimation(): boolean {
    return active?.next() ?? false;
}

/** Steps played on the on-screen build, or null when none is mounted. */
export function activeSlideAnimationStep(): number | null {
    return active?.step ?? null;
}

/** Whether a build is on screen with steps still to play. */
export function hasPendingSlideAnimation(): boolean {
    return active !== null && !active.isComplete;
}

/** Tear down the on-screen build and restore the plain page canvas. */
export function clearActiveSlideAnimation(): void {
    active?.destroy();
    active = null;
    activeKey = null;
    activeRestore?.();
    activeRestore = null;
    // The canvas may be hidden with no controller yet — a mount that was
    // abandoned between "this slide animates" and "its layers are ready".
    showPageCanvas(hiddenPageCanvas);
}

/**
 * Hide the plain page canvas while a build owns the slide.
 *
 * Tracked so an aborted mount can put it back: the canvas is hidden before the
 * layers exist, so every failure path after that point must restore it.
 */
let hiddenPageCanvas: HTMLElement | null = null;

function hidePageCanvas(canvas: HTMLElement): void {
    if (hiddenPageCanvas === canvas) return;
    showPageCanvas(hiddenPageCanvas);
    hiddenPageCanvas = canvas;
    canvas.style.visibility = "hidden";
}

function showPageCanvas(canvas: HTMLElement | null): void {
    if (!canvas) return;
    canvas.style.visibility = "";
    if (hiddenPageCanvas === canvas) hiddenPageCanvas = null;
}

export interface MountSlideAnimationOptions {
    workerClient: WorkerClient;
    docId: string;
    /** Zero-based index of the slide being shown. */
    pageIndex: number;
    /** Element the layer stack mounts into, sized to the displayed page. */
    host: HTMLElement;
    /** The slide's plain canvas, hidden while the build is on screen. */
    pageCanvas: HTMLElement;
    /** Device-pixel size to rasterize the layers at. */
    renderWidth: number;
    renderHeight: number;
    /** Start on the fully built slide, as when navigating backwards into it. */
    startComplete?: boolean;
}

/**
 * Load and mount a slide's build sequence.
 *
 * Returns false — leaving the plain page canvas in place — when the slide has
 * no animation, which is the overwhelming majority of pages.
 */
export async function mountSlideAnimation(options: MountSlideAnimationOptions): Promise<boolean> {
    const { workerClient, docId, pageIndex, host, pageCanvas } = options;

    // Re-rendering the same slide at the same resolution — a scroll, or a
    // layout pass that changed nothing — must not restart the build.
    const key = `${docId}:${pageIndex}:${options.renderWidth}x${options.renderHeight}`;
    if (active && activeKey === key && active.isMountedIn(host)) return true;

    // Everything below runs while the previous build stays live and clickable.
    // Tearing it down first would leave a window — several frames of worker
    // round-trips — in which an advance would turn the page instead of stepping
    // the build, and the layer stack would visibly flash.
    const generation = ++mountGeneration;
    const superseded = (): boolean => generation !== mountGeneration;

    const animation = await loadAnimation(workerClient, docId, pageIndex);
    if (superseded()) return active !== null;
    if (!animation || animation.steps.length === 0) {
        clearActiveSlideAnimation();
        return false;
    }

    // Hide the finished slide the moment we know it builds, rather than after
    // its layers are ready: rasterizing them takes long enough that the viewer
    // would otherwise show the completed slide and then rewind it to step 0.
    hidePageCanvas(pageCanvas);

    const layers = await workerClient.renderPageLayers(docId, pageIndex, options.renderWidth, options.renderHeight);
    if (superseded()) return active !== null;
    if (!layers || layers.length === 0) {
        clearActiveSlideAnimation();
        return false;
    }

    // Paragraph builds need the text layout to find their bands; a slide that
    // only animates whole shapes does not, so a failure here is not fatal.
    let layout: LayoutPage | undefined;
    if (animation.steps.some((step) => step.effects.some((e) => e.target.type === "paragraphs"))) {
        layout = await workerClient.getLayoutPage(docId, pageIndex).catch(() => undefined);
        if (superseded()) return active !== null;
    }

    // Zoom and rotation change the resolution, so the layers were rasterized
    // again; carry the step across so the build resumes where it was.
    const resumeStep = activeKey?.startsWith(`${docId}:${pageIndex}:`) ? (active?.step ?? null) : null;
    clearActiveSlideAnimation();

    const controller = new SlideAnimationController({
        animation,
        layers,
        renderWidth: options.renderWidth,
        renderHeight: options.renderHeight,
        host,
        layout,
    });
    if (resumeStep !== null) controller.seek(resumeStep);
    else if (options.startComplete) controller.complete();

    const previousHostDisplay = host.style.display;
    host.style.display = "block";

    hidePageCanvas(pageCanvas);
    active = controller;
    activeKey = key;
    activeRestore = () => {
        showPageCanvas(pageCanvas);
        host.style.display = previousHostDisplay;
    };
    return true;
}
