import { constants } from "node:fs";
import { copyFile, cp, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const APP_NAME = "Multi-Agent Office";
export const LEGACY_APP_NAME = "multi-agent-pi-mvp";

export type UserDataDirectory = {
  path: string;
  overridden: boolean;
};

export function selectUserDataDirectory(
  appDataRoot: string,
  arguments_: readonly string[],
  workingDirectory = process.cwd(),
): UserDataDirectory {
  const override = userDataOverride(arguments_);
  if (override) {
    return {
      path: resolve(workingDirectory, override),
      overridden: true,
    };
  }
  return {
    path: join(appDataRoot, APP_NAME),
    overridden: false,
  };
}

export async function migrateLegacyUserData(
  appDataRoot: string,
  userDataRoot: string,
): Promise<string[]> {
  const legacyRoot = join(appDataRoot, LEGACY_APP_NAME);
  if (
    resolve(legacyRoot) === resolve(userDataRoot) ||
    !(await isDirectory(legacyRoot))
  ) {
    return [];
  }

  await mkdir(userDataRoot, { recursive: true });
  const migrated: string[] = [];
  for (const fileName of ["config.env", "desktop.log"]) {
    if (
      await copyFileIfMissing(
        join(legacyRoot, fileName),
        join(userDataRoot, fileName),
      )
    ) {
      migrated.push(fileName);
    }
  }

  const legacyData = join(legacyRoot, "data");
  const currentData = join(userDataRoot, "data");
  if ((await isDirectory(legacyData)) && !(await pathExists(currentData))) {
    await cp(legacyData, currentData, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    migrated.push("data");
  }
  return migrated;
}

function userDataOverride(arguments_: readonly string[]): string | undefined {
  const prefix = "--user-data-dir=";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument?.startsWith(prefix)) {
      return argument.slice(prefix.length) || undefined;
    }
    if (argument === "--user-data-dir") {
      return arguments_[index + 1] || undefined;
    }
  }
  return undefined;
}

async function copyFileIfMissing(
  source: string,
  destination: string,
): Promise<boolean> {
  if (!(await isFile(source)) || (await pathExists(destination))) return false;
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  return true;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
