// Exercise WebView ownership and event routing with a controllable UIKit acknowledgement.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { chromium, devices, webkit } from "playwright"
import ts from "typescript"

const src = name => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")
const compile = name => ts.transpileModule(src(name), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const modules = new Map([
  ["/app/ios-chrome", compile("app/ios-chrome.ts").replace('"@tauri-apps/api/core"', '"/core"')],
  ["/app/ios-chrome-geometry", compile("app/ios-chrome-geometry.ts")],
  ["/core", `export class Channel { constructor(handler) { this.onmessage = handler; window.channel = this } }
    export async function invoke(_, {snapshot}) {
      window.calls++; window.last = snapshot;
      if (window.block) await new Promise(resolve => window.release = resolve);
      if (window.fail) throw Error("bridge unavailable");
      return window.supported;
    }`],
  ["/icons", 'export const createIcon = () => document.createElementNS("http://www.w3.org/2000/svg", "svg")'],
  ["/app/canvas-interaction", 'export const isTauri = () => true; export const mobilePortraitQuery = matchMedia("(max-width: 760px)")'],
  ["/motion", "export async function closeDialog(dialog) { dialog.close() }"],
])
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${["tokens.css", "components.css", "style.css", "inspector.css"].map(src).join("\n")}
  #scrollbox {width:110px;height:66px;overflow:auto} #scrollbox button {width:86px;height:40px}
  #zoom {display:flex;left:140px;right:auto;top:140px;bottom:auto;height:40px}
  #zoom button {width:72px;height:36px} #settings-workspace[hidden]{display:none}
  </style>
  <nav id="mobile-navigation"><button data-mobile-page="home" aria-current="page">Home</button>
    <button data-mobile-page="edit">Edit</button><button data-mobile-page="resources" disabled>Resources</button>
    <button data-mobile-page="ai" hidden>AI</button><button data-settings-entry="settings">Settings</button></nav>
  <nav id="workspace-navigation"></nav><section id="settings-workspace" hidden></section>
  <dialog id="mobile-project-dialog"></dialog>
  <div id="scrollbox"><div style="height:45px"></div><nav id="mobile-inspector-groups">
    <button aria-pressed="false" data-mobile-inspector-group="0">布局</button></nav><div style="height:100px"></div></div>
  <div id="zoom" class="glass-module preview-zoom-control"><button id="fit" tabindex="3" aria-hidden="false">Fit</button></div>
  <dialog id="picker"><button id="cancel">Cancel</button><iframe style="width:110px;height:64px" srcdoc="<button style='width:90px;height:38px' id='apply'>Apply</button>"></iframe></dialog>
  <script type="module">import {wireIOSChrome} from "/app/ios-chrome"; wireIOSChrome()</script>`

const engine = process.env.PLAYWRIGHT_BROWSER === "webkit" ? webkit : chromium
const browser = await engine.launch()
try {
  const page = await browser.newPage(devices["iPhone 13"])
  await page.route("https://bridge.test/**", route => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ contentType: path === "/" ? "text/html" : "text/javascript", body: path === "/" ? html : modules.get(path) ?? "" })
  })
  await page.addInitScript(() => {
    Object.assign(window, { calls: 0, supported: !location.search.includes("old"), block: true, taps: 0 })
    window.webkit = { messageHandlers: { keyskinDismissChrome: { postMessage() { window.dismissed = true } } } }
    document.addEventListener("click", e => {
      if (e.target.id === "fit") window.taps++
      if (e.target.dataset.mobilePage === "edit") {
        document.querySelector('[aria-current="page"]').removeAttribute("aria-current")
        e.target.setAttribute("aria-current", "page")
      }
    })
  })
  await page.goto("https://bridge.test/")
  await page.waitForFunction(() => window.release)
  const fit = page.locator("#fit")
  const rect = await fit.boundingBox()
  assert.equal(await fit.getAttribute("data-ios-native-action"), null)
  await page.evaluate(() => { window.block = false; window.release() })
  await page.waitForSelector("#fit[data-ios-native-action]", { state: "attached" })
  assert.deepEqual(await fit.boundingBox(), rect)
  assert.equal(await fit.evaluate(el => getComputedStyle(el).opacity), "0")
  assert.deepEqual(await page.locator("#zoom").evaluate(el => {
    const css = getComputedStyle(el)
    return [css.backgroundColor, css.boxShadow, css.backdropFilter, css.borderTopColor]
  }), ["rgba(0, 0, 0, 0)", "none", "none", "rgba(0, 0, 0, 0)"])
  await fit.click()
  assert.equal(await page.evaluate(() => window.taps), 0)
  const event = value => page.evaluate(value => window.channel.onmessage(value), value)
  await event({ kind: "action", id: "fit", x: rect.x + 10, y: rect.y + 10 })
  assert.equal(await page.evaluate(() => window.taps), 1)
  await event({ kind: "action", id: "fit", x: rect.x - 10, y: rect.y - 10 })
  assert.equal(await page.evaluate(() => window.taps), 1)
  const rail = () => page.evaluate(() => window.last.actions.find(a => a.item.stacked))
  const partial = await rail()
  assert.ok(partial.clip.height < partial.box.height)
  await page.locator("#scrollbox").evaluate(el => { el.scrollTop = 35 })
  await page.waitForFunction(() => window.last.actions.some(a => a.item.stacked && a.clip.height === a.box.height))
  assert.equal((await rail()).item.id, partial.item.id)
  await page.locator("#mobile-inspector-groups button").evaluate(el => {
    const next = el.cloneNode(true); next.removeAttribute("data-ios-native-action")
    next.setAttribute("aria-pressed", "true"); el.replaceWith(next)
  })
  await page.waitForFunction(() => window.last.actions.some(a => a.item.stacked && a.item.selected))
  assert.equal((await rail()).item.id, partial.item.id)
  await event({ kind: "tab", id: "edit" })
  await page.waitForFunction(() => window.last.tabs.find(t => t.id === "edit")?.selected)
  assert.equal(await page.evaluate(() => window.last.tabs.find(t => t.id === "resources").enabled), false)
  assert.equal(await page.evaluate(() => window.last.tabs.some(t => t.id === "ai")), false)
  await page.locator("#picker").evaluate(dialog => dialog.showModal())
  await page.waitForFunction(() => !window.last.showTabs && window.last.actions.some(a => a.item.title === "Apply"))
  assert.equal(await fit.getAttribute("data-ios-native-action"), null)
  const apply = page.frameLocator("iframe").locator("#apply")
  await apply.evaluate(el => el.addEventListener("click", () => el.dataset.applied = "true"))
  const iframeAction = await page.evaluate(() => window.last.actions.find(a => a.item.title === "Apply"))
  await event({ kind: "action", id: iframeAction.item.id, x: iframeAction.clip.x + iframeAction.clip.width / 2,
    y: iframeAction.clip.y + iframeAction.clip.height / 2 })
  assert.equal(await apply.getAttribute("data-applied"), "true")
  await page.locator("#picker").evaluate(dialog => dialog.close())
  await page.waitForSelector("#fit[data-ios-native-action]", { state: "attached" })
  await page.evaluate(() => { window.fail = true; document.querySelector("#fit").title = "Changed"; document.querySelector("#fit").textContent = "Refit" })
  await page.waitForFunction(() => window.dismissed && !document.querySelector("[data-ios-native-chrome]"))
  assert.equal(await fit.getAttribute("aria-hidden"), "false")
  assert.equal(await fit.getAttribute("tabindex"), "3")
  assert.notEqual(await page.locator("#zoom").evaluate(el => getComputedStyle(el).boxShadow), "none")
  await fit.click()
  assert.equal(await page.evaluate(() => window.taps), 2)
  await page.evaluate(() => { window.fail = false; window.dispatchEvent(new Event("resize")) })
  await page.waitForSelector("#fit[data-ios-native-action]", { state: "attached" })
  await page.setViewportSize({ width: 412, height: 860 })
  await page.waitForFunction(() => Math.round(window.last.width) === 412)
  await page.evaluate(() => {
    window.dismissed = false; window.block = true
    document.querySelector("#fit").setAttribute("aria-pressed", "true")
  })
  await page.waitForFunction(() => window.dismissed)
  assert.equal(await fit.getAttribute("data-ios-native-action"), null)
  await page.evaluate(() => { window.block = false; window.release(); window.dispatchEvent(new Event("resize")) })
  await page.waitForSelector("#fit[data-ios-native-action]", { state: "attached" })
  await event({ kind: "action", id: "fit", x: rect.x + 10, y: rect.y + 10 })
  assert.equal(await page.evaluate(() => window.taps), 3)
  const extraUpdates = await page.evaluate(async () => {
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await settle()
    const calls = window.calls
    for (let i = 0; i < 12; i++) document.dispatchEvent(new Event("scroll"))
    await settle()
    return window.calls - calls
  })
  assert.equal(extraUpdates, 0)
  await page.goto("https://bridge.test/?old")
  await page.waitForFunction(() => window.release)
  await page.evaluate(() => { window.block = false; window.release() })
  await page.waitForFunction(() => window.dismissed)
  assert.equal(await fit.getAttribute("data-ios-native-action"), null)
  await fit.click()
  assert.equal(await page.evaluate(() => window.taps), 1)
  console.log("iOS chrome bridge: acknowledgement, clipping, category reuse, tap routing, tabs, iframe dialog, backplate, resize, recovery and unsupported iOS passed")
} finally {
  await browser.close()
}
