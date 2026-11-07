import { relative } from "node:path"
import type { FileDiagnostic } from "./types"
import { LIMITS } from "./types"
import { codePointColumn } from "./uri"

export interface FormatOptions {
    readonly root: string
    readonly warnings?: boolean
    readonly text?: string
}

export function formatFile(file: FileDiagnostic, options: FormatOptions): string {
    const label = relativeLabel(file.path, options.root)
    if (file.phase === "unavailable") return `${label}: check unavailable — ${file.reason ?? "language server failed"}`
    const limit = options.warnings ? 2 : 1
    const shown = file.diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) <= limit)
    if (!shown.length) return file.phase === "pending" ? `${label}: analysis pending; no result yet` : ""
    const lines: string[] = []
    let bytes = 0
    let omitted = 0
    for (const diagnostic of shown) {
        if (lines.length >= LIMITS.diagnostics || bytes >= LIMITS.outputBytes) {
            omitted = shown.length - lines.length
            break
        }
        const line = diagnostic.range.start.line + 1
        const column = options.text === undefined ? diagnostic.range.start.character + 1 : codePointColumn(options.text, diagnostic.range.start)
        const code = diagnostic.code === undefined ? "" : ` [${diagnostic.code}]`
        const rendered = `${label}:${line}:${column} ${severityName(diagnostic.severity)}${code} ${diagnostic.message.replace(/\s+/g, " ").slice(0, LIMITS.message)}`
        lines.push(rendered)
        bytes += Buffer.byteLength(rendered) + 1
    }
    if (omitted) lines.push(`${label}: ${omitted} more diagnostic(s) omitted`)
    return lines.join("\n")
}

export function relativeLabel(path: string, root: string): string {
    if (!root) return path.replace(/\\/g, "/")
    const value = relative(root, path).split("\\").join("/")
    return value.startsWith("..") || value === "" ? path.replace(/\\/g, "/") : value
}

function severityName(severity?: number): string {
    if (severity === 2) return "warning"
    if (severity === 3) return "info"
    if (severity === 4) return "hint"
    return "error"
}
