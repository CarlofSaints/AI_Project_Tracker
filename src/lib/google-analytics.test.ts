import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReports } from "./google-analytics.ts";

test("reads totals and rankings in report order", () => {
  const report = parseReports([
    { rows: [{ metricValues: ["10", "12", "30", "95.5", "0.4"].map((value) => ({ value })) }] },
    { rows: [{ dimensionValues: [{ value: "/" }], metricValues: [{ value: "20" }] }] },
    { rows: [{ dimensionValues: [{ value: "google" }], metricValues: [{ value: "7" }] }] },
  ]);
  assert.equal(report.visitors, 10);
  assert.equal(report.avgSessionSeconds, 95.5);
  assert.deepEqual(report.topPages, [{ label: "/", value: 20 }]);
  assert.deepEqual(report.topSources, [{ label: "google", value: 7 }]);
});

test("a property with no visits has no rows, and reads as zero", () => {
  const report = parseReports([{}, {}, {}]);
  assert.equal(report.sessions, 0);
  assert.deepEqual(report.topPages, []);
});
