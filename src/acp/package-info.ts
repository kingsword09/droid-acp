import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

function readPackageJson(): { name: string; version: string } {
  const candidates = ["../../package.json", "../package.json", "./package.json"];
  for (const specifier of candidates) {
    try {
      const pkg = nodeRequire(specifier) as { name?: unknown; version?: unknown };
      const name = typeof pkg.name === "string" ? pkg.name : null;
      const version = typeof pkg.version === "string" ? pkg.version : null;
      if (name && version) return { name, version };
    } catch {
      // ignore and try next
    }
  }

  const envName =
    typeof process.env.npm_package_name === "string" ? process.env.npm_package_name : null;
  const envVersion =
    typeof process.env.npm_package_version === "string" ? process.env.npm_package_version : null;
  return {
    name: envName ?? "droid-acp",
    version: envVersion ?? "unknown",
  };
}

const packageJson = readPackageJson();

export const packageInfo = {
  name: packageJson.name,
  version: packageJson.version,
} as const;
