import { Channel, invoke } from "@tauri-apps/api/core"
import { createIcon } from "../icons"
import { isTauri, mobilePortraitQuery } from "./canvas-interaction"
import { actionGeometry, hit, topClientPoint, type ChromeBox } from "./ios-chrome-geometry"
import { closeDialog } from "../motion"

type ChromeEvent = { kind: "tab" | "action" | "project" | "segment" | "search" | "pan"; id: string; x?: number; y?: number; taps?: number }
type ChromeItem = { id: string; title: string; label: string; icon?: string; enabled: boolean; selected: boolean; primary: boolean; busy: boolean; stacked?: boolean }
type ChromeAction = { item: ChromeItem; box: ChromeBox; clip: ChromeBox }

const actionSelector = 'button, summary.ui-button, summary.ui-icon-button, [role="button"].ui-button, [role="button"].ui-icon-button'
const tabItems = [
  ["home", "首页", "house", "files"],
  ["edit", "编辑", "sliders-horizontal", "overview"],
  ["resources", "资源", "layers", "resources"],
  ["ai", "AI 设计", "sparkles", "ai"],
  ["settings", "设置", "settings", "settings"],
] as const

function buttonDisabled(element: HTMLElement): boolean {
  return element.matches(':disabled, [aria-disabled="true"]') || Boolean(element.closest("[inert]"))
}

function renderIcon(name: string): Promise<string> {
  const svg = createIcon(name, 20)
  svg.setAttribute("color", "black")
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }))
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 72
        canvas.getContext("2d")!.drawImage(image, 0, 0, 72, 72)
        resolve(canvas.toDataURL("image/png").split(",")[1])
      } catch (error) { reject(error) }
      finally { URL.revokeObjectURL(url) }
    }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法生成原生按钮图标")) }
    image.src = url
  })
}

