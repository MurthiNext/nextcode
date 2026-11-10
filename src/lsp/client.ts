import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { realpath } from "node:fs/promises"
import { extname } from "node:path"
import { JsonRpc } from "./protocol"
import type { Diagnostic, DiagnosticsResult, DocumentState, PublishedDiagnostics } from "./types"
import { LspError, LIMITS } from "./types"
import { pathKey, pathToUri, uriToPath } from "./uri"

export interface ServerSpec {
    readonly name: string
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly env?: Readonly<Record<string, string>>
    readonly initializationOptions?: unknown
    readonly settings?: Readonly<Record<string, unknown>>
    readonly pull?: boolean
}

const LANGUAGE_IDS: Record<string, string> = {
    ".java": "java",
    ".py": "python",
    ".pyi": "python",
    ".c": "c",
    ".h": "cpp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hh": "cpp",
    ".hxx": "cpp",
    ".ipp": "cpp",
    ".inl": "cpp",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascriptreact",
}

export function languageID(path: string): string {
    return LANGUAGE_IDS[extname(path).toLowerCase()] ?? "plaintext"
}

export class LspClient {
    readonly documents = new Map<string, DocumentState>()
    readonly published = new Map<string, PublishedDiagnostics>()
    readonly stderr: string[] = []
    private readonly aliases = new Map<string, string>()
    private readonly progress = new Map<string, string>()
    private readonly progressAt = new Map<string, number>()
    private pullQueue: Promise<unknown> = Promise.resolve()
    private stopped = false
    private exited = false
    private exitedPromise: Promise<void>

    private constructor(
        private readonly child: ChildProcessByStdio<Writable, Readable, Readable>,
        private readonly rpc: JsonRpc,
        readonly spec: ServerSpec,
        readonly root: string,
        readonly positionEncoding: string,
        private pullSupported: boolean,
        exited: Promise<void>,
    ) {
        this.exitedPromise = exited
        child.once("exit", () => this.markExited())
        child.once("error", () => this.markExited())
        child.stderr.on("data", (chunk: Buffer) => {
            if (this.stderr.length >= 200) return
            const text = chunk.toString("utf8").trim()
            if (text) this.stderr.push(text.slice(0, 500))
        })
    }

    get crashed(): boolean {
        return this.exited && !this.stopped
    }

