import { describe, expect, test } from "vitest"
import { isEnabled, isIgnored, severityFor, type JoggleConfig } from "../src/config.ts"

const config: JoggleConfig = {
  rules: {
    "joggle/duplicate-meaning": "off",
    "joggle/bundle-dot-notation": "error",
  },
  ignore: [
    { rule: "joggle/bundle-*", path: "services/ui/app/routes/legacy/**", reason: "being deleted" },
    { path: "**/*.stories.tsx" },
  ],
}

describe("a repository's answers", () => {
  test("configure which rules run", () => {
    expect(isEnabled(config, "joggle/duplicate-meaning", "warn")).toBe(false)
    expect(isEnabled(config, "joggle/naming-drift", "warn")).toBe(true)
  })

  test("configure how loudly they speak", () => {
    expect(severityFor(config, "joggle/bundle-dot-notation", "warn")).toBe("error")
    // Unconfigured rules keep the severity they were written with.
    expect(severityFor(config, "joggle/naming-drift", "info")).toBe("info")
  })

  test("except a rule at a path", () => {
    expect(
      isIgnored(
        config,
        "joggle/bundle-dot-notation",
        "services/ui/app/routes/legacy/components/index.ts",
      ),
    ).toBe(true)
    // The same rule elsewhere is not excepted.
    expect(isIgnored(config, "joggle/bundle-dot-notation", "services/ui/app/components/a/index.ts")).toBe(false)
    // A rule outside the glob is not excepted, even at that path.
    expect(
      isIgnored(config, "joggle/duplicate-meaning", "services/ui/app/routes/legacy/a.ts"),
    ).toBe(false)
  })

  test("except every rule at a path when no rule is named", () => {
    expect(isIgnored(config, "joggle/anything", "app/components/a.stories.tsx")).toBe(true)
  })

  test("an empty config changes nothing", () => {
    expect(severityFor({}, "joggle/duplicate-meaning", "warn")).toBe("warn")
    expect(isIgnored({}, "joggle/duplicate-meaning", "src/a.ts")).toBe(false)
  })
})
