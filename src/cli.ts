#!/usr/bin/env node
import { runPostbuild } from "./postbuild.js";

function usage(): string {
  return [
    "Usage:",
    "  adapter-creekd postbuild [--project-dir <dir>] [--dist-dir <dir>]",
    "",
    "Commands:",
    "  postbuild  Copy public/ and .next/static into .next/standalone/",
  ].join("\n");
}

function readOption(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }

  if (command !== "postbuild") {
    throw new Error(`unknown command ${command}`);
  }

  let projectDir: string | undefined;
  let distDir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--project-dir":
        projectDir = readOption(rest, i, arg);
        i++;
        break;
      case "--dist-dir":
        distDir = readOption(rest, i, arg);
        i++;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        return;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  const result = await runPostbuild({ projectDir, distDir });
  const copied = result.copied.length > 0 ? result.copied.join(", ") : "none";
  const skipped = result.skipped.length > 0 ? `; skipped ${result.skipped.join(", ")}` : "";
  console.log(`adapter-creekd postbuild: copied ${copied}${skipped}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
