import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const files = ["README.md", ...readdirSync(join(root, "docs"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => join("docs", file))];
const blockPattern = /^```mermaid[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
const blocks = [];

for (const file of files) {
  const source = readFileSync(join(root, file), "utf8");
  let match;
  let index = 0;
  while ((match = blockPattern.exec(source)) !== null) {
    blocks.push({ file, index: ++index, source: match[1] });
  }
}

const temp = mkdtempSync(join(tmpdir(), "hive-mermaid-"));
const puppeteerConfig = join(temp, "puppeteer.json");
writeFileSync(puppeteerConfig, JSON.stringify({ args: ["--no-sandbox", "--disable-setuid-sandbox"] }));
let failed = false;

try {
  for (const [position, block] of blocks.entries()) {
    const input = join(temp, `${position}.mmd`);
    const output = join(temp, `${position}.svg`);
    writeFileSync(input, block.source);
    const result = spawnSync("npx", ["--yes", "@mermaid-js/mermaid-cli@11", "-p", puppeteerConfig, "-i", input, "-o", output, "-q"], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status === 0) {
      console.log(`${block.file} block ${block.index}: ok`);
      continue;
    }

    failed = true;
    const error = (result.stderr || result.stdout || result.error?.message || "unknown error")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(0, 4)
      .join(" | ")
      .trim()
      .slice(0, 400) || "unknown error";
    console.log(`${block.file} block ${block.index}: FAIL: ${error}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
