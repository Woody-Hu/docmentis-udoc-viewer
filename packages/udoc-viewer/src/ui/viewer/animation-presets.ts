/**
 * PowerPoint effects → CSS keyframes.
 *
 * Effects are matched on what the file says they do, not on a preset id.
 * PowerPoint records the visual twice: as a `presetID` into a catalog of named
 * effects, and as the behaviors that drive it. Only the second is
 * self-describing — `p:animEffect/@filter` spells out `fade`, `zoom(in)`,
 * `wipe(up)` in words — so that is what this keys on. Preset ids are an opaque
 * numbering we have no ground truth for, and guessing them means playing the
 * wrong effect.
 *
 * Anything unrecognized falls back to a fade of the right class, so the slide
 * still builds correctly, just without the authored flourish.
 */

import type { AnimationEffect } from "../../worker/index.js";

/** How a shape's layers should move for one effect. */
export interface EffectMotion {
    /** Keyframes applied to the layer element, start → end. */
    keyframes: Keyframe[];
    /** Whether the shape is on screen once the effect has finished. */
    endsVisible: boolean;
}

const HIDDEN: Keyframe = { opacity: "0" };
const SHOWN: Keyframe = { opacity: "1" };

/** Directions a filter option can name, as CSS `inset()` edges. */
const WIPE_INSETS: Record<string, [string, string]> = {
    // [hidden state, shown state] — insets are top right bottom left.
    up: ["inset(100% 0 0 0)", "inset(0 0 0 0)"],
    down: ["inset(0 0 100% 0)", "inset(0 0 0 0)"],
    left: ["inset(0 0 0 100%)", "inset(0 0 0 0)"],
    right: ["inset(0 100% 0 0)", "inset(0 0 0 0)"],
};

/**
 * Keyframes for a named filter, in "hidden → shown" order.
 *
 * Exit effects reverse whatever this returns, so each filter is written once.
 */
function filterKeyframes(name: string, option: string | undefined): Keyframe[] | null {
    switch (name) {
        case "fade":
        case "dissolve":
            return [HIDDEN, SHOWN];
        case "zoom": {
            // `in` grows from small, `out` shrinks from large. Anything else
            // (`center`, `inSlightly`, …) reads as a plain grow.
            const from = option === "out" ? "scale(1.6)" : "scale(0.4)";
            return [
                { opacity: "0", transform: from },
                { opacity: "1", transform: "scale(1)" },
            ];
        }
        case "wipe":
        case "barn":
        case "strips": {
            const insets = WIPE_INSETS[option ?? "up"];
            if (!insets) return [HIDDEN, SHOWN];
            return [
                { clipPath: insets[0], opacity: "1" },
                { clipPath: insets[1], opacity: "1" },
            ];
        }
        default:
            return null;
    }
}

/**
 * Resolve an effect to the motion its layers should play.
 *
 * Returns null for effects that neither move nor change visibility, which the
 * caller can skip entirely.
 */
export function resolveMotion(effect: AnimationEffect): EffectMotion | null {
    const entering = effect.class === "entrance";
    if (!entering && effect.class !== "exit") {
        // Emphasis, motion paths, OLE verbs and media calls leave visibility
        // alone. Without a faithful rendering, doing nothing beats guessing.
        return null;
    }

    const keyframes = enterKeyframes(effect);
    return {
        keyframes: entering ? keyframes : [...keyframes].reverse(),
        endsVisible: entering,
    };
}

/** Keyframes as if the effect were an entrance, hidden → shown. */
function enterKeyframes(effect: AnimationEffect): Keyframe[] {
    const behavior = effect.behavior;
    if (!behavior) return [HIDDEN, SHOWN];

    switch (behavior.type) {
        case "filter":
            return filterKeyframes(behavior.name, behavior.option ?? undefined) ?? [HIDDEN, SHOWN];
        case "scale":
            return [
                { opacity: "0", transform: "scale(0.4)" },
                { opacity: "1", transform: "scale(1)" },
            ];
        case "rotate":
            return [
                { opacity: "0", transform: "rotate(-180deg)" },
                { opacity: "1", transform: "rotate(0deg)" },
            ];
        // "move" needs the behavior's from/to values, which are not parsed yet,
        // so it fades rather than sliding in an arbitrary direction.
        case "move":
        case "color":
        case "instant":
        default:
            return [HIDDEN, SHOWN];
    }
}

/**
 * Convert PowerPoint's accelerate/decelerate fractions to a CSS easing.
 *
 * PowerPoint eases over a fraction of the duration at each end, which maps
 * onto a cubic-bezier whose control points sit at those fractions.
 */
export function resolveEasing(accelerate: number, decelerate: number): string {
    if (accelerate <= 0 && decelerate <= 0) return "linear";
    const x1 = clamp01(accelerate);
    const x2 = 1 - clamp01(decelerate);
    return `cubic-bezier(${x1.toFixed(3)}, 0, ${x2.toFixed(3)}, 1)`;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}
