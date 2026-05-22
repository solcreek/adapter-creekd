import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PostbuildOptions {
  projectDir?: string;
  distDir?: string;
}

export interface PostbuildResult {
  standaloneDir: string;
  serverDir: string;
  serverFile: string;
  copied: string[];
  skipped: string[];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryIfExists(
  from: string,
  to: string,
  label: string,
  result: PostbuildResult,
): Promise<void> {
  if (!(await pathExists(from))) {
    result.skipped.push(label);
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true, force: true });
  result.copied.push(label);
}

async function copyFileIfExists(
  from: string,
  to: string,
  label: string,
  result: PostbuildResult,
): Promise<void> {
  if (!(await pathExists(from))) {
    result.skipped.push(label);
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  result.copied.push(label);
}

async function copyNodeModuleIfExists(
  projectDir: string,
  serverDir: string,
  moduleName: string,
  label: string,
  result: PostbuildResult,
): Promise<void> {
  const sourceModuleDir = path.join(projectDir, "node_modules", moduleName);
  if (!(await pathExists(sourceModuleDir))) {
    result.skipped.push(label);
    return;
  }

  const sourceDir = await fs.realpath(sourceModuleDir);
  const targetDir = path.join(serverDir, "node_modules", moduleName);

  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    dereference: true,
  });
  result.copied.push(label);
}

async function copyLinkedPackageRuntime(
  sourceParentModulesDir: string,
  targetParentModulesDir: string,
  moduleName: string,
): Promise<boolean> {
  const sourceModulePath = path.join(sourceParentModulesDir, moduleName);
  if (!(await pathExists(sourceModulePath))) return false;

  const targetModulePath = path.join(targetParentModulesDir, moduleName);
  const targetLink = await fs.readlink(targetModulePath).catch(() => null);
  const sourceRuntimeDir = path.dirname(await fs.realpath(sourceModulePath));
  const targetRuntimeDir = targetLink
    ? path.dirname(path.resolve(targetParentModulesDir, targetLink))
    : targetParentModulesDir;

  if (!targetLink && !(await pathExists(targetRuntimeDir))) return false;

  await fs.mkdir(targetRuntimeDir, { recursive: true });
  await fs.cp(sourceRuntimeDir, targetRuntimeDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    dereference: true,
  });
  return true;
}

async function copySharpIfExists(
  projectDir: string,
  serverDir: string,
  result: PostbuildResult,
): Promise<void> {
  const sourceNextDir = path.join(projectDir, "node_modules", "next");
  const targetNextDir = path.join(serverDir, "node_modules", "next");
  if (await pathExists(sourceNextDir)) {
    const copiedFromNextRuntime = await copyLinkedPackageRuntime(
      path.dirname(await fs.realpath(sourceNextDir)),
      path.dirname(await realpathOrSelf(targetNextDir)),
      "sharp",
    );
    if (copiedFromNextRuntime) {
      result.copied.push("node_modules/sharp");
      return;
    }
  }

  const sourceNodeModulesDir = path.join(projectDir, "node_modules");
  const sourceSharpDir = path.join(sourceNodeModulesDir, "sharp");
  if (!(await pathExists(sourceSharpDir))) {
    result.skipped.push("node_modules/sharp");
    return;
  }
  await copyNodeModuleIfExists(
    projectDir,
    serverDir,
    "sharp",
    "node_modules/sharp",
    result,
  );

  const packageJsonPath = path.join(sourceSharpDir, "package.json");
  let packageJson: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } = {};
  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  } catch {
    return;
  }

  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];

  for (const dependencyName of dependencyNames) {
    if (!dependencyName.startsWith("@img/") && dependencyName !== "detect-libc") {
      continue;
    }
    const sourceDependencyDir = path.join(sourceNodeModulesDir, dependencyName);
    if (!(await pathExists(sourceDependencyDir))) continue;
    const targetDependencyDir = path.join(serverDir, "node_modules", dependencyName);
    if (await pathExists(targetDependencyDir)) continue;
    await fs.mkdir(path.dirname(targetDependencyDir), { recursive: true });
    await fs.cp(await fs.realpath(sourceDependencyDir), targetDependencyDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
      dereference: true,
    });
  }
}

