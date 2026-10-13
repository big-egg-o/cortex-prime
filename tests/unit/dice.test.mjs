import { describe, expect, it } from "vitest";
import { stepDie } from "../../module/rules/dice.mjs";

describe("stepDie", () => {
  it("DP-01 steps every size up by one", () => {
    expect(stepDie(4, 1)).toEqual({ size: 6 });
    expect(stepDie(6, 1)).toEqual({ size: 8 });
    expect(stepDie(8, 1)).toEqual({ size: 10 });
    expect(stepDie(10, 1)).toEqual({ size: 12 });
  });

  it("DP-02 steps every size down by one, removing a stepped-down d4", () => {
    expect(stepDie(12, -1)).toEqual({ size: 10 });
    expect(stepDie(10, -1)).toEqual({ size: 8 });
    expect(stepDie(8, -1)).toEqual({ size: 6 });
    expect(stepDie(6, -1)).toEqual({ size: 4 });
    expect(stepDie(4, -1)).toEqual({ removed: true });
  });

  it("DP-03 applies several steps one at a time", () => {
    expect(stepDie(6, 2)).toEqual({ size: 10 });
    expect(stepDie(8, -3)).toEqual({ removed: true });
  });

  it("DP-04 reports how far a bare size steps beyond d12, instead of a size", () => {
    expect(stepDie(12, 1)).toEqual({ size: 12, beyond: 1 });
    expect(stepDie(10, 2)).toEqual({ size: 12, beyond: 1 });
  });
});
