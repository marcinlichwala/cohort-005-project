import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  findOversized,
  formatReport,
  MAX_TOKENS,
} from "./check-file-tokens";

const limitInBytes = MAX_TOKENS * 4;

describe("check-file-tokens", () => {
  it("estimates tokens as bytes / 4, rounded up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });

  it("accepts a file at the limit and rejects one byte over", () => {
    const oversized = findOversized([
      { path: "app/at-limit.ts", bytes: limitInBytes },
      { path: "app/over-limit.ts", bytes: limitInBytes + 1 },
    ]);
    expect(oversized.map((file) => file.path)).toEqual(["app/over-limit.ts"]);
  });

  it("ignores lockfiles, migrations, snapshots and binaries", () => {
    const huge = limitInBytes * 10;
    const oversized = findOversized(
      [
        "package-lock.json",
        "drizzle/meta/0010_snapshot.json",
        "app/foo.test.ts.snap",
        "public/hero.png",
        ".agents/skills/tdd/SKILL.md",
      ].map((path) => ({ path, bytes: huge }))
    );
    expect(oversized).toEqual([]);
  });

  it("names each oversized file and explains how to split it", () => {
    const report = formatReport([
      { path: "app/routes/big.tsx", bytes: 80_000, tokens: 20_000 },
    ]);
    expect(report).toContain("app/routes/big.tsx: ~20000 tokens");
    expect(report).toContain("app/modules/README.md");
    expect(report).toContain("--no-verify");
  });
});
