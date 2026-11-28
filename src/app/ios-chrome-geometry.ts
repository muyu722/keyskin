export type ChromeBox = { x: number; y: number; width: number; height: number }

function frameSpace(element: HTMLElement) {
  const frame = element.ownerDocument.defaultView?.frameElement
  if (!(frame instanceof HTMLIFrameElement)) return { x: 0, y: 0, sx: 1, sy: 1 }
  const rect = frame.getBoundingClientRect()
  const sx = rect.width / frame.offsetWidth
  const sy = rect.height / frame.offsetHeight
  return { frame, x: rect.left + frame.clientLeft * sx, y: rect.top + frame.clientTop * sy, sx, sy }
}

export function topClientPoint(element: HTMLElement, x: number, y: number) {
  const space = frameSpace(element)
  return { x: space.x + x * space.sx, y: space.y + y * space.sy }
}

/** WKWebView client rects and hit points both use visual-viewport CSS pixels. */
export function hit(element: HTMLElement, x: number, y: number): boolean {
  const space = frameSpace(element)
  let target = document.elementFromPoint(x, y)
  if (space.frame) {
    if (target !== space.frame) return false
    target = element.ownerDocument.elementFromPoint((x - space.x) / space.sx, (y - space.y) / space.sy)
  }
  return target !== null && (element.contains(target) || (element.matches(':disabled, [aria-disabled="true"]')
    && target.contains(element) && target !== element.ownerDocument.body && target !== element.ownerDocument.documentElement))
}

function intersect(a: ChromeBox, b: ChromeBox, clipX = true, clipY = true): ChromeBox {
  const x = clipX ? Math.max(a.x, b.x) : a.x
  const y = clipY ? Math.max(a.y, b.y) : a.y
  return { x, y, width: (clipX ? Math.min(a.x + a.width, b.x + b.width) : a.x + a.width) - x,
    height: (clipY ? Math.min(a.y + a.height, b.y + b.height) : a.y + a.height) - y }
}

/** Share ancestor measurements within a frame; never reuse them after scrolling. */
export function actionGeometry(width: number, height: number, layout: Set<Element>) {
  const viewport = { x: 0, y: 0, width, height }
  const clips = new Map<HTMLElement, ChromeBox>()
  function clipFor(parent: HTMLElement | null): ChromeBox {
    if (!parent) return viewport
    const cached = clips.get(parent)
    if (cached) return cached
    layout.add(parent)
    const space = frameSpace(parent)
    let clip = clipFor(parent.parentElement ?? space.frame ?? null)
    const style = getComputedStyle(parent)
    if (style.opacity === "0") clip = { x: 0, y: 0, width: 0, height: 0 }
    else if (style.overflowX !== "visible" || style.overflowY !== "visible" || parent.tagName === "IFRAME") {
      const rect = parent.getBoundingClientRect()
      const sx = space.sx * (parent.offsetWidth ? rect.width / parent.offsetWidth : 1)
      const sy = space.sy * (parent.offsetHeight ? rect.height / parent.offsetHeight : 1)
      const inner = { x: space.x + rect.left * space.sx + parent.clientLeft * sx,
        y: space.y + rect.top * space.sy + parent.clientTop * sy,
        width: parent.clientWidth * sx, height: parent.clientHeight * sy }
      clip = intersect(clip, inner, style.overflowX !== "visible" || parent.tagName === "IFRAME",
        style.overflowY !== "visible" || parent.tagName === "IFRAME")
    }
    clips.set(parent, clip)
    return clip
  }
  return (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    if (rect.width < 20 || rect.height < 20 || (rect.width > 100 && rect.height > 100)) return
    layout.add(element)
    const style = getComputedStyle(element)
    if (style.visibility !== "visible" || (style.opacity === "0" && !element.hasAttribute("data-ios-native-action"))) return
    const space = frameSpace(element)
    const box = { x: space.x + rect.left * space.sx, y: space.y + rect.top * space.sy,
      width: rect.width * space.sx, height: rect.height * space.sy }
    const clip = intersect(box, clipFor(element.parentElement))
    if (clip.width < 1 || clip.height < 1) return
    const cx = clip.x + clip.width / 2, cy = clip.y + clip.height / 2
    const dx = clip.width * 0.32, dy = clip.height * 0.32
    if (![[cx, cy], [cx - dx, cy], [cx + dx, cy], [cx, cy - dy], [cx, cy + dy]]
      .every(([x, y]) => hit(element, x, y))) return
    return { box, clip }
  }
}
