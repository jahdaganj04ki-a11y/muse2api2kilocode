// Compiles the pure TypeScript tests to a temp folder, then runs node --test.
// The tests intentionally avoid the vscode module (only pure core modules).
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = mkdtempSync(path.join(tmpdir(), "muse2api-tests-"))

try {
  execFileSync(
    path.join(root, "node_modules", ".bin", "tsc"),
    ["-p", path.join(root, "tsconfig.test.json"), "--outDir", out],
    { cwd: root, stdio: "inherit" },
  )
  const testDir = path.join(out, "test")
  const files = readdirSync(testDir)
    .filter((file) => file.endsWith(".test.js"))
    .map((file) => path.join(testDir, file))
  if (files.length === 0) throw new Error("No compiled test files found")
  // Keep the repo's node_modules resolvable for the compiled tests (jsonc-parser).
  const env = { ...process.env, NODE_PATH: path.join(root, "node_modules") }
  execFileSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit", env })
} finally {
  rmSync(out, { recursive: true, force: true })
}
