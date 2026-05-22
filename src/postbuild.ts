import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PostbuildOptions {
  projectDir?: string;
  distDir?: string;
}

export interface PostbuildResult {
  standaloneDir: string;
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

/**
 * Run after `next build`. Next.js standalone output intentionally omits
 * public/ and .next/static, but its server expects them at standard
 * paths relative to .next/standalone/server.js.
 */
export async function runPostbuild(
  options: PostbuildOptions = {},
): Promise<PostbuildResult> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const distDir = path.resolve(projectDir, options.distDir ?? ".next");
  const standaloneDir = path.join(distDir, "standalone");

  if (!(await pathExists(path.join(standaloneDir, "server.js")))) {
    throw new Error(
      `adapter-creekd postbuild: missing ${path.relative(projectDir, path.join(standaloneDir, "server.js"))}; run next build with adapter-creekd first`,
    );
  }

  const result: PostbuildResult = {
    standaloneDir,
    copied: [],
    skipped: [],
  };

  await copyDirectoryIfExists(
    path.join(projectDir, "public"),
    path.join(standaloneDir, "public"),
    "public",
    result,
  );
  await copyDirectoryIfExists(
    path.join(distDir, "static"),
    path.join(standaloneDir, ".next", "static"),
    ".next/static",
    result,
  );

  return result;
}
