import { describe, expect, it } from "vitest";
import { isGenericPayloadObject, synchronizeGenericProcessIdentificationNo } from "./processIdentification";

describe("Generic processIdentificationNo synchronization", () => {
  it("adds or replaces the root property without changing other payload values", () => {
    const result = synchronizeGenericProcessIdentificationNo(
      JSON.stringify({ processIdentificationNo: "old", nested: { unchanged: true } }),
      "new-process-id",
    );
    expect(result.isObject).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ processIdentificationNo: "new-process-id", nested: { unchanged: true } });
  });

  it("leaves arrays, scalars, invalid JSON, and binary-like text untouched", () => {
    for (const text of ["[]", "null", "42", "not json", "\u0000\u0001"]) {
      expect(isGenericPayloadObject(text)).toBe(false);
      expect(synchronizeGenericProcessIdentificationNo(text, "new-id")).toEqual({ text, isObject: false });
    }
  });
});