async function copyBuildCacheIfExists(
  distDir: string,
  serverDir: string,
  result: PostbuildResult,
): Promise<void> {
  await copyDirectoryIfExists(
    path.join(distDir, "cache", "creekd"),
    path.join(serverDir, ".next", "cache", "creekd"),
    ".next/cache/creekd",
    result,
  );
}

async function realpathOrSelf(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return filePath;
  }
}

async function copyNextRuntimeIfIncomplete(
  projectDir: string,
  serverDir: string,
  result: PostbuildResult,
): Promise<void> {
  const sourceNextDir = path.join(projectDir, "node_modules", "next");
  if (!(await pathExists(sourceNextDir))) {
    result.skipped.push("node_modules/next");
    return;
  }

  const targetNextDir = path.join(serverDir, "node_modules", "next");
  const sourceRuntimeDir = path.dirname(await fs.realpath(sourceNextDir));
  const targetRuntimeDir = path.dirname(await realpathOrSelf(targetNextDir));

  const requiredRuntimeFiles = [
    path.join("next", "dist", "server", "next.js"),
    path.join("@next", "env", "package.json"),
  ];
  const isComplete = await Promise.all(
    requiredRuntimeFiles.map((file) => pathExists(path.join(targetRuntimeDir, file))),
  );
  if (isComplete.every(Boolean)) {
    result.skipped.push("node_modules/next");
    return;
  }

  await fs.mkdir(targetRuntimeDir, { recursive: true });
  await fs.cp(sourceRuntimeDir, targetRuntimeDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    dereference: true,
  });
  result.copied.push("node_modules/next");
}

async function findStandaloneServerFile(standaloneDir: string): Promise<string | null> {
  const standardServerFile = path.join(standaloneDir, "server.js");
  if (await pathExists(standardServerFile)) return standardServerFile;

  const matches: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name === "server.js") {
        matches.push(entryPath);
      }
    }
  }

  await visit(standaloneDir);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `adapter-creekd postbuild: found multiple standalone server.js files: ${matches.map((match) => path.relative(standaloneDir, match)).join(", ")}`,
    );
  }
  return matches[0];
}

/**
 * Run after `next build`. Next.js standalone output intentionally omits
 * public/ and .next/static, but its server expects them at standard
 * paths relative to .next/standalone/server.js. Turbopack adapter builds
 * can also miss the root Next.js runtime trace, so we fill missing Next.js
 * runtime files from the project-local install without overwriting traced files.
 * The creekd cache handler also seeds prerender/cache entries during build;
 * copy the default cache tree so standalone runtime sees the same L2 state.
 */
export async function runPostbuild(
  options: PostbuildOptions = {},
): Promise<PostbuildResult> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const distDir = path.resolve(projectDir, options.distDir ?? ".next");
  const standaloneDir = path.join(distDir, "standalone");
  const serverFile = await findStandaloneServerFile(standaloneDir);

  if (!serverFile) {
    throw new Error(
      `adapter-creekd postbuild: missing ${path.relative(projectDir, path.join(standaloneDir, "server.js"))}; run next build with adapter-creekd first`,
    );
  }
  const serverDir = path.dirname(serverFile);

  const result: PostbuildResult = {
    standaloneDir,
    serverDir,
    serverFile,
    copied: [],
    skipped: [],
  };

  await copyDirectoryIfExists(
    path.join(projectDir, "public"),
    path.join(serverDir, "public"),
    "public",
    result,
  );
  await copyDirectoryIfExists(
    path.join(distDir, "static"),
    path.join(serverDir, ".next", "static"),
    ".next/static",
    result,
  );
  await copyBuildCacheIfExists(distDir, serverDir, result);
  await copyNextRuntimeIfIncomplete(projectDir, serverDir, result);
  await copySharpIfExists(projectDir, serverDir, result);
  await copyFileIfExists(
    path.join(projectDir, ".solcreek-creekd-cache-handler.mjs"),
    path.join(serverDir, ".solcreek-creekd-cache-handler.mjs"),
    "cache-handler",
    result,
  );
  await copyFileIfExists(
    path.join(projectDir, ".solcreek-creekd-use-cache-handler.mjs"),
    path.join(serverDir, ".solcreek-creekd-use-cache-handler.mjs"),
    "use-cache-handler",
    result,
  );

  return result;
}
