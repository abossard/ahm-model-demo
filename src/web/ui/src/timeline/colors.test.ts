// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { healthVariables } from "../model/palette";
import type { ThemeName } from "../model/theme";
import { readColors } from "./colors";

describe("timeline colours", () => {
  it.each(["light", "dark"] as const satisfies readonly ThemeName[])("follow the %s palette of the graphs", (theme) => {
    const host = document.createElement("div");
    for (const [name, value] of Object.entries(healthVariables(theme))) host.style.setProperty(`--${name}`, value);
    document.body.append(host);
    const colors = readColors(host);
    const palette = healthVariables(theme);
    expect(colors.panel).toBe(palette["canvas-bg"]);
    expect(colors.state).toEqual({ 0: palette["unknown-dot"], 1: palette["healthy-dot"], 2: palette["degraded-dot"], 3: palette["unhealthy-dot"], 4: palette["deleted-border"] });
    expect(colors.label[3]).toBe(palette["unhealthy-label"]);
    host.remove();
  });
});
