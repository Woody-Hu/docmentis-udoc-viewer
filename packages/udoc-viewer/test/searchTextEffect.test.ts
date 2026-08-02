import { describe, it, expect, vi, beforeAll } from "vitest";
import { createStore } from "../src/ui/framework/store";
import { reducer } from "../src/ui/viewer/reducer";
import { initialState } from "../src/ui/viewer/state";
import { createEffects } from "../src/ui/viewer/effects";
import type { ViewerState } from "../src/ui/viewer/state";
import type { Action } from "../src/ui/viewer/actions";
import type { EngineAdapter } from "../src/ui/viewer/shell";
import type { LayoutPage } from "../src/worker/index.js";

const PAGE_COUNT = 6;

beforeAll(() => {
    // The on-demand annotation/text effects yield to rAF. Resolve on a microtask
    // so flush() drives them deterministically instead of on a real frame.
    globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => {
        queueMicrotask(() => cb(0));
        return 0;
    }) as typeof requestAnimationFrame;
});

/** Minimal empty layout page — these tests care about extraction bookkeeping, not glyphs. */
function emptyLayoutPage(): LayoutPage {
    return { width: 600, height: 800, frames: [] } as unknown as LayoutPage;
}

/** Flush pending microtasks so batched store notifications and effect awaits settle. */
async function flush(times = 20): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Engine stub whose getLayoutPage calls are resolved manually, so tests can hold
 * a page in flight and interleave state changes against it.
 */
function createControllableEngine() {
    const pending = new Map<number, (page: LayoutPage) => void>();
    const requested: number[] = [];

    const engine = {
        getPageInfo: vi.fn(),
        getOutline: vi.fn(),
        getPageAnnotations: vi.fn(),
        getVisibilityGroups: vi.fn(),
        setVisibilityGroupVisible: vi.fn(),
        getLayoutPage: vi.fn((_doc: { id: string }, pageIndex: number) => {
            requested.push(pageIndex);
            return new Promise<LayoutPage>((resolve) => {
                pending.set(pageIndex, resolve);
            });
        }),
    } as unknown as EngineAdapter;

    return {
        engine,
        requested,
        pendingPages: () => [...pending.keys()],
        resolvePage(pageIndex: number): void {
            const resolve = pending.get(pageIndex);
            if (!resolve) throw new Error(`page ${pageIndex} was not requested`);
            pending.delete(pageIndex);
            resolve(emptyLayoutPage());
        },
        async resolveAll(): Promise<void> {
            // Resolving one page lets the run request the next, so drain in a loop.
            for (let guard = 0; guard < PAGE_COUNT * 4 && pending.size > 0; guard++) {
                for (const pageIndex of [...pending.keys()]) this.resolvePage(pageIndex);
                await flush();
            }
        },
    };
}

function createHarness() {
    const controllable = createControllableEngine();
    const store = createStore<ViewerState, Action>(
        reducer,
        { ...initialState, doc: { id: "doc-1" }, pageCount: PAGE_COUNT },
        { batched: true },
    );
    const effects = createEffects(store, controllable.engine);
    return { ...controllable, store, effects };
}

