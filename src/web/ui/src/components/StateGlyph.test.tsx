import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateGlyph } from "./StateGlyph";
import { Legend } from "./Legend";

describe("StateGlyph", () => {
  // A shape of its own per state: what sets each apart in the markup.
  it.each([
    ["Healthy", /<circle r="7"/, /M-3 0\.3/],
    ["Degraded", /M0 -6\.8 L7\.2 5\.6/, /circle cy="3\.9"/],
    ["Unhealthy", /<rect x="-6\.4"/, /M-2\.6 -2\.6/],
    ["Unknown", /stroke-dasharray="3\.4 2\.6"/, />\?</],
    ["Deleted", /M0 -7\.4 L7\.4 0/, /M0 -7\.4/],
  ] as const)("draws %s with its own shape", (state, first, second) => {
    const markup = renderToStaticMarkup(<StateGlyph state={state} />);
    expect(markup).toMatch(first);
    expect(markup).toMatch(second);
  });

  it("is decorative and takes the colours of the state", () => {
    const markup = renderToStaticMarkup(<StateGlyph state="Degraded" size={20} />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('width="20"');
    expect(markup).toContain("var(--degraded-dot)");
    expect(markup).toContain("var(--degraded-on)");
  });

  it("draws an unknown state as Unknown", () => {
    expect(renderToStaticMarkup(<StateGlyph state="Surprising" />)).toBe(renderToStaticMarkup(<StateGlyph state="Unknown" />));
  });
});

describe("Legend", () => {
  it("names the four states, both impacts and the notes of the view", () => {
    const text = renderToStaticMarkup(<Legend notes={["Width = leaf parts below"]} />);
    for (const word of ["Healthy", "Degraded", "Unhealthy", "Unknown", "Limited impact", "Suppressed", "Width = leaf parts below"]) expect(text).toContain(word);
    expect(text).not.toContain("Added");
  });

  it("adds the diff marks, each with its glyph, while comparing", () => {
    const text = renderToStaticMarkup(<Legend diff />);
    for (const word of ["Added", "Changed", "Removed"]) expect(text).toContain(word);
    for (const glyph of ["+", "≠", "−"]) expect(text).toContain(glyph);
  });
});
