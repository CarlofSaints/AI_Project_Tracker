import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { getAccessToken, parseReports } from "./google-analytics.ts";

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

test("signs a JWT Google can verify, and rejects a file that is not a service-account key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_ANALYTICS_CREDENTIALS = JSON.stringify({
    client_email: "tracker@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  let assertion = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
    return new Response(JSON.stringify({ access_token: "token" }));
  }) as typeof fetch;

  assert.equal(await getAccessToken(), "token");
  const [header, claims, signature] = assertion.split(".");
  const verified = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url");
  assert.equal(verified, true);

  process.env.GOOGLE_ANALYTICS_CREDENTIALS = JSON.stringify({ web: {} });
  await assert.rejects(getAccessToken, /not a service-account key/);
});
