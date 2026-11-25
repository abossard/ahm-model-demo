import { execFileSync } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as hold } from "node:timers/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { renderGuide } from "./guide";

/** Record the browser and collect the words a reader can see at each checkpoint. */
export class Capture {
  private recording = false;

  constructor(private readonly page: Page, private readonly staging: string,
    private readonly excerpts: Record<string, string> = {}, private readonly media = new Set<string>()) {}

  /** Each chapter opens its own page. The published guide collects evidence from every chapter. */
  forPage(page: Page) {
    return new Capture(page, this.staging, this.excerpts, this.media);
  }

  async step(id: string, quote: Locator, options: { shot?: Locator } = {}) {
    await expect(quote).toBeVisible();
    const text = (await quote.innerText()).trim();
    if (!text || id in this.excerpts) throw new Error(`Missing or duplicate excerpt: ${id}`);
    this.excerpts[id] = text;
    const filename = `${id}.png`;
    await (options.shot ?? this.page).screenshot({
      path: path.join(this.staging, "media", filename), caret: "hide", scale: "css",
    });
    this.media.add(filename);
    // Give the GIF reader time to see the same view the text describes.
    if (this.recording) await hold(1500);
  }

  async clip(id: string, actions: () => Promise<void>, format: "gif" | "apng" = "gif") {
    const filename = `${id}.${format}`;
    if (this.recording || this.media.has(filename)) throw new Error(`Overlapping or duplicate clip: ${id}`);
    const video = path.join(this.staging, "..", `${id}.webm`);
    await this.page.screencast.start({ path: video, size: this.page.viewportSize()!, quality: 95 });
    this.recording = true;
    try {
      await hold(1200);
      await actions();
      await hold(1700);
    } finally {
      this.recording = false;
      await this.page.screencast.stop();
    }
    const encoding = format === "gif" ? ["-filter_complex",
      "fps=8,scale=1088:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
      "-loop", "0"] : ["-vf", "fps=5,scale=960:-2:flags=lanczos,format=rgb24", "-plays", "0", "-f", "apng"];
    execFileSync("ffmpeg", ["-loglevel", "error", "-nostdin", "-y", "-i", video, ...encoding,
      path.join(this.staging, "media", filename)]);
    this.media.add(filename);
  }

  async finish(render = renderGuide) {
    const guide = render(this.excerpts);
    const linked = new Set(Array.from(guide.matchAll(/!\[[^\]]*\]\(media\/([^\s)]+)\)/g), match => match[1]!));
    expect([...linked].sort(), "every capture belongs in the guide").toEqual([...this.media].sort());
    for (const file of linked) expect((await stat(path.join(this.staging, "media", file))).size).toBeGreaterThan(0);
    await writeFile(path.join(this.staging, "README.md"), guide);
  }
}
