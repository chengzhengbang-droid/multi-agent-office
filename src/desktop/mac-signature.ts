import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export function macApplicationBundlePath(executablePath: string): string {
  return resolve(dirname(executablePath), "../..");
}

export function isDeveloperIdSignedMacApp(appBundlePath: string): boolean {
  const verification = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appBundlePath],
    { encoding: "utf8" },
  );
  if (verification.status !== 0) return false;

  const description = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", appBundlePath],
    { encoding: "utf8" },
  );
  if (description.status !== 0) return false;
  return signatureDetailsIndicateDeveloperId(
    `${description.stdout ?? ""}\n${description.stderr ?? ""}`,
  );
}

export function signatureDetailsIndicateDeveloperId(details: string): boolean {
  return (
    /^Authority=Developer ID Application:/m.test(details) &&
    /^TeamIdentifier=(?!not set\s*$)\S+/m.test(details)
  );
}
