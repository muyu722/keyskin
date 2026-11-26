import { Channel, invoke } from "@tauri-apps/api/core"
import { createIcon } from "../icons"
import { isTauri, mobilePortraitQuery } from "./canvas-interaction"
import { appState } from "./state"
import { closeDialog } from "../motion"

type ChromeEvent = { kind: "tab" | "action" | "project" | "segment" | "search"; id: string; x?: number; y?: number }
type ChromeItem = { id: string; title: string; label: string; icon?: string; enabled: boolean; selected: boolean; primary: boolean; busy: boolean }
type ChromeAction = { item: ChromeItem; x: number; y: number; width: number; height: number }

const actionSelector = 'button, summary.ui-button, [role="button"].ui-button'
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

function hit(element: HTMLElement, x: number, y: number): boolean {
  let target = document.elementFromPoint(x, y)
  const frame = element.ownerDocument.defaultView?.frameElement
  if (frame instanceof HTMLIFrameElement) {
    if (target !== frame) return false
    const rect = frame.getBoundingClientRect()
    target = element.ownerDocument.elementFromPoint(x - rect.left - frame.clientLeft, y - rect.top - frame.clientTop)
  }
  return target !== null && (element.contains(target)
    || (buttonDisabled(element) && target.contains(element) && target !== document.body && target !== document.documentElement))
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
  const events = new Channel<ChromeEvent>()
  const ids = new WeakMap<HTMLElement, string>()
  const icons = new Map<string, string>()
  const loadingIcons = new Set<string>()
  const activeElements = new Set<HTMLElement>()
  const frameDocuments = new WeakSet<Document>()
  const accessibility = new WeakMap<HTMLElement, string | null>()
  let nextId = 0
  let frame = 0
  let pending = false
  let sending = false
  let supported: boolean | undefined
  let previous = ""
  let actions = new Map<string, HTMLElement>()
  let actionOffsetX = 0
  let actionOffsetY = 0
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
      id = element.id && element.ownerDocument === document ? element.id : `action-${++nextId}`
      ids.set(element, id)
    }
    const busy = element.getAttribute("aria-busy") === "true" || element.dataset.state === "busy"
    return {
      id, title, label: element.getAttribute("aria-label") ?? (title || element.title),
      icon: icon(element.querySelector<SVGElement>("svg[data-pen-icon]")?.dataset.penIcon),
      enabled: !buttonDisabled(element),
      selected: element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-selected") === "true",
      primary: element.dataset.variant === "primary",
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

  function projectContent() {
    const source = project.querySelector<HTMLElement>('[data-sidebar-view="source"]')
    const segment = source?.getAttribute("aria-pressed") === "true" ? 1 : 0
    const rows = [...project.querySelectorAll<HTMLElement>(
      "#files .nav-group > summary, #files button[data-nav-mode], #files .source-root-row, #files .source-folder-row, #files .source-file-row",
    )].flatMap(element => {
      if (!element.getClientRects().length) return []
      const title = element.querySelector(".nav-label")?.textContent?.trim() ?? element.innerText.trim()
      if (!title) return []
      const row = item(element, title)
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

  events.onmessage = event => {
    if (event.kind === "tab") {
      if (!document.querySelector("dialog[open]")) route(event.id)?.click()
    } else if (event.kind === "action") {
      const element = actions.get(event.id)
      if (!element?.isConnected || buttonDisabled(element) || event.x === undefined || event.y === undefined
        || !hit(element, event.x + actionOffsetX, event.y + actionOffsetY)) return
      element.click()
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
    if (supported === false) return
    pending = true
    if (!frame && !sending) frame = requestAnimationFrame(() => { frame = 0; void render() })
  }

  function syncActionElements(next: Map<string, HTMLElement>): void {
    actions = next
    const visible = new Set(next.values())
    for (const element of activeElements) if (!visible.has(element)) {
      element.removeAttribute("data-ios-native-action")
      const hidden = accessibility.get(element)
      if (hidden == null) element.removeAttribute("aria-hidden")
      else element.setAttribute("aria-hidden", hidden)
      accessibility.delete(element)
      activeElements.delete(element)
    }
    for (const element of visible) if (!activeElements.has(element)) {
      accessibility.set(element, element.getAttribute("aria-hidden"))
      element.setAttribute("data-ios-native-action", "")
      element.setAttribute("aria-hidden", "true")
      activeElements.add(element)
    }
  }

  async function render(): Promise<void> {
    if (!pending) return
    pending = false
    const viewport = window.visualViewport
    const offsetX = viewport?.offsetLeft ?? 0
    const offsetY = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    const keyboard = root.dataset.keyboardOpen === "true" || height < window.innerHeight * 0.8
    const modal = document.querySelector<HTMLDialogElement>("dialog:modal:last-of-type")
      ?? [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1)
    const projectOpen = project.open && (!modal || modal === project)
    const activeTab = settings.hidden
      ? mobilePortraitQuery.matches ? root.dataset.mobilePage : desktopNav.querySelector<HTMLElement>('[aria-current="page"]')?.dataset.workspacePage
      : "settings"
    const tabs = tabItems.map(([id, title, name, desktop]) => {
      const target = route(id)
      return {
        id, title, label: title, icon: icon(name, true),
        enabled: id === "home" || id === "settings" || (Boolean(appState.archive) && !appState.fileOperationRunning
          && target !== null && !target.hidden && !buttonDisabled(target)),
        selected: (mobilePortraitQuery.matches ? id : desktop) === (activeTab || (mobilePortraitQuery.matches ? "home" : "files")),
        primary: false, busy: false,
      }
    })
    if (tabs.some(tab => !tab.icon)) return
    projectActions = new Map()
    const nextActions = new Map<string, HTMLElement>()
    const visible: ChromeAction[] = []
    const scope = modal ?? document
    const frames = [...scope.querySelectorAll("iframe")].filter(element => element.getClientRects().length && element.contentDocument)
    const controls = [...scope.querySelectorAll<HTMLElement>(actionSelector)]
    for (const frameElement of frames) {
      const content = frameElement.contentDocument!
      controls.push(...content.querySelectorAll<HTMLElement>(actionSelector))
      if (!frameDocuments.has(content)) {
        frameDocuments.add(content)
        observer.observe(content.documentElement, changes)
        content.addEventListener("scroll", schedule, true)
      }
    }
    if (!projectOpen) for (const element of controls) {
      if (element.closest("#mobile-navigation, #workspace-navigation, #preview, .simulation, .ui-project-card, .ui-segmented, #files, .ui-menu")
        || element.matches('[role="tab"], [role="option"], [role="treeitem"]')) continue
      const rect = element.getBoundingClientRect()
      const parentFrame = element.ownerDocument.defaultView?.frameElement
      const frameRect = parentFrame?.getBoundingClientRect()
      const left = rect.left + (frameRect?.left ?? 0) + (parentFrame?.clientLeft ?? 0)
      const top = rect.top + (frameRect?.top ?? 0) + (parentFrame?.clientTop ?? 0)
      const x = left - offsetX
      const y = top - offsetY
      if (rect.width < 20 || rect.height < 20 || x < 0 || y < 0 || x + rect.width > width + 1
        || y + rect.height > height + 1 || getComputedStyle(element).visibility !== "visible") continue
      const midX = left + rect.width / 2
      const midY = top + rect.height / 2
      if (![[midX, top + 2], [midX, top + rect.height - 2], [left + 2, midY], [left + rect.width - 2, midY], [midX, midY]]
        .every(([pointX, pointY]) => hit(element, pointX, pointY))) continue
      const action = item(element)
      if (!action.label || (!action.title && !action.icon && !action.busy)) continue
      visible.push({ item: action, x, y, width: rect.width, height: rect.height })
      nextActions.set(action.id, element)
    }
    const snapshot = {
      tabs, showTabs: !modal && !keyboard, dark: root.dataset.appTheme === "dark", width, height,
      actions: visible, project: projectOpen ? projectContent() : undefined, icons: Object.fromEntries(icons),
      offsetX, offsetY,
    }
    const signature = JSON.stringify(snapshot)
    if (signature === previous) { syncActionElements(nextActions); return }
    sending = true
    try {
      supported = await invoke<boolean>("sync_ios_chrome", { snapshot, events: supported === undefined ? events : null })
      if (!supported) return
      previous = signature
      actionOffsetX = offsetX
      actionOffsetY = offsetY
      root.toggleAttribute("data-ios-native-chrome", true)
      root.toggleAttribute("data-ios-native-project", projectOpen)
      syncActionElements(nextActions)
    } catch {
      // Keep the WebView controls usable if the native bridge is unavailable.
      if (supported === undefined) supported = false
    } finally {
      sending = false
      if (pending) schedule()
    }
  }

  const observer = new MutationObserver(schedule)
  const changes: MutationObserverInit = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["class", "style", "open", "hidden", "disabled", "inert", "aria-busy", "aria-pressed", "aria-selected",
      "aria-current", "aria-label", "aria-disabled", "data-app-theme", "data-mobile-page", "data-keyboard-open", "data-variant", "data-state"],
  }
  observer.observe(root, changes)
  document.addEventListener("load", schedule, true)
  const resize = new ResizeObserver(schedule)
  resize.observe(document.body)
  document.addEventListener("scroll", schedule, true)
  window.addEventListener("resize", schedule)
  window.visualViewport?.addEventListener("resize", schedule)
  window.visualViewport?.addEventListener("scroll", schedule)
  document.addEventListener("transitionend", schedule, true)
  schedule()
}