    static async start(spec: ServerSpec, root: string): Promise<LspClient> {
        const child = spawn(spec.command, [...spec.args], {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.env },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
        })
        let resolveExit!: () => void
        const exited = new Promise<void>((resolve) => { resolveExit = resolve })
        let client: LspClient | undefined
        const rpc = new JsonRpc(child.stdout, child.stdin, {
            request: (method, params) => client?.handleRequest(method, params) ?? null,
            notify: (method, params) => client?.handleNotify(method, params),
        }, () => resolveExit())
        try {
            await new Promise<void>((resolve, reject) => {
                child.once("spawn", resolve)
                child.once("error", reject)
            })
            const rootUri = pathToUri(root)
            const result = await rpc.request<{
                capabilities?: { diagnosticProvider?: unknown; positionEncoding?: string }
            }>("initialize", {
                processId: process.pid,
                clientInfo: { name: "nextcode", version: "0.1.0" },
                rootUri,
                rootPath: root,
                workspaceFolders: [{ uri: rootUri, name: root.split(/[\\/]/).pop() ?? "workspace" }],
                initializationOptions: spec.initializationOptions,
                trace: "off",
                capabilities: {
                    general: { positionEncodings: ["utf-16"] },
                    workspace: {
                        applyEdit: true,
                        configuration: true,
                        workspaceFolders: true,
                        didChangeConfiguration: { dynamicRegistration: true },
                        didChangeWatchedFiles: { dynamicRegistration: false },
                        diagnostic: { refreshSupport: false },
                        symbol: { dynamicRegistration: false },
                    },
                    window: { workDoneProgress: true, showMessage: {} },
                    textDocument: {
                        synchronization: { dynamicRegistration: false, willSave: false, didSave: true, willSaveWaitUntil: false },
                        publishDiagnostics: {
                            relatedInformation: true,
                            versionSupport: true,
                            codeDescriptionSupport: true,
                            dataSupport: false,
                            tagSupport: { valueSet: [1, 2] },
                        },
                        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
                        hover: { contentFormat: ["plaintext", "markdown"] },
                    },
                },
            }, LIMITS.initialize)
            client = new LspClient(
                child,
                rpc,
                spec,
                root,
                result?.capabilities?.positionEncoding ?? "utf-16",
                Boolean(result?.capabilities?.diagnosticProvider) && spec.pull !== false,
                exited,
            )
            rpc.notify("initialized", {})
            if (spec.settings) rpc.notify("workspace/didChangeConfiguration", { settings: spec.settings })
            return client
        } catch (error) {
            rpc.dispose("Language server initialization failed.")
            child.kill()
            throw error instanceof LspError ? error : new LspError("INITIALIZE", error instanceof Error ? error.message : String(error))
        }
    }

    async stop(): Promise<void> {
        if (this.stopped) return
        this.stopped = true
        try {
            await this.rpc.request("shutdown", null, 2000)
            this.rpc.notify("exit", null)
        } catch {
            // Server already gone or refusing to shut down; kill it below.
        }
        this.rpc.dispose("Language server stopped.")
        const timer = setTimeout(() => this.child.kill(), 1500)
        await Promise.race([this.exitedPromise, new Promise((resolve) => setTimeout(resolve, 1500))])
        clearTimeout(timer)
        this.child.kill()
    }

    sync(path: string, text: string): Promise<DocumentState> {
        return this.openDocument(path, text)
    }

    private async openDocument(path: string, text: string): Promise<DocumentState> {
        const canonical = await realpath(path).catch(() => path)
        const key = pathKey(canonical)
        this.aliases.set(pathKey(path), key)
        this.aliases.set(pathKey(canonical), key)
        const existing = this.documents.get(key)
        if (existing && existing.text === text) return existing
        const version = (existing?.version ?? 0) + 1
        const document: DocumentState = {
            path: existing?.path ?? canonical,
            uri: existing?.uri ?? pathToUri(canonical),
            version,
            text,
            syncedAt: Date.now(),
        }
        this.documents.set(key, document)
        this.trim()
        if (!existing) {
            this.rpc.notify("textDocument/didOpen", {
                textDocument: { uri: document.uri, languageId: languageID(canonical), version, text },
            })
        } else {
            this.rpc.notify("textDocument/didChange", {
                textDocument: { uri: document.uri, version },
                contentChanges: [{ text }],
            })
        }
        return document
    }

    close(path: string): void {
        const key = this.canonicalKey(path)
        const document = this.documents.get(key)
        if (!document) return
        this.documents.delete(key)
        this.published.delete(key)
        this.rpc.notify("textDocument/didClose", { textDocument: { uri: document.uri } })
    }

    private trim(): void {
        if (this.documents.size <= LIMITS.documents) return
        const oldest = [...this.documents.entries()].sort((a, b) => a[1].syncedAt - b[1].syncedAt).slice(0, this.documents.size - LIMITS.documents)
        for (const [key, document] of oldest) {
            this.documents.delete(key)
            this.published.delete(key)
            this.rpc.notify("textDocument/didClose", { textDocument: { uri: document.uri } })
        }
    }

    async diagnostics(path: string, wait: number = LIMITS.wait): Promise<DiagnosticsResult> {
        const key = this.canonicalKey(path)
        const document = this.documents.get(key)
        if (!document) return { phase: "unavailable", diagnostics: [], reason: "Document is not open in the language server." }
        const deadline = Date.now() + Math.max(0, Math.min(wait, LIMITS.maxWait))
        for (;;) {
            const result = await this.probe(key, document)
            if (result) return result
            if (Date.now() >= deadline || this.crashed) break
            await new Promise((resolve) => setTimeout(resolve, Math.min(LIMITS.poll, Math.max(0, deadline - Date.now()))))
        }
        const result = await this.probe(key, document)
        if (result) return result
        if (this.crashed) return { phase: "unavailable", diagnostics: [], reason: "Language server exited." }
        if (this.busy) return { phase: "pending", diagnostics: [], reason: `${this.busy.trim()} is still running.` }
        const latest = this.published.get(key)
        if (latest) return { phase: "stale", diagnostics: latest.diagnostics, checkedAt: latest.at, reason: "Diagnostics are older than the current file content." }
        return { phase: "pending", diagnostics: [], reason: "Language server has not reported diagnostics yet." }
    }

    private async probe(key: string, document: DocumentState): Promise<DiagnosticsResult | undefined> {
        if (this.pullSupported) {
            const pulled = await this.pull(key).catch(() => undefined)
            if (pulled) return pulled
        }
        const published = this.published.get(key)
        if (!published || !this.fresh(published, document)) return undefined
        // JDTLS publishes an empty set from its first build, then publishes again once the
        // workspace import finishes. Treat an empty publish while it is still working as pending.
        if (this.busy && !published.diagnostics.length) return undefined
        return { phase: "available", diagnostics: published.diagnostics, checkedAt: published.at }
    }

    private fresh(published: PublishedDiagnostics, document: DocumentState): boolean {
        if (typeof published.version === "number") return published.version >= document.version
        return published.at >= document.syncedAt
    }

    private async pull(key: string): Promise<DiagnosticsResult | undefined> {
        const run = this.pullQueue.then(() => this.performPull(key))
        this.pullQueue = run.then(() => undefined, () => undefined)
        return run
    }

    private async performPull(key: string): Promise<DiagnosticsResult | undefined> {
        try {
            const document = this.documents.get(key)
            if (!document) return undefined
            const version = document.version
            const result = await this.rpc.request<{
                kind: "full" | "unchanged"
                items?: Diagnostic[]
                resultId?: string
                relatedDocuments?: Record<string, { kind: "full" | "unchanged"; items?: Diagnostic[]; resultId?: string }>
            }>("textDocument/diagnostic", { textDocument: { uri: document.uri } }, LIMITS.request)
            if (!result) return undefined
            const items = result.kind === "unchanged" ? this.published.get(key)?.diagnostics ?? [] : result.items ?? []
            const at = Date.now()
            this.published.set(key, { version, diagnostics: items, at })
            for (const [uri, related] of Object.entries(result.relatedDocuments ?? {})) {
                const path = uriToPath(uri)
                if (!path || related.kind === "unchanged") continue
                this.published.set(pathKey(path), { diagnostics: related.items ?? [], at })
            }
            return { phase: "available", diagnostics: items, checkedAt: at }
        } catch (error) {
            if (error instanceof LspError && error.code === "SERVER" && /method/i.test(error.message)) {
                this.pullSupported = false
                return undefined
            }
            throw error
        }
    }

    private handleRequest(method: string, params: unknown): unknown {
        switch (method) {
            case "workspace/configuration": {
                const items = (params as { items?: { section?: string }[] } | undefined)?.items ?? []
                return items.map((item) => this.section(item.section))
            }
            case "workspace/workspaceFolders":
                return [{ uri: pathToUri(this.root), name: this.root.split(/[\\/]/).pop() ?? "workspace" }]
            case "workspace/applyEdit":
                return { applied: false, failureReason: "nextcode does not apply language server edits." }
            case "window/workDoneProgress/create":
            case "client/registerCapability":
            case "client/unregisterCapability":
            case "workspace/codeLens/refresh":
            case "workspace/inlayHint/refresh":
            case "workspace/inlineValue/refresh":
            case "workspace/diagnostic/refresh":
            case "window/showMessageRequest":
                return null
            default:
                return null
        }
    }

    private section(section?: string): unknown {        if (!section) return this.spec.settings ?? {}
        if (this.spec.settings && Object.hasOwn(this.spec.settings, section)) return this.spec.settings[section]
        let current: unknown = this.spec.settings
        for (const part of section.split(".")) {
            if (!current || typeof current !== "object") return {}
            current = (current as Record<string, unknown>)[part]
        }
        return current ?? {}
    }

    private canonicalKey(path: string): string {
        const key = pathKey(path)
        return this.aliases.get(key) ?? key
    }

    private handleNotify(method: string, params: unknown): void {
        if (method === "$/progress") {
            const value = (params as { token?: unknown; value?: { kind?: string; title?: string; message?: string } } | undefined)?.value
            const token = String((params as { token?: unknown } | undefined)?.token ?? "")
            if (!value || !token) return
            if (value.kind === "begin") this.progress.set(token, value.title ?? value.message ?? "working")
            else if (value.kind === "report") this.progress.set(token, value.message ?? this.progress.get(token) ?? "working")
            else if (value.kind === "end") this.progress.delete(token)
            else return
            this.progressAt.set(token, Date.now())
            return
        }
        if (method !== "textDocument/publishDiagnostics") return
        const payload = params as { uri?: string; version?: number; diagnostics?: Diagnostic[] } | undefined
        const path = payload?.uri ? uriToPath(payload.uri) : undefined
        if (!path) return
        const entry: PublishedDiagnostics = {
            version: typeof payload?.version === "number" ? payload.version : undefined,
            diagnostics: payload?.diagnostics ?? [],
            at: Date.now(),
        }
        const key = this.canonicalKey(path)
        this.published.set(key, entry)
    }

    get busy(): string | undefined {
        this.pruneProgress()
        return [...this.progress.values()].at(-1)
    }

    // A language server can begin a progress token and never end it (wedged Gradle import),
    // so a token that stops reporting must stop blocking diagnostics.
    private pruneProgress(): void {
        for (const [token] of this.progress) {
            if (Date.now() - (this.progressAt.get(token) ?? 0) < LIMITS.progressStale) continue
            this.progress.delete(token)
            this.progressAt.delete(token)
        }
    }

    private markExited(): void {
        if (this.exited) return
        this.exited = true
        this.rpc.dispose("Language server exited.")
    }
}
