import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lines = (file: string) => readFileSync(file, "utf8").trimEnd().split(/\r?\n/).length;
const modules = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? modules(join(directory, entry.name))
    : entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts") ? [join(directory, entry.name)] : []
  );

describe("authoritative timing module ownership budgets", () => {
  it.each(["server\\src\\match.ts", "client\\pixi\\TableRenderer.ts"])(
    "keeps the %s composition facade within 800 lines",
    (file) => expect(lines(join(root, ...file.split("\\"))), file).toBeLessThanOrEqual(800)
  );

  it("keeps handwritten extracted concerns within 500 lines", () => {
    const directories = [
      "server\\src\\composition", "server\\src\\session", "server\\src\\recovery",
      "server\\src\\timing", "server\\src\\transport", "client\\time", "client\\presentation",
      "client\\pixi\\scene", "client\\pixi\\renderers", "client\\pixi\\results",
      "client\\pixi\\interaction", "client\\pixi\\controls", "client\\pixi\\hud", "client\\pixi\\geometry",
    ];
    const oversized = directories.flatMap((directory) => modules(join(root, ...directory.split("\\"))))
      .filter((file) => lines(file) > 500)
      .map((file) => ({ module: relative(root, file), lines: lines(file) }));
    expect(oversized).toEqual([]);
  });
});