describe("search text loading effect", () => {
    it("does not mark the document searchable using a superseded page range", async () => {
        const h = createHarness();

        // Run 1: restricted to pages 0-1.
        h.store.dispatch({ type: "SET_SEARCH_PAGE_RANGE", range: { start: 0, end: 1 } });
        h.store.dispatch({ type: "SET_SEARCH_QUERY", query: "alpha" });
        await flush();
        expect(h.store.getState().searchTextLoading).toBe(true);

        // Run 2 widens to the whole document while run 1 is still in flight.
        h.store.dispatch({ type: "SET_SEARCH_PAGE_RANGE", range: null });
        h.store.dispatch({ type: "SET_SEARCH_QUERY", query: "beta" });
        await flush();

        await h.resolveAll();

        // Run 1 must not have declared the document loaded after covering only 0-1.
        const state = h.store.getState();
        expect(state.searchTextLoaded).toBe(true);
        expect(state.searchTextLoading).toBe(false);
        for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex++) {
            expect(state.pageText.has(pageIndex)).toBe(true);
        }

        h.effects.destroy();
    });

    it("waits for page text already owned by another effect before reporting loaded", async () => {
        const h = createHarness();

        // The on-demand text effect claims page 0 for the current view.
        h.store.dispatch({ type: "SET_PAGE_COUNT", pageCount: PAGE_COUNT });
        h.store.dispatch({ type: "LOAD_PAGE_TEXT", pageIndex: 0 });
        expect(h.store.getState().textLoading.has(0)).toBe(true);

        h.store.dispatch({ type: "SET_SEARCH_QUERY", query: "alpha" });
        await flush();

        // Pages 1..N are requested by the search run; page 0 is not (already owned).
        for (const pageIndex of h.pendingPages()) h.resolvePage(pageIndex);
        await flush();
        await h.resolveAll();

        expect(h.requested).not.toContain(0);
        // Page 0 is still outstanding, so the run must still be parked.
        expect(h.store.getState().searchTextLoaded).toBe(false);
        expect(h.store.getState().searchTextLoading).toBe(true);

        // The owning effect finally delivers page 0.
        h.store.dispatch({ type: "SET_PAGE_TEXT", pageIndex: 0, text: emptyLayoutPage() });
        await flush();

        expect(h.store.getState().searchTextLoaded).toBe(true);
        expect(h.store.getState().searchTextLoading).toBe(false);

        h.effects.destroy();
    });

    it("stops waiting when a page leaves textLoading without a result", async () => {
        const h = createHarness();

        h.store.dispatch({ type: "LOAD_PAGE_TEXT", pageIndex: 0 });
        h.store.dispatch({ type: "SET_SEARCH_QUERY", query: "alpha" });
        await flush();
        await h.resolveAll();
        expect(h.store.getState().searchTextLoaded).toBe(false);

        // Neither pageText nor textFailed — the wait must key off textLoading.
        h.store.dispatch({ type: "CLEAR_PAGE_TEXT_LOADING", pageIndex: 0 });
        await flush();

        expect(h.store.getState().searchTextLoaded).toBe(true);
        expect(h.store.getState().searchTextLoading).toBe(false);

        h.effects.destroy();
    });

    it("clears the loading flag when the query is cleared mid-extraction", async () => {
        const h = createHarness();

        h.store.dispatch({ type: "SET_SEARCH_QUERY", query: "alpha" });
        await flush();
        expect(h.store.getState().searchTextLoading).toBe(true);

        h.store.dispatch({ type: "CLEAR_SEARCH" });
        await flush();
        await h.resolveAll();

        expect(h.store.getState().searchTextLoading).toBe(false);
        expect(h.store.getState().searchTextLoaded).toBe(false);

        h.effects.destroy();
    });

    it("releases parked waits on destroy without dispatching", async () => {
        const h = createHarness();

        h.store.dispatch({ type: "LOAD_PAGE_TEXT", pageIndex: 0 });
        h.store.dispatch({ type: "SET_SEARCH_QUERY", query: "alpha" });
        await flush();
        await h.resolveAll();
        expect(h.store.getState().searchTextLoading).toBe(true);

        h.effects.destroy();
        await flush();

        // Teardown must not leave the run parked, and must not mark loaded.
        expect(h.store.getState().searchTextLoaded).toBe(false);
    });
});

describe("search execution effect", () => {
    it("emits a matches update after searchTextLoaded flips", async () => {
        const h = createHarness();

        // Everything cached except page 0, which another effect already owns. The
        // extraction run parks on it, so the final matches recompute and the
        // searchTextLoaded flip land in separate notification batches.
        h.store.dispatch({ type: "LOAD_PAGE_TEXT", pageIndex: 0 });
        for (let pageIndex = 1; pageIndex < PAGE_COUNT; pageIndex++) {
            h.store.dispatch({ type: "SET_PAGE_TEXT", pageIndex, text: emptyLayoutPage() });
        }
        await flush();

        // Mirrors how UDocViewer.search() resolves: the first matches update
        // observed while searchTextLoaded is true.
        let resolvedLikeSearchApi = false;
        h.store.subscribeEffect((prev, next) => {
            if (next.searchTextLoaded && prev.searchMatches !== next.searchMatches) {
                resolvedLikeSearchApi = true;
            }
        });

        h.store.dispatch({ type: "SET_SEARCH_QUERY", query: "alpha" });
        await flush();
        await h.resolveAll();
        expect(h.store.getState().searchTextLoaded).toBe(false);

        // The owning effect delivers page 0; the parked run then finishes.
        h.store.dispatch({ type: "SET_PAGE_TEXT", pageIndex: 0, text: emptyLayoutPage() });
        await flush();

        expect(h.store.getState().searchTextLoaded).toBe(true);
        expect(resolvedLikeSearchApi).toBe(true);

        h.effects.destroy();
    });
});
