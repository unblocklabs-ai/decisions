import { readFileSync } from "node:fs";

const tag = process.env.RELEASE_TAG?.trim();
if (!tag) {
  console.error("RELEASE_TAG is required");
  process.exit(1);
}
const expected = tag.replace(/^v/u, "");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.version !== expected) {
  console.error(`package.json version (${pkg.version}) does not match release tag (${tag})`);
  process.exit(1);
}
console.log(`Release version matches: ${pkg.version}`);
