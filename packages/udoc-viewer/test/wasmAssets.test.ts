import { describe, it, expect } from "vitest";
import { describeInitError } from "../src/worker/wasmError.js";
import { assetUrl } from "../src/UDocClient.js";

describe("assetUrl", () => {
    it("stamps the SDK version onto self-hosted assets", () => {
        const url = new URL(assetUrl("udoc_bg.wasm", "https://cdn.example.com/udoc/", "0.7.13"));
        expect(url.pathname).toBe("/udoc/udoc_bg.wasm");
        expect(url.searchParams.get("v")).toBe("0.7.13");
    });

    it("gives each release a distinct cache key", () => {
        const base = "https://cdn.example.com/udoc/";
        expect(assetUrl("worker.js", base, "0.7.11")).not.toBe(assetUrl("worker.js", base, "0.7.13"));
    });

    it("keeps the base path when it has no trailing slash segment", () => {
        expect(assetUrl("worker.js", "https://cdn.example.com/udoc/", "0.7.13")).toBe(
            "https://cdn.example.com/udoc/worker.js?v=0.7.13",
        );
    });

    it("replaces an existing v parameter instead of appending a second one", () => {
        const url = new URL(assetUrl("worker.js", "https://cdn.example.com/udoc/?v=0.0.1", "0.7.13"));
        expect(url.searchParams.getAll("v")).toEqual(["0.7.13"]);
    });

    it("omits the stamp when the version placeholder is unreplaced", () => {
        // Running from source rather than a dist build.
        expect(assetUrl("worker.js", "https://cdn.example.com/udoc/", "__VERSION__")).toBe(
            "https://cdn.example.com/udoc/worker.js",
        );
    });
});

describe("describeInitError", () => {
    const linkError = new WebAssembly.LinkError(
        'WebAssembly.instantiate(): Import #177 "./udoc_bg.js" "__wbg_from_d300fe49deab18f5": ' +
            "function import requires a callable",
    );

    it("explains a glue/engine version mismatch", () => {
        const err = describeInitError(linkError, "https://cdn.example.com/udoc/udoc_bg.wasm", "0.7.13");
        expect(err.message).toContain("WASM engine version mismatch");
        expect(err.message).toContain("https://cdn.example.com/udoc/udoc_bg.wasm");
        expect(err.message).toContain("SDK 0.7.13");
        // Original message is preserved for support tickets.
        expect(err.message).toContain("__wbg_from_d300fe49deab18f5");
    });

    it("names the bundled engine when there is no explicit URL", () => {
        expect(describeInitError(linkError, undefined, "0.7.13").message).toContain("bundled with this app");
    });

    it("detects a mismatch from the message when LinkError is not thrown", () => {
        const firefoxStyle = new Error("import object field '__wbg_from_d300fe49deab18f5' is not a Function");
        expect(describeInitError(firefoxStyle, undefined, "0.7.13").message).toContain("WASM engine version mismatch");
    });

    it("passes unrelated errors through untouched", () => {
        const fetchFailure = new TypeError("Failed to fetch");
        expect(describeInitError(fetchFailure, "https://example.com/udoc_bg.wasm", "0.7.13")).toBe(fetchFailure);
    });
});
