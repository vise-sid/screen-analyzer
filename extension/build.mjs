// PixelFoxx extension build — bundles src/ into dist/ via esbuild.
//
//   node build.mjs           # one-shot build
//   node build.mjs --watch   # rebuild on change
//
// Outputs:
//   dist/background.js  (service worker — IIFE so it works as a classic SW)
//   dist/sidepanel.js   (sidepanel script — IIFE; loaded by sidepanel.html)

import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  platform: "browser",
  logLevel: "info",
  sourcemap: true,
  legalComments: "linked",
  // playwright-crx's prebuilt bundle has two optional imports that don't ship:
  // ../playwright (the @playwright/test path — we don't use assertions in the SW)
  // ./bidiOverCdp (for non-Chromium — we only target Chrome here).
  // Neither is reached at runtime for our use; mark external to satisfy esbuild.
  external: ["../playwright", "./bidiOverCdp"],
};

const ctxs = [
  await esbuild.context({
    ...common,
    entryPoints: ["src/background.js"],
    outfile: "dist/background.js",
  }),
  await esbuild.context({
    ...common,
    entryPoints: ["src/sidepanel.js"],
    outfile: "dist/sidepanel.js",
  }),
];

if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[build] watching…");
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
  console.log("[build] done.");
}