/** Mirror visible actions into UIKit. The DOM owns routing, forms and document state. */
export function wireIOSChrome(): void {
  if (!isTauri() || !(/iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))) return
  const root = document.documentElement
  const mobileNav = document.querySelector<HTMLElement>("#mobile-navigation")!
  const desktopNav = document.querySelector<HTMLElement>("#workspace-navigation")!
  const settings = document.querySelector<HTMLElement>("#settings-workspace")!
  const project = document.querySelector<HTMLDialogElement>("#mobile-project-dialog")!
  let events: Channel<ChromeEvent> | undefined
  const ids = new WeakMap<HTMLElement, string>()
  const icons = new Map<string, string>()
  const sentIcons = new Set<string>()
  const session = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-")
  let sequence = 0
  const loadingIcons = new Set<string>()
  const activeElements = new Set<HTMLElement>()
  const surfaces = new Set<HTMLElement>()
  const frameDocuments = new WeakSet<Document>()
  const accessibility = new WeakMap<HTMLElement, string | null>()
  const tabStops = new WeakMap<HTMLElement, string | null>()
  let watchedLayout = new Set<Element>()
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : undefined
  let nativeClips = new Map<string, ChromeBox>()
  let nextId = 0
  let frame = 0
  let pending = false
  let sending = false
  let suspended = false
  let generation = 0
  let supported: boolean | undefined
  let previous = ""
  let actions = new Map<string, HTMLElement>()
  let projectActions = new Map<string, HTMLElement>()

  function icon(name: string | undefined, isTab = false): string | undefined {
    if (!name) return
    const key = isTab ? `tab:${name}` : name
    if (icons.has(key)) return key
    if (!loadingIcons.has(key)) {
      loadingIcons.add(key)
      void renderIcon(name).then(data => { icons.set(key, data); schedule() }).catch(() => {})
    }
  }

  function item(element: HTMLElement, title = element.innerText.trim().replace(/\s+/g, " ")): ChromeItem {
    let id = ids.get(element)
    if (!id) {
      // Inspector rebuilds its DOM on object changes. A category retains its UIKit button.
      id = element.matches("#mobile-inspector-groups > button")
        ? `rail:${element.dataset.mobileInspectorGroup ?? "link"}:${title}`
        : element.id && element.ownerDocument === document ? element.id : `action-${++nextId}`
      ids.set(element, id)
    }
    const busy = element.getAttribute("aria-busy") === "true" || element.dataset.state === "busy"
    return {
      id, title, label: element.getAttribute("aria-label") ?? (title || element.title),
      icon: icon(element.querySelector<SVGElement>("svg[data-pen-icon]")?.dataset.penIcon),
      enabled: !buttonDisabled(element),
      selected: element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-selected") === "true",
      primary: element.dataset.variant === "primary",
      stacked: element.matches("#mobile-inspector-groups > button"),
      busy,
    }
  }

  function route(id: string): HTMLElement | null {
    if (id === "settings") return (mobilePortraitQuery.matches ? mobileNav : desktopNav).querySelector('[data-settings-entry="settings"]')
    const tab = tabItems.find(([key]) => key === id)
    if (!tab) return null
    return mobilePortraitQuery.matches
      ? mobileNav.querySelector(`[data-mobile-page="${tab[0]}"]`)
      : desktopNav.querySelector(`[data-workspace-page="${tab[3]}"]`)
  }

  function projectContent(projectActions: Map<string, HTMLElement>) {
    const source = project.querySelector<HTMLElement>('[data-sidebar-view="source"]')
    const segment = source?.getAttribute("aria-pressed") === "true" ? 1 : 0
    const rows = [...project.querySelectorAll<HTMLElement>(
      "#files .nav-group > summary, #files button[data-nav-mode], #files .source-root-row, #files .source-folder-row, #files .source-file-row",
    )].flatMap(element => {
      if (!element.getClientRects().length) return []
      const title = element.querySelector(".nav-label")?.textContent?.trim() ?? element.innerText.trim()
      if (!title) return []
      const row = item(element, title)
      const current = element.getAttribute("aria-current")
      if (current && current !== "false") row.selected = true
      projectActions.set(row.id, element)
      const heading = element.matches(".nav-section, .source-root-row, .source-folder-row")
      let depth = 0
      for (let ancestor = element.parentElement; ancestor && ancestor.id !== "files"; ancestor = ancestor.parentElement) {
        if (ancestor.matches(".nav-group-body, .source-tree-group")) depth++
      }
      return [{ item: row, depth: Math.min(depth, 8), heading }]
    })
    const tools = [...project.querySelectorAll<HTMLElement>("#source-file-toolbar button")]
      .filter(element => element.getClientRects().length)
      .map(element => {
        const tool = item(element)
        projectActions.set(tool.id, element)
        return tool
      })
    icon("x")
    icon("plus")
    const search = project.querySelector<HTMLInputElement>("#source-file-search")
    return { segment, rows, tools, search: search && !search.closest("[hidden]") ? search.value : undefined }
  }

  function handleEvent(event: ChromeEvent): void {
    if (event.kind === "tab") {
      const target = route(event.id)
      if (!document.querySelector("dialog[open]") && target && !target.hidden && !buttonDisabled(target)) target.click()
    } else if (event.kind === "pan") {
      const element = actions.get(event.id)
      if (!element?.isConnected || event.x === undefined || event.y === undefined) return
      const direction = Math.abs(event.y) >= Math.abs(event.x) ? "y" : "x"
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const styles = getComputedStyle(parent)
        if (direction === "y" && parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(styles.overflowY)) {
          parent.scrollTop -= event.y
          break
        }
        if (direction === "x" && parent.scrollWidth > parent.clientWidth && /auto|scroll/.test(styles.overflowX)) {
          parent.scrollLeft -= event.x
          break
        }
      }
    } else if (event.kind === "action") {
      const element = actions.get(event.id)
      if (!element?.isConnected || buttonDisabled(element) || element.getAttribute("aria-busy") === "true"
        || element.dataset.state === "busy" || event.x === undefined || event.y === undefined || !hit(element, event.x, event.y)) return
      element.click()
      if (event.taps === 2 && element.id === "preview-zoom-fit") {
        element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }))
      }
    } else if (project.open) {
      if (event.kind === "segment") {
        project.querySelector<HTMLElement>(event.id === "1" ? '[data-sidebar-view="source"]' : '[data-sidebar-view="overview"]')?.click()
      } else if (event.kind === "search") {
        const field = project.querySelector<HTMLInputElement>("#source-file-search")
        if (field) { field.value = event.id; field.dispatchEvent(new Event("input", { bubbles: true })) }
      } else if (event.id === "close") project.querySelector<HTMLElement>("#mobile-files-close")?.click()
      else if (event.id === "new") void closeDialog(project).then(() => document.querySelector<HTMLElement>("#new")?.click())
      else {
        const target = projectActions.get(event.id)
        if (target?.matches(".source-folder-row")) target.querySelector<HTMLElement>(".source-disclosure")?.click()
        else if (target?.isConnected && !buttonDisabled(target)) target.click()
      }
    }
    schedule()
  }

  function schedule(): void {
    if (supported === false || suspended) return
    pending = true
    if (!frame && !sending) frame = requestAnimationFrame(() => {
      frame = 0
      void render().catch(() => { restoreWeb(); supported = undefined })
    })
  }

  function syncActionElements(next: Map<string, HTMLElement>): void {
    actions = next
    const visible = new Set(next.values())
    for (const element of activeElements) if (!visible.has(element)) {
      element.removeAttribute("data-ios-native-action")
      const hidden = accessibility.get(element)
      if (hidden == null) element.removeAttribute("aria-hidden")
      else element.setAttribute("aria-hidden", hidden)
      const tabStop = tabStops.get(element)
      if (tabStop == null) element.removeAttribute("tabindex")
      else element.setAttribute("tabindex", tabStop)
      accessibility.delete(element)
      tabStops.delete(element)
      activeElements.delete(element)
    }
    for (const element of visible) if (!activeElements.has(element)) {
      accessibility.set(element, element.getAttribute("aria-hidden"))
      tabStops.set(element, element.getAttribute("tabindex"))
      element.setAttribute("data-ios-native-action", "")
      element.setAttribute("aria-hidden", "true")
      element.tabIndex = -1
      activeElements.add(element)
    }
    const nextSurfaces = new Set<HTMLElement>()
    for (const element of visible) {
      const surface = element.closest<HTMLElement>(".preview-zoom-control.glass-module, .inspector-rail")
      if (surface) nextSurfaces.add(surface)
    }
    for (const surface of surfaces) if (!nextSurfaces.has(surface)) {
      surface.removeAttribute("data-ios-native-surface")
      surfaces.delete(surface)
    }
    for (const surface of nextSurfaces) if (!surfaces.has(surface)) {
      surface.setAttribute("data-ios-native-surface", "")
      surfaces.add(surface)
    }
  }

  async function render(): Promise<void> {
    if (!pending || suspended || sending) return
    pending = false
    const viewport = window.visualViewport
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    const keyboard = root.dataset.keyboardOpen === "true" || height < window.innerHeight * 0.8
    const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")]
    // The focused dialog follows the browser's top layer, including nested pickers.
    const modal = dialogs.length > 1
      ? document.elementFromPoint(width / 2, height / 2)?.closest<HTMLDialogElement>("dialog[open]")
        ?? document.activeElement?.closest<HTMLDialogElement>("dialog[open]") ?? dialogs.at(-1)
      : dialogs[0]
    const projectOpen = project.open && (!modal || modal === project)
    const current = (mobilePortraitQuery.matches ? mobileNav : desktopNav).querySelector<HTMLElement>('[aria-current="page"]')
    const page = current?.dataset.mobilePage ?? current?.dataset.workspacePage
    const activeTab = !settings.hidden ? "settings" : page === "source" || page === "animation" ? "edit"
      : tabItems.find(([id, , , desktop]) => id === page || desktop === page)?.[0] ?? (root.dataset.mobilePage || "home")
    const tabs = tabItems.flatMap(([id, title, name]) => {
      const target = route(id)
      if (!target || target.hidden) return []
      return [{
        id, title, label: title, icon: icon(name, true),
        enabled: !buttonDisabled(target),
        selected: id === activeTab,
        primary: false, busy: false,
      }]
    })
    const nextProjectActions = new Map<string, HTMLElement>()
    const nextActions = new Map<string, HTMLElement>()
    let visible: ChromeAction[] = []
    const layout = new Set<Element>([root, document.body])
    const measure = actionGeometry(width, height, layout)
    const scope = modal ?? document
    const frames = [...scope.querySelectorAll("iframe")].filter(element => element.getClientRects().length && element.contentDocument)
    const controls = [...scope.querySelectorAll<HTMLElement>(actionSelector)]
    for (const frameElement of frames) {
      const content = frameElement.contentDocument!
      controls.push(...content.querySelectorAll<HTMLElement>(actionSelector))
      if (!frameDocuments.has(content)) {
        frameDocuments.add(content)
        observer.observe(content.documentElement, changes)
        observeDocument(content)
      }
    }
    // WAAPI page slides and dialog transitions can move controls without another DOM mutation.
    for (const doc of [document, ...frames.map(frame => frame.contentDocument!)]) {
      const moving = doc.getAnimations?.().some(animation => {
        const effect = animation.effect as KeyframeEffect | null
        const target = effect?.target
        return animation.playState === "running" && effect?.getTiming().iterations !== Infinity && target
          && (target.matches(actionSelector) || target.querySelector(actionSelector))
          && effect.getKeyframes().some(key => "transform" in key || "translate" in key || "opacity" in key)
      })
      if (moving) { schedule(); break }
    }
    if (!projectOpen) for (const element of controls) {
      if (settings.contains(element) && !element.hasAttribute("data-ios-glass-action")) continue
      if (element.matches('.ui-sound-row > .ui-icon-button, [data-readonly="true"] :disabled')) continue
      if (element.closest("#mobile-navigation, #workspace-navigation, #preview, .simulation, .ui-project-card, .ui-segmented, #files")
        || (element.closest(".ui-menu") && !element.matches(".ui-button, .ui-icon-button"))
        || element.matches('[role="tab"], [role="option"], [role="treeitem"], [role="slider"], .inspector-filter-close')) continue
      const geometry = measure(element)
      if (!geometry) continue
      const action = item(element)
      if (!action.label || (!action.title && !action.icon && !action.busy)) continue
      visible.push({ item: action, ...geometry })
      nextActions.set(action.id, element)
    }
    // A shared zoom backplate belongs to the web until its entire visible button group is ready.
    const ready = new Set(nextActions.values())
    for (const group of scope.querySelectorAll(".preview-zoom-control.glass-module")) {
      const buttons = [...group.querySelectorAll<HTMLElement>(":scope > button")]
      if (buttons.some(button => button.getClientRects().length && !ready.has(button))) {
        for (const button of buttons) nextActions.delete(ids.get(button) ?? "")
      }
    }
    visible = visible.filter(action => nextActions.has(action.item.id))
    if (resize) {
      for (const node of watchedLayout) if (!layout.has(node)) resize.unobserve(node)
      for (const node of layout) if (!watchedLayout.has(node)) resize.observe(node)
      watchedLayout = layout
    }
    const snapshot = {
      tabs, showTabs: !modal && !keyboard, dark: root.dataset.appTheme === "dark", width, height,
      actions: visible, project: projectOpen ? projectContent(nextProjectActions) : undefined,
    }
    const signature = JSON.stringify([snapshot, icons.size])
    if (signature === previous) { projectActions = nextProjectActions; syncActionElements(nextActions); return }
    sending = true
    const revision = generation
    let timer: number | undefined
    try {
      // Each Rust channel starts its own event sequence, including after recovery.
      const register = !events
      events ??= new Channel<ChromeEvent>(handleEvent)
      const payload = { ...snapshot, session, sequence: ++sequence, icons: Object.fromEntries([...icons].filter(([key]) => !sentIcons.has(key))) }
      const applied = await Promise.race([
        invoke<boolean>("sync_ios_chrome", register ? { snapshot: payload, events } : { snapshot: payload }),
        new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("UIKit acknowledgement timed out")), 2000) }),
      ])
      if (revision !== generation) { restoreWeb(); return }
      supported = applied
      if (!supported) { restoreWeb(); return }
      for (const key of Object.keys(payload.icons)) sentIcons.add(key)
      previous = signature
      nativeClips = new Map(visible.map(action => [action.item.id, action.clip]))
      projectActions = nextProjectActions
      root.toggleAttribute("data-ios-native-chrome", true)
      root.toggleAttribute("data-ios-native-project", projectOpen)
      syncActionElements(nextActions)
    } catch {
      restoreWeb()
      // Re-register the channel and image cache on a fresh controller.
      supported = undefined
    } finally {
      clearTimeout(timer)
      sending = false
      if (pending) schedule()
    }
  }

  function restoreWeb(): void {
    previous = ""
    if (events) events.onmessage = () => {}
    events = undefined
    sentIcons.clear()
    projectActions.clear()
    nativeClips.clear()
    syncActionElements(new Map())
    root.removeAttribute("data-ios-native-project")
    root.removeAttribute("data-ios-native-chrome")
    // Independent of the Tauri command that just failed (or of Rust during pagehide).
    const host = window as Window & { webkit?: { messageHandlers?: { keyskinDismissChrome?: { postMessage(value: object): void } } } }
    host.webkit?.messageHandlers?.keyskinDismissChrome?.postMessage({ session, sequence })
  }

  function preventWebTap(event: MouseEvent): void {
    if (!event.isTrusted || !event.detail) return
    const element = (event.target as Element | null)?.closest?.<HTMLElement>("[data-ios-native-action]")
    if (!element) return
    const clip = nativeClips.get(ids.get(element) ?? "")
    const point = topClientPoint(element, event.clientX, event.clientY)
    if (!clip || point.x < clip.x || point.y < clip.y || point.x >= clip.x + clip.width || point.y >= clip.y + clip.height) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const observer = new MutationObserver(schedule)
  const changes: MutationObserverInit = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["class", "style", "open", "hidden", "disabled", "inert", "title", "aria-busy", "aria-pressed", "aria-selected",
      "aria-current", "aria-label", "aria-disabled", "data-app-theme", "data-mobile-page", "data-mobile-pane", "data-mobile-mode",
      "data-keyboard-open", "data-variant", "data-state", "data-ios-glass-action", "data-filter-miss"],
  }
  observer.observe(root, changes)
  function observeDocument(doc: Document): void {
    doc.addEventListener("click", preventWebTap, true)
    for (const name of ["scroll", "load", "toggle", "close", "transitionrun", "transitionend", "transitioncancel",
      "animationstart", "animationend", "animationcancel"]) doc.addEventListener(name, schedule, true)
  }
  observeDocument(document)
  window.addEventListener("pagehide", () => { suspended = true; generation++; restoreWeb() })
  window.addEventListener("pageshow", () => { suspended = false; schedule() })
  window.addEventListener("resize", schedule)
  window.visualViewport?.addEventListener("resize", schedule)
  window.visualViewport?.addEventListener("scroll", schedule)
  schedule()
}
