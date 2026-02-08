import fs from "node:fs";
import path from "node:path";

const COVERAGE_SUMMARY_PATH = path.resolve(process.cwd(), "coverage", "coverage-summary.json");
const TARGET_FILE = process.env.SDK_COVERAGE_FILE || "src/index.ts";

const thresholds = {
  lines: Number(process.env.SDK_COVERAGE_LINES || "100"),
  statements: Number(process.env.SDK_COVERAGE_STATEMENTS || "100"),
  branches: Number(process.env.SDK_COVERAGE_BRANCHES || "100"),
  functions: Number(process.env.SDK_COVERAGE_FUNCTIONS || "100"),
};

function fail(message) {
  console.error(`[coverage-gate] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(COVERAGE_SUMMARY_PATH)) {
  fail(`Missing coverage summary at ${COVERAGE_SUMMARY_PATH}. Run coverage first.`);
}

const summary = JSON.parse(fs.readFileSync(COVERAGE_SUMMARY_PATH, "utf8"));
const normalizedTarget = TARGET_FILE.replaceAll("\\", "/");

const entryKey = Object.keys(summary).find((key) => {
  const normalized = key.replaceAll("\\", "/");
  return normalized.endsWith(normalizedTarget);
});

if (!entryKey) {
  fail(`Could not find coverage entry for '${TARGET_FILE}' in ${COVERAGE_SUMMARY_PATH}.`);
}

const entry = summary[entryKey];
const metrics = {
  lines: entry.lines?.pct ?? 0,
  statements: entry.statements?.pct ?? 0,
  branches: entry.branches?.pct ?? 0,
  functions: entry.functions?.pct ?? 0,
};

const failures = Object.entries(thresholds)
  .filter(([metric, threshold]) => metrics[metric] < threshold)
  .map(([metric, threshold]) => `${metric} ${metrics[metric]}% < ${threshold}%`);

console.log(`[coverage-gate] target=${TARGET_FILE}`);
console.log(
  `[coverage-gate] lines=${metrics.lines}% statements=${metrics.statements}% branches=${metrics.branches}% functions=${metrics.functions}%`,
);
console.log(
  `[coverage-gate] thresholds lines=${thresholds.lines}% statements=${thresholds.statements}% branches=${thresholds.branches}% functions=${thresholds.functions}%`,
);

if (failures.length > 0) {
  fail(`Failed: ${failures.join(", ")}`);
}

console.log("[coverage-gate] Passed.");
