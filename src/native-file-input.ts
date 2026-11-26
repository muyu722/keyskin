import { nativeFileName } from "./native-file-name"

type NativeWindow = Window & {
  __TAURI_INTERNALS__?: { invoke<T>(command: string, args: object): Promise<T> }
}

/** UIKit taps reach the WebView over IPC and do not grant a WebKit file-input user gesture. */
export async function chooseInputFiles(input: HTMLInputElement): Promise<void> {
  const host = window.parent as NativeWindow
  const native = host.__TAURI_INTERNALS__
  if (!native || !host.document.documentElement.hasAttribute("data-ios-native-chrome")) {
    input.click()
    return
  }
  const extensions = input.accept.split(",").map(value => value.trim()).filter(Boolean)
    .map(value => value.startsWith(".") ? value.slice(1) : value)
  const result = await native.invoke<string | string[] | null>("plugin:dialog|open", {
    options: { multiple: input.multiple, pickerMode: "document", fileAccessMode: "copy",
      filters: extensions.length ? [{ name: "文件", extensions }] : undefined },
  })
  if (!result) {
    input.dispatchEvent(new Event("cancel", { bubbles: true }))
    return
  }
  const selection = new DataTransfer()
  for (const path of typeof result === "string" ? [result] : result) {
    const data = await native.invoke<ArrayBuffer | number[]>("plugin:fs|read_file", { path })
    const bytes = new Uint8Array(data as ArrayBuffer)
    const name = nativeFileName(path)
    const mime = /\.png$/i.test(name) ? "image/png" : ""
    selection.items.add(new File([bytes], name, { type: mime }))
  }
  input.files = selection.files
  input.dispatchEvent(new Event("change", { bubbles: true }))
}
