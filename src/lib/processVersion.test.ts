import { describe, expect, it } from "vitest";
import { GENERIC_PROCESS_SUGGESTIONS, GENERIC_PROCESS_VERSION } from "../data/eventTypes";
import { resolveProcessVersion } from "./processVersion";

describe("resolveProcessVersion", () => {
  it("uses the fixed Generic version for every Generic process regardless of receiver versions or overrides", () => {
    for (const processName of GENERIC_PROCESS_SUGGESTIONS) {
      for (const supportedProcesses of [
        [],
        [{ processName, processVersion: "8.7.6" }],
        [{ processName, processVersion: "8.7.6" }, { processName, processVersion: "9.0.0" }],
      ]) {
        expect(resolveProcessVersion("generic", processName, supportedProcesses, "4.2.0", "9.9.9"))
          .toEqual({ availableVersions: [GENERIC_PROCESS_VERSION], processVersion: GENERIC_PROCESS_VERSION });
      }
    }
  });

  it("preserves receiver versions, deduplication, fallback, and overrides for Data events", () => {
    const supportedProcesses = [
      { processName: "invoice", processVersion: "5.2.0" },
      { processName: "invoice", processVersion: "5.3.0" },
      { processName: "invoice", processVersion: "5.2.0" },
      { processName: "contract", processVersion: "99.0.0" },
    ];

    expect(resolveProcessVersion("data", "invoice", supportedProcesses, "1.0.0", null))
      .toEqual({ availableVersions: ["5.2.0", "5.3.0"], processVersion: "5.2.0" });
    expect(resolveProcessVersion("data", "invoice", supportedProcesses, "1.0.0", "5.3.0").processVersion)
      .toBe("5.3.0");
    expect(resolveProcessVersion("data", "invoice", [], "1.0.0", null))
      .toEqual({ availableVersions: ["1.0.0"], processVersion: "1.0.0" });
  });
});
