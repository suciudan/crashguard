import { test } from "node:test";
import assert from "node:assert/strict";
import {
  releaseVersion,
  assertTagAvailable,
} from "../scripts/release-check.mjs";

const pkg = { version: "0.1.0" };
const lock = { version: "0.1.0", packages: { "": { version: "0.1.0" } } };
const image = "ghcr.io/suciudan/crashguard:0.1.0";

test("release versions must match both manifests and the root lockfile package", () => {
  assert.equal(releaseVersion("v0.1.0", pkg, lock), "0.1.0");
  for (const tag of [
    "0.1.0",
    "v0.1.0-beta.1",
    "v01.1.0",
    "v0.2.0",
    "v0.1.0\n",
  ]) {
    assert.throws(() => releaseVersion(tag, pkg, lock));
  }
  assert.throws(() => releaseVersion("v0.1.0", { version: "0.2.0" }, lock));
  assert.throws(() =>
    releaseVersion("v0.1.0", pkg, { ...lock, version: "0.2.0" }),
  );
  assert.throws(() => releaseVersion("v0.1.0", pkg, { ...lock, packages: {} }));
});

function registry(status: number) {
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    if (calls === 1) {
      assert.equal(
        String(url),
        "https://ghcr.io/token?service=ghcr.io&scope=repository%3Asuciudan%2Fcrashguard%3Apull",
      );
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        "Basic " + Buffer.from("maintainer:test-token").toString("base64"),
      );
      return Response.json({ token: "scoped-token" });
    }
    assert.equal(calls, 2);
    assert.equal(
      String(url),
      "https://ghcr.io/v2/suciudan/crashguard/manifests/0.1.0",
    );
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      "Bearer scoped-token",
    );
    return new Response(null, { status });
  };
  return request;
}

test("only an authenticated missing manifest permits publication", async () => {
  await assertTagAvailable(image, "maintainer", "test-token", registry(404));
  await assert.rejects(
    assertTagAvailable(image, "maintainer", "test-token", registry(200)),
    /already exists/,
  );
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      assertTagAvailable(image, "maintainer", "test-token", registry(status)),
      /Cannot establish/,
    );
  }
});

test("registry authorization and network failures cannot permit a tag overwrite", async () => {
  await assert.rejects(
    assertTagAvailable(
      image,
      "maintainer",
      "test-token",
      async () => new Response(null, { status: 403 }),
    ),
    /authorization failed/,
  );
  await assert.rejects(
    assertTagAvailable(image, "maintainer", "test-token", async () =>
      Response.json({}),
    ),
    /no token/,
  );
  await assert.rejects(
    assertTagAvailable(image, "maintainer", "test-token", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(assertTagAvailable(image, "", ""), /credentials/);
  await assert.rejects(
    assertTagAvailable(
      "ghcr.io/suciudan/crashguard:latest",
      "maintainer",
      "test-token",
    ),
    /versioned/,
  );
});
