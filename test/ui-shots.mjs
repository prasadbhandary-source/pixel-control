import { chromium } from "playwright";
const S = "/tmp/claude-0/-home-claude/3083c1eb-8346-56dc-bca8-a01aabe768df/scratchpad";
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror " + e.message));
  p.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); });
  await p.goto("http://localhost:8099/");
  await p.waitForTimeout(800);
  console.log(scheme, "errors:", errs, "usb:", await p.evaluate(() => !!navigator.usb), "connectDisabled:", await p.$eval("#connect-btn", (b) => b.disabled), "status:", await p.$eval("#status", (s) => s.hidden ? "(hidden)" : s.textContent));
  await p.click("summary");
  await p.screenshot({ path: `${S}/start-${scheme}.png` });
  if (scheme === "dark") {
    // Simulate the connected view with a fake 1280x2856 frame to check layout.
    await p.evaluate(() => {
      document.getElementById("start").hidden = true; document.getElementById("phone").hidden = false;
      document.body.dataset.view = "phone";
      const c = document.getElementById("screen"); c.width = 1280; c.height = 2856;
      const g = c.getContext("2d"); g.fillStyle = "#334"; g.fillRect(0,0,1280,2856); g.fillStyle="#fff"; g.font="120px sans-serif"; g.fillText("12:00", 420, 600);
      const r = document.getElementById("stage").getBoundingClientRect(); const s = Math.min((r.width-32)/1280, (r.height-32)/2856);
      c.style.width = Math.floor(1280*s)+"px"; c.style.height = Math.floor(2856*s)+"px";
    });
    await p.screenshot({ path: `${S}/phone-view.png` });
    await p.click("#phone-help-btn");
    await p.screenshot({ path: `${S}/help.png` });
  }
}
await b.close();
