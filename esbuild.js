// Bundles the extension into a single CommonJS file (dist/extension.js).
// Usage: node esbuild.js [--watch] [--production]
const esbuild = require("esbuild")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  // jsonc-parser's CJS "main" is a UMD wrapper that calls require("./impl/…")
  // through a variable. esbuild cannot bundle those dynamic requires, so they
  // would break at runtime inside the VSIX (which ships no node_modules).
  // Preferring the ESM build gives us static imports that esbuild can inline.
  mainFields: ["module", "main"],
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options)
    await ctx.watch()
  } else {
    await esbuild.build(options)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
