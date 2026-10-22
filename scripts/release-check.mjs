import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseVersion(tag, pkg, lock) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error(
      "Release tags must use vMAJOR.MINOR.PATCH (no prerelease suffix).",
    );
  }
  const version = tag.slice(1);
  if (
    [pkg.version, lock.version, lock.packages?.[""]?.version].some(
      (v) => v !== version,
    )
  ) {
    throw new Error(
      "Release tag must match package.json and both package-lock.json versions.",
    );
  }
  return version;
}

// Only an explicit registry 404 permits publication. Authentication, rate-limit,
// and transport failures must never be mistaken for an unused version tag.
export async function assertTagAvailable(
  image,
  username,
  password,
  fetchImpl = fetch,
) {
  const match = /^ghcr\.io\/(suciudan\/crashguard):(\d+\.\d+\.\d+)$/.exec(
    image,
  );
  if (!match) throw new Error("Expected a versioned CrashGuard GHCR image.");
  if (!username || !password)
    throw new Error("Registry credentials are required.");
  const [, repository, tag] = match;
  const scope = encodeURIComponent(`repository:${repository}:pull`);
  const auth = await fetchImpl(
    `https://ghcr.io/token?service=ghcr.io&scope=${scope}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!auth.ok)
    throw new Error(`Registry authorization failed (HTTP ${auth.status}).`);
  const { token } = await auth.json();
  if (typeof token !== "string" || !token)
    throw new Error("Registry authorization returned no token.");
  const manifest = await fetchImpl(
    `https://ghcr.io/v2/${repository}/manifests/${tag}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (manifest.status === 404) return;
  if (manifest.ok)
    throw new Error(
      `Version ${tag} already exists; publish a new version instead.`,
    );
  throw new Error(
    `Cannot establish whether the tag exists (HTTP ${manifest.status}).`,
  );
}

async function main() {
  if (process.argv[2] === "version") {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    console.log(releaseVersion(process.argv[3] || "", pkg, lock));
  } else if (process.argv[2] === "available") {
    await assertTagAvailable(
      process.argv[3] || "",
      process.env.GITHUB_ACTOR,
      process.env.REGISTRY_TOKEN,
    );
  } else {
    throw new Error(
      "Usage: node scripts/release-check.mjs version TAG | available IMAGE",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Release validation failed.",
    );
    process.exitCode = 1;
  });
}
