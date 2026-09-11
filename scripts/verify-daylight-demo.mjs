import assert from "node:assert/strict";
import { chromium } from "playwright";
import sharp from "sharp";

const url = process.env.DEMO_URL || "http://localhost:12345/examples/";
async function pixels(page) {
  return sharp(await page.locator("canvas").screenshot())
    .resize(160, 120)
    .removeAlpha()
    .raw()
    .toBuffer();
}
function difference(a, b) {
  return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
}
async function observe(page) {
  await page.addInitScript(() => {
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener("observe", ({ detail }) => {
      if (!detail.isWebGLRenderer) return;
      const render = detail.render.bind(detail);
      detail.render = (scene, camera) => {
        if (camera.isPerspectiveCamera) window.__daylightTest = { renderer: detail, scene, camera };
        return render(scene, camera);
      };
    });
  });
}
async function openDaylight(page) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("canvas").waitFor();
  await page.getByRole("tab").nth(5).click();
  await page.locator("select").waitFor();
  await page.waitForFunction(() => {
    let count = 0;
    window.__daylightTest?.scene.traverse((o) => {
      if (o.material?.name === "Daylight building facade") count++;
    });
    return count >= 40;
  });
  await page.waitForTimeout(16000);
}

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const errors = [];
  try {
    for (const [name, viewport] of Object.entries({
      desktop: { width: 1600, height: 1000 },
      mobile: { width: 390, height: 844 },
    })) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await observe(page);
      await openDaylight(page);
      const first = await pixels(page);
      const stats = await sharp(await page.locator("canvas").screenshot()).stats();
      assert.ok(
        stats.channels.some((channel) => channel.stdev > 10),
        "Canvas must contain scene detail",
      );
      const diagnostics = await page.evaluate(() => {
        const { scene, renderer } = window.__daylightTest;
        let buildings = 0,
          imagery = 0;
        scene.traverse((o) => {
          if (o.material?.name === "Daylight building facade") buildings++;
          if (o.visible && o.material?.map?.image) imagery++;
        });
        return {
          buildings,
          imagery,
          calls: renderer.info.render.calls,
          width: document.documentElement.scrollWidth,
        };
      });
      assert.equal(diagnostics.buildings, 49);
      assert.ok(diagnostics.imagery > 0, "Real imagery must load");
      assert.ok(diagnostics.width <= viewport.width, "No document overflow");
      await page.screenshot({ path: `artifacts/daylight-${name}.png`, fullPage: true });
      await page.getByRole("checkbox").nth(0).check();
      await page.waitForTimeout(1500);
      const motion = difference(first, await pixels(page));
      assert.ok(motion > 0.5, "Orbit must change canvas pixels");
      await page.getByRole("checkbox").nth(0).uncheck();
      await page.getByRole("checkbox").nth(1).uncheck();
      assert.equal(
        await page.evaluate(() => window.__daylightTest.renderer.shadowMap.enabled),
        false,
      );
      await page.getByRole("checkbox").nth(1).check();
      await page.locator("select").selectOption("yundang");
      await page.waitForTimeout(10000);
      await page.screenshot({ path: `artifacts/daylight-${name}-lake.png`, fullPage: true });
      await page.locator("select").selectOption("island");
      await page.waitForTimeout(3000);
      assert.ok(difference(first, await pixels(page)) > 4, "View preset must move the scene");
      if (name === "desktop") {
        await page.getByRole("tab").nth(4).click();
        await page.waitForTimeout(5500);
        const cyber = await page.evaluate(() => {
          let found = false;
          window.__daylightTest.scene.traverse((o) => {
            if (o.material?.name === "Tiles3DLayer cyber building") found = true;
          });
          return found;
        });
        assert.equal(cyber, true, "Original demo still uses cyber material");
        assert.equal(await page.locator("select").count(), 0);
        await page.screenshot({ path: "artifacts/daylight-regression-original.png" });
        await page.getByRole("tab").nth(5).click();
        await page.locator("select").waitFor();
        await page.waitForTimeout(3500);
        assert.equal(await page.locator("canvas").count(), 1);
      }
      console.log(JSON.stringify({ viewport: name, ...diagnostics, pixelMotion: motion }));
      await page.close();
    }
    assert.deepEqual(errors, [], "No browser/GLSL errors");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
