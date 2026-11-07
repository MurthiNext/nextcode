import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { editsFromTool, isEditTool } from "./changes"
import { formatFile, relativeLabel } from "./format"
import { LspManager } from "./manager"
import { familyFor } from "./servers"
import { assertInstallAllowed, registerLspTool } from "./tool"
import { pathKey } from "./uri"

const LSP_GUIDANCE = `# lsp
Edits to Java, Python and JS/TS/TSX are checked by a persistent language server; its errors are attached to the edit result.
- Use the lsp tool (action diagnostics) to wait out a cold start or Java indexing, or to confirm that a fix cleared earlier errors.
- Only errors are reported automatically. Set warnings when warnings matter.
- A pending check is not a passing check; do not claim the code is correct before it finishes.
- Builds and tests remain the authority for runtime behaviour.`

interface SessionState {
    readonly paths: Set<string>
    readonly stale: Map<string, number>
    readonly reported: Map<string, string>
}

export interface LspOptions {
    readonly install: boolean
    readonly warnings: boolean
}

export function lspOptions(options: Readonly<Record<string, unknown>>): LspOptions {
    return { install: options.install !== false, warnings: options.warnings === true }
}

export async function registerLsp(context: Plugin.Context, options: LspOptions): Promise<() => Promise<void>> {
    const manager = new LspManager()
    const sessions = new Map<string, SessionState>()
    const prepared = new Map<string, string[]>()
    const state = (sessionID: string): SessionState => {
        const existing = sessions.get(sessionID)
        if (existing) return existing
        const created: SessionState = { paths: new Set<string>(), stale: new Map<string, number>(), reported: new Map<string, string>() }
        sessions.set(sessionID, created)
        if (sessions.size > 64) sessions.delete(sessions.keys().next().value!)
        return created
    }
    const directoryOf = async (sessionID: string): Promise<string> => (await context.session.get({ sessionID })).location.directory
    const absolute = (directory: string) => (path: string) => isAbsolute(path) ? path : resolve(directory, path)

    const before = await context.tool.hook("execute.before", (event) => {
        if (!isEditTool(event.tool)) return
        const { paths } = editsFromTool(event.tool, event.input, undefined)
        if (!paths.length) return
        prepared.set(event.id, paths)
        if (prepared.size > 256) prepared.delete(prepared.keys().next().value!)
        void directoryOf(event.sessionID).then((directory) => {
            const supported = paths.map(absolute(directory)).filter((path) => familyFor(path))
            if (supported.length) void manager.warm(supported, { directory, ceiling: directory }).catch(() => undefined)
        }).catch(() => undefined)
    })

    const after = await context.tool.hook("execute.after", async (event) => {
        const earlier = prepared.get(event.id)
        prepared.delete(event.id)
        if (!isEditTool(event.tool) || event.status !== "completed") return
        const { paths } = editsFromTool(event.tool, event.input, event.result?.output)
        const targets = paths.length ? paths : earlier ?? []
        if (!targets.length) return
        const directory = await directoryOf(event.sessionID).catch(() => undefined)
        if (!directory) return
        const supported = targets.map(absolute(directory)).filter((path) => familyFor(path))
        if (!supported.length) return
        const session = state(event.sessionID)
        for (const path of supported) session.paths.add(path)
        const allowed = options.install ? await assertInstallAllowed(context, event, supported, directory).catch(() => true) : true
        const result = await manager.diagnose({ paths: supported, directory, ceiling: directory, wait: 800, startup: 900, install: allowed })
        const pending = result.files.filter((file) => file.phase !== "available")
        for (const file of result.files) {
            if (file.phase === "available") session.stale.delete(file.path)
            else session.stale.set(file.path, Date.now())
        }
        const blocks: string[] = []
        const cleared: string[] = []
        for (const file of result.files) {
            const text = await readFile(file.path, "utf8").catch(() => undefined)
            const block = formatFile(file, { root: directory, warnings: options.warnings, text })
            if (!block) {
                if (file.phase === "available" && session.reported.delete(file.path)) cleared.push(relativeLabel(file.path, directory))
                continue
            }
            if (session.reported.get(file.path) === block) continue
            session.reported.set(file.path, block)
            blocks.push(block)
        }
        const notes: string[] = []
        if (cleared.length) notes.push(`${cleared.join(", ")}: no errors reported now.`)
        if (pending.some((file) => file.phase === "pending")) notes.push("Analysis is still running for at least one file; results will follow.")
        if (pending.some((file) => file.phase === "stale")) notes.push("Some diagnostics are older than the current file; the lsp tool can refresh them.")
        if (!blocks.length && !notes.length) return
        append(event.result, [`# lsp diagnostics`, ...blocks, ...notes].join("\n"))
    })

    const guidance = await context.session.hook("context", async (event) => {
        const session = sessions.get(event.sessionID)
        const entries = [...(session?.stale ?? new Map<string, number>())]
        const paths = entries.filter(([, since]) => Date.now() - since < 5 * 60 * 1000).map(([path]) => path)
        let body = ""
        if (paths.length) {
            const directory = await directoryOf(event.sessionID).catch(() => undefined)
            if (directory) {
                const result = await manager.diagnose({ paths, directory, ceiling: directory, wait: 1500, startup: 600, install: false })
                const blocks: string[] = []
                for (const file of result.files) {
                    if (file.phase !== "pending") session?.stale.delete(file.path)
                    const text = await readFile(file.path, "utf8").catch(() => undefined)
                    const block = formatFile(file, { root: directory, warnings: options.warnings, text })
                    if (block) blocks.push(block)
                }
                if (blocks.length) body = `# lsp follow-up\n${blocks.join("\n")}`
            }
        }
        event.system.push({ type: "text", text: body ? `${LSP_GUIDANCE}\n\n${body}` : LSP_GUIDANCE })
    })

    const tool = await registerLspTool(context, {
        manager,
        directory: directoryOf,
        tracked: (sessionID) => [...(sessions.get(sessionID)?.paths ?? [])],
        track: (sessionID, trackedDirectory, paths) => {
            const session = state(sessionID)
            for (const path of paths) session.paths.add(isAbsolute(path) ? path : resolve(trackedDirectory, path))
        },
        install: options.install,
    })

    const controller = new AbortController()
    void (async () => {
        try {
            for await (const event of context.event.subscribe({ signal: controller.signal })) {
                if (event.type !== "filesystem.changed" || event.data.event === "unlink") continue
                const changed = pathKey(resolve(event.data.file))
                for (const session of sessions.values()) {
                    for (const path of session.paths) {
                        if (pathKey(path) === changed) session.stale.set(path, Date.now())
                    }
                }
            }
        } catch {
            // The subscription ends with the plugin.
        }
    })()

    return async () => {
        controller.abort()
        await Promise.allSettled([before.dispose(), after.dispose(), guidance.dispose(), tool])
        await manager.dispose()
    }
}

function append(result: { content?: string | readonly { type: string; text?: string }[] } | undefined, text: string): void {
    if (!result || !text) return
    if (typeof result.content === "string") {
        result.content = `${result.content}\n\n${text}`
        return
    }
    if (Array.isArray(result.content)) {
        result.content = [...result.content, { type: "text", text }]
        return
    }
    result.content = text
}
