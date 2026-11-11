import { describe, expect, it } from "vitest";
import { formatSignalValue } from "./signalValue";

describe("formatSignalValue", () => {
  it.each([
    [null, ""],
    [0, "0"],
    [100, "100"],
    [15069, "15069"],
    [0.5, "0.5"],
    [8.24, "8.24"],
    [4.090909090909091, "4.091"],
    [11.4285714285714, "11.429"],
    [123456.789012, "123456.789"],
    [0.000123456, "0.000123"],
    [0.33333333, "0.333"],
    [-2.71828, "-2.718"],
    ["healthy", "healthy"],
    ["4.090909090909091", "4.090909090909091"],
    [Number.POSITIVE_INFINITY, "Infinity"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatSignalValue(value)).toBe(expected);
  });
});
