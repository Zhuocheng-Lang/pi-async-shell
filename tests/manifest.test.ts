import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The checkout that owns the manifest. The suite runs from the source tree, so
 * this is the manifest that reaches the registry.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Manifest = {
  name?: string;
  repository?: { url?: string };
  pi?: { image?: string };
};

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Manifest;
}

/** The owner and repository name of a GitHub URL, in any of its spellings. */
function githubRepo(url: string): { owner: string; repo: string } | null {
  const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/.exec(url);
  return match ? { owner: match[1], repo: match[2] } : null;
}

test("the manifest declares a gallery preview for pi.dev", (t) => {
  const image = manifest().pi?.image;

  // The gallery reads this field and nothing else. Without it the icon sits in
  // docs/assets unpublished, which is what 0.2.1 did: the logo was public and
  // pi.dev still drew the placeholder frame.
  assert.equal(typeof image, "string", "package.json declares no pi.image, so pi.dev draws the placeholder frame");
  const url = image as string;
  assert.ok(URL.canParse(url), "pi.image is not an absolute URL: " + url);

  // pi.dev hands the value to the browser unchanged, so a relative path would
  // resolve against pi.dev itself and fail there.
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "https:", "pi.image must be an https URL: " + url);

  // A raw.githubusercontent.com preview names a file in a branch, so a moved or
  // renamed logo publishes an icon that answers 404. Resolve the repository's
  // own previews against the checkout; another repository's files are out of
  // reach, and a CDN or jsdelivr URL needs no local check.
  if (parsed.hostname !== "raw.githubusercontent.com") {
    t.diagnostic("pi.image is served from " + parsed.hostname + ", not checked against the checkout");
    return;
  }

  const [owner, repo, , ...file] = parsed.pathname.split("/").slice(1);
  const self = githubRepo(manifest().repository?.url ?? "");
  if (!self || owner !== self.owner || repo !== self.repo) return;

  assert.notEqual(file.length, 0, "pi.image names no file: " + url);
  const path = file.join("/");
  assert.ok(existsSync(join(ROOT, path)), "pi.image points at " + path + ", which is not in the checkout");
});
