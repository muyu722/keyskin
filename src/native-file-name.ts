function fileUrlSegment(path: string): string | undefined {
  if (!path.startsWith("file://")) return
  try {
    return new URL(path).pathname.split("/").pop() || undefined
  } catch {
    return
  }
}

export function nativeFileName(path: string): string {
  const segment = fileUrlSegment(path)
  if (segment === undefined) return path.split(/[\\/]/).pop() ?? ""
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Old records saved the literal last URL component as the display name. */
export function recentDisplayName(path: string, name: string): string {
  return name === fileUrlSegment(path) ? nativeFileName(path) : name
}
