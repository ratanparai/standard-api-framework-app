import { GENERIC_PROCESS_VERSION } from "../data/eventTypes";
import type { EventKind } from "../data/eventTypes";

type SupportedProcess = { processName: string; processVersion?: string };

export function resolveProcessVersion(
  eventKind: EventKind,
  processName: string,
  supportedProcesses: readonly SupportedProcess[],
  fallbackVersion: string,
  versionOverride: string | null,
): { availableVersions: string[]; processVersion: string } {
  if (eventKind === "generic") {
    return { availableVersions: [GENERIC_PROCESS_VERSION], processVersion: GENERIC_PROCESS_VERSION };
  }

  const versions = supportedProcesses
    .filter((process) => process.processName === processName && process.processVersion)
    .map((process) => process.processVersion!);
  const unique = Array.from(new Set(versions));
  const availableVersions = unique.length ? unique : [fallbackVersion];
  return { availableVersions, processVersion: versionOverride ?? availableVersions[0] };
}
