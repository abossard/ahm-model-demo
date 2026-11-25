import { describe, expect, it } from "vitest";
import { hash, mulberry32 } from "./rng";

describe("mulberry32", () => {
  it("gives the same sequence for the same seed", () => {
    const [a, b] = [mulberry32(42), mulberry32(42)];
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
  });

  it.each([0, 1, 42, 2 ** 32 - 1, -7])("stays in [0, 1) for seed %i", (seed) => {
    const next = mulberry32(seed);
    for (let i = 0; i < 100; i++) expect(next()).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 100; i++) expect(next()).toBeLessThan(1);
  });

  it("differs between seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("hash", () => {
  it.each<[Array<string | number>, Array<string | number>, boolean]>([
    [["kiln", "ice", 3], ["kiln", "ice", 3], true],
    [["kiln", "ice", 3], ["kiln", "ice", 4], false],
    [["kiln", "ice", 3], ["ice", "kiln", 3], false],
  ])("%j against %j equal: %s", (a, b, equal) => {
    expect(hash(...a) === hash(...b)).toBe(equal);
  });

  it("is a 32-bit unsigned integer", () => {
    expect(hash("vesper", "gel", 30)).toBeGreaterThanOrEqual(0);
    expect(hash("vesper", "gel", 30)).toBeLessThan(2 ** 32);
  });
});
