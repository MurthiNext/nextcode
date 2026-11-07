export function pathToUri(path: string): string {
    const normalized = path.replace(/\\/g, "/")
    const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`
    return `file://${encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F")}`
}

export function uriToPath(uri: string): string | undefined {
    if (!uri.startsWith("file://")) return undefined
    let path: string
    try {
        path = decodeURIComponent(uri.slice(7).split("#")[0].split("?")[0])
    } catch {
        return undefined
    }
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    return path
}

export function pathKey(path: string): string {
    const normalized = path.replace(/\\/g, "/")
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function codePointColumn(text: string, position: { line: number; character: number }): number {
    const lines = text.split(/\r\n|\r|\n/)
    const line = lines[Math.max(0, Math.min(position.line, lines.length - 1))] ?? ""
    const slice = line.slice(0, Math.max(0, position.character))
    return Array.from(slice).length + 1
}
