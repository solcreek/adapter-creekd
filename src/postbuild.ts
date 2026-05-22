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
 * paths relative to .next/standalone/server.js.
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

  return result;
}
