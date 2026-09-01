import { appendFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const NOTICE_START = "/*! Shorthand third-party license notices";
const LICENSE_FILES = /^licen[sc]e(?:\.|$)/i;

// This package is published from the same Vercel AI SDK repository under the
// same Apache-2.0 license, but its npm tarball omits the repository's LICENSE.
// Name that packaging exception exactly; a general SPDX fallback could silently
// substitute the wrong copyright notice for a future dependency.
const LICENSE_FALLBACKS = new Map([
  ["@ai-sdk/provider-utils", "node_modules/@ai-sdk/provider/LICENSE"],
]);

function packageRootForInput(input) {
  const parts = input.replaceAll("\\", "/").split("/");
  const nodeModules = parts.lastIndexOf("node_modules");
  if (nodeModules < 0 || nodeModules + 1 >= parts.length) return undefined;
  const first = parts[nodeModules + 1];
  if (first.startsWith("@")) {
    const second = parts[nodeModules + 2];
    if (second === undefined) return undefined;
    return parts.slice(0, nodeModules + 3).join("/");
  }
  return parts.slice(0, nodeModules + 2).join("/");
}

function repositoryUrl(repository) {
  if (typeof repository === "string") return repository;
  if (repository !== null && typeof repository === "object" && typeof repository.url === "string") {
    return repository.url;
  }
  return undefined;
}

async function licensePath(packageRoot, packageName) {
  const files = await readdir(resolve(packageRoot));
  const license = files.find((file) => LICENSE_FILES.test(file));
  if (license !== undefined) return resolve(packageRoot, license);
  const fallback = LICENSE_FALLBACKS.get(packageName);
  if (fallback !== undefined) return resolve(fallback);
  throw new Error(`Bundled dependency ${packageName} has no license file; add an explicit, reviewed fallback.`);
}

async function bundledPackages(metafile) {
  const roots = new Set(
    Object.keys(metafile.inputs)
      .map(packageRootForInput)
      .filter((root) => root !== undefined),
  );
  const packages = [];
  for (const root of [...roots].sort()) {
    const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
      throw new Error(`Bundled package metadata at ${root} has no string name and version.`);
    }
    const metadataFields = [metadata.name, metadata.version, metadata.license, repositoryUrl(metadata.repository)];
    if (metadataFields.some((field) => typeof field === "string" && field.includes("*/"))) {
      throw new Error(`Bundled package metadata for ${metadata.name} cannot be embedded safely in a JavaScript comment.`);
    }
    const path = await licensePath(root, metadata.name);
    const licenseText = (await readFile(path, "utf8")).replaceAll("\r\n", "\n").trim();
    if (licenseText.includes("*/")) {
      throw new Error(`License for ${metadata.name} cannot be embedded safely in a JavaScript comment.`);
    }
    packages.push({
      name: metadata.name,
      version: metadata.version,
      declaredLicense: typeof metadata.license === "string" ? metadata.license : "See included license text",
      repository: repositoryUrl(metadata.repository),
      licenseText,
    });
  }
  return packages;
}

function renderNotice(packages) {
  const licenseGroups = new Map();
  for (const dependency of packages) {
    const group = licenseGroups.get(dependency.licenseText) ?? [];
    group.push(`${dependency.name}@${dependency.version}`);
    licenseGroups.set(dependency.licenseText, group);
  }
  const inventory = packages.map((dependency) => {
    const source = dependency.repository === undefined ? "" : ` — ${dependency.repository}`;
    return `- ${dependency.name}@${dependency.version} — ${dependency.declaredLicense}${source}`;
  });
  const licenses = [...licenseGroups.entries()].map(([text, components]) => [
    `License text for: ${components.join(", ")}`,
    "-".repeat(72),
    text,
  ].join("\n"));
  return [
    "",
    NOTICE_START,
    "",
    "This generated notice covers every third-party package included by esbuild.",
    "The Shorthand plugin's own source is licensed separately in the repository LICENSE.",
    "",
    "Bundled components:",
    ...inventory,
    "",
    ...licenses.flatMap((license) => [license, ""]),
    "*/",
    "",
  ].join("\n");
}

export const thirdPartyLicenses = {
  name: "third-party-licenses",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      if (result.metafile === undefined) throw new Error("third-party-licenses requires esbuild metafile output.");
      const packages = await bundledPackages(result.metafile);
      if (packages.length === 0) throw new Error("The bundle contained no third-party packages to license.");
      await appendFile(resolve("main.js"), renderNotice(packages), "utf8");
    });
  },
};
