// Builds the VSIX with @vscode/vsce.
// Usage: node scripts/package.mjs [--pre-release] [--out <file>]
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)

const outIndex = args.indexOf("--out")
const out =
  outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : path.join(root, `muse2api-kilocode-${process.env.npm_package_version || "0.1.0"}.vsix`)

if (!existsSync(path.join(root, "dist", "extension.js"))) {
  console.error("dist/extension.js is missing — run `npm run compile` first.")
  process.exit(1)
}
if (!existsSync(path.join(root, "vendor", "muse2api", "pyproject.toml"))) {
  console.error("vendor/muse2api is missing — the VSIX would not contain the gateway.")
  process.exit(1)
}

const vsce = path.join(root, "node_modules", ".bin", "vsce")
const vsceArgs = ["package", "--no-dependencies", "--out", out]
if (args.includes("--pre-release")) vsceArgs.push("--pre-release")

console.log(`> ${vsce} ${vsceArgs.join(" ")}`)
execFileSync(vsce, vsceArgs, { cwd: root, stdio: "inherit" })
console.log(`\nVSIX: ${out}`)
