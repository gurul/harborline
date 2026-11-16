#!/usr/bin/env node
/**
 * Camp Fire scorecard, computed from the replay's test results.
 *
 * Every docs/BENCHMARK.md criterion has tests in
 * evals/src/real2sim-campfire.test.ts named "criterion N <verdict>: …", where
 * <verdict> is `met`, `partial` or `out of scope`. A criterion counts as met
 * only when all of its tests are `met` and all of them passed.
 *
 *   npm run scorecard                    prints SCORECARD met=<n> of <m>
 *   npm run scorecard -- --verify-docs   also checks README.md and
 *                                        docs/BENCHMARK.md state that count,
 *                                        and that each scorecard row's verdict
 *                                        matches the tests; prints
 *                                        SCORECARD_DOCS_MATCH and exits 0 only
 *                                        when they do
 *
 * Needs built workspaces (`npm run build`): the replay imports their dist.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPLAY = "src/real2sim-campfire.test.ts";
const TITLE = /^criterion (\d+) (met|partial|out of scope):/;
const DOC_SCORE = /\*\*(\d+) of (\d+) criteria met\*\*/g;
const VERDICT_LABEL = { met: "Met", partial: "Partial", "out of scope": "Out of scope" };

function runReplay() {
  const dir = mkdtempSync(join(tmpdir(), "harborline-scorecard-"));
  const out = join(dir, "replay.json");
  try {
    const vitest = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
    // Exit status is ignored on purpose: a failing criterion test is a result
    // to count, not a reason to stop counting.
    const run = spawnSync(vitest, ["run", REPLAY, "--reporter=json", `--outputFile=${out}`], {
      cwd: join(ROOT, "evals"),
      encoding: "utf8",
    });
    try {
      return JSON.parse(readFileSync(out, "utf8"));
    } catch (err) {
      process.stderr.write(run.stderr ?? "");
      throw err;
    }
  } catch (err) {
    console.error(`scorecard: could not read the replay results (${err instanceof Error ? err.message : err}). Run \`npm run build\` first.`);
    process.exit(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function criteriaFrom(report) {
  const criteria = new Map();
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      const match = TITLE.exec(test.title);
      if (!match) continue;
      const n = Number(match[1]);
      const entry = criteria.get(n) ?? { verdicts: new Set(), passed: true };
      entry.verdicts.add(match[2]);
      if (test.status !== "passed") entry.passed = false;
      criteria.set(n, entry);
    }
  }
  return criteria;
}

/** The verdict the docs must show: a failing `met` test is not met. */
function effectiveVerdict(entry) {
  if (entry.verdicts.has("out of scope")) return "out of scope";
  if (entry.verdicts.has("partial")) return "partial";
  return entry.passed ? "met" : "not met";
}

function verifyDocs(met, total, verdicts) {
  const problems = [];
  for (const doc of ["README.md", "docs/BENCHMARK.md"]) {
    const text = readFileSync(join(ROOT, doc), "utf8");
    const stated = [...text.matchAll(DOC_SCORE)];
    if (stated.length === 0) problems.push(`${doc}: no "**<n> of <m> criteria met**" statement`);
    for (const [phrase, n, m] of stated) {
      if (Number(n) !== met || Number(m) !== total) {
        problems.push(`${doc}: states ${phrase}, tests compute ${met} of ${total}`);
      }
    }
  }

  const benchmark = readFileSync(join(ROOT, "docs/BENCHMARK.md"), "utf8");
  for (const [n, verdict] of verdicts) {
    const row = benchmark.split("\n").find((line) => new RegExp(`^\\|\\s*${n}\\s*\\|`).test(line));
    if (!row) {
      problems.push(`docs/BENCHMARK.md: no scorecard row for criterion ${n}`);
      continue;
    }
    const cell = row.split("|")[3]?.trim() ?? "";
    const label = verdict === "not met" ? "Not met" : VERDICT_LABEL[verdict];
    if (!cell.startsWith(`**${label}`)) {
      problems.push(`docs/BENCHMARK.md: criterion ${n} row says "${cell}", tests say ${verdict}`);
    }
  }
  return problems;
}

const criteria = criteriaFrom(runReplay());
if (criteria.size === 0) {
  console.error("scorecard: the replay reported no criterion tests");
  process.exit(2);
}
const verdicts = [...criteria.entries()].sort(([a], [b]) => a - b).map(([n, e]) => [n, effectiveVerdict(e)]);
const met = verdicts.filter(([, v]) => v === "met").length;
const total = verdicts.length;
for (const [n, verdict] of verdicts) console.log(`criterion ${n}: ${verdict}`);
console.log(`SCORECARD met=${met} of ${total}`);

if (process.argv.includes("--verify-docs")) {
  const problems = verifyDocs(met, total, verdicts);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error("SCORECARD_DOCS_MISMATCH");
    process.exit(1);
  }
  console.log("SCORECARD_DOCS_MATCH");
}
