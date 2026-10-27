import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  findInterpreter,
  interpreterCandidates,
  parseVersion,
  versionSatisfies,
  venvPythonPath,
  type Runner,
} from "../src/core/python"
import { splitAccounts } from "../src/ext/cookies"

describe("python discovery", () => {
  it("parses versions", () => {
    assert.deepEqual(parseVersion("Python 3.11.8"), { major: 3, minor: 11, patch: 8 })
    assert.deepEqual(parseVersion("3.10.2"), { major: 3, minor: 10, patch: 2 })
    assert.equal(parseVersion("nonsense"), undefined)
  })

  it("enforces Python >= 3.10", () => {
    assert.equal(versionSatisfies("3.9.18"), false)
    assert.equal(versionSatisfies("3.10.0"), true)
    assert.equal(versionSatisfies("3.12.1"), true)
    assert.equal(versionSatisfies("2.7.18"), false)
  })

  it("tries python3 first and honours a configured interpreter", () => {
    assert.equal(interpreterCandidates()[0]!.command, "python3")
    const custom = interpreterCandidates("/opt/py/bin/python3")[0]!
    assert.equal(custom.command, "/opt/py/bin/python3")
    assert.deepEqual(custom.args, [])
  })

  it("skips old interpreters and finds a usable one", async () => {
    const calls: string[] = []
    const run: Runner = async (command, args) => {
      calls.push(`${command} ${args[0] ?? ""}`.trim())
      if (command === "python3") return { code: 0, stdout: "3.9.18\n", stderr: "" }
      if (command === "python") return { code: 0, stdout: "3.11.4\n", stderr: "" }
      return { code: 1, stdout: "", stderr: "not found" }
    }
    const found = await findInterpreter(run)
    assert.equal(found?.version, "3.11.4")
    assert.equal(found?.shortVersion, "3.11")
    assert.ok(calls.length >= 2)
  })

  it("returns undefined when nothing works", async () => {
    const run: Runner = async () => ({ code: 127, stdout: "", stderr: "ENOENT" })
    assert.equal(await findInterpreter(run), undefined)
  })

  it("resolves the venv interpreter path per platform", () => {
    const value = venvPythonPath("/tmp/venv")
    if (process.platform === "win32") assert.match(value, /Scripts/)
    else assert.match(value, /bin\/python$/)
  })
})

describe("cookie import parsing", () => {
  it("accepts a raw Cookie header", () => {
    const accounts = splitAccounts("hatch_sess=abc; hatch_native_auth_device=xyz")
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0]!.cookies, "hatch_sess=abc; hatch_native_auth_device=xyz")
  })

  it("accepts `label | cookies` lines and skips comments", () => {
    const accounts = splitAccounts("# comment\nacc1 | a=1; b=2\nacc2 | c=3\n")
    assert.deepEqual(accounts, [
      { label: "acc1", cookies: "a=1; b=2" },
      { label: "acc2", cookies: "c=3" },
    ])
  })

  it("accepts a cookie dict", () => {
    const accounts = splitAccounts('{"hatch_sess":"abc","hatch_native_auth_device":"xyz"}')
    assert.deepEqual(accounts[0]!.cookies, { hatch_sess: "abc", hatch_native_auth_device: "xyz" })
  })

  it("accepts an EditThisCookie array", () => {
    const json = JSON.stringify([
      { name: "hatch_sess", value: "a", expirationDate: 1_900_000_000 },
      { name: "hatch_native_auth_device", value: "b" },
    ])
    const accounts = splitAccounts(json)
    assert.equal(accounts.length, 1)
    assert.ok(Array.isArray(accounts[0]!.cookies))
  })

  it("accepts a list of account objects", () => {
    const json = JSON.stringify([
      { label: "a", cookies: "x=1" },
      { label: "b", cookies: { y: "2" } },
    ])
    const accounts = splitAccounts(json)
    assert.equal(accounts.length, 2)
    assert.equal(accounts[0]!.label, "a")
  })

  it("strips a `cookie:` prefix", () => {
    assert.equal(splitAccounts("Cookie: a=1; b=2")[0]!.cookies, "a=1; b=2")
  })

  it("rejects empty input", () => {
    assert.deepEqual(splitAccounts("  \n "), [])
  })
})
