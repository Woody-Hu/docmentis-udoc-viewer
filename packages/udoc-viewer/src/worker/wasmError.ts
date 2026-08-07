/**
 * Diagnostics for WASM engine initialization failures.
 */

/**
 * Turn a WASM link failure into an actionable message.
 *
 * A LinkError on instantiate means udoc_bg.wasm expects imports this build of
 * the JS glue doesn't provide — the two files came from different releases.
 * The raw message names an internal wasm-bindgen symbol, which tells the
 * integrator nothing, so state the actual cause instead.
 *
 * @param error - The error thrown by the wasm-bindgen init function
 * @param wasmUrl - URL the engine was loaded from, if not bundler-resolved
 * @param version - SDK version of the worker attempting the load
 */
export function describeInitError(error: unknown, wasmUrl: string | undefined, version: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const mismatch =
        (typeof WebAssembly.LinkError === "function" && error instanceof WebAssembly.LinkError) ||
        (/\bimport\b/i.test(message) && /callable|not a function/i.test(message));

    if (!mismatch) {
        return error instanceof Error ? error : new Error(message);
    }

    const source = wasmUrl ? `at ${wasmUrl}` : "bundled with this app";
    return new Error(
        `WASM engine version mismatch: udoc_bg.wasm ${source} was built for a different release ` +
            `than this worker (SDK ${version}). Serve worker.js and udoc_bg.wasm from the same ` +
            `@docmentis/udoc-viewer version, then clear any CDN or browser cache. (${message})`,
    );
}
