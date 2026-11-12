import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { LspClient } from "./client"
import { familyFor, projectRoot, resolveServer, type Family } from "./servers"
import { LspError, LIMITS, type DiagnosticsResult, type FileDiagnostic } from "./types"
import { pruneWorkspaces, workspaceKey } from "./workspace"

const JDT_UNRESOLVED = /^The type (?:java|javax|jdk)\.[\w$.]+ cannot be resolved/
const JDT_REASON = "The JDT classpath and JDK are not resolved yet; retry with a larger wait."
const DRIVER_ARGUMENT = /^Invalid argument '.+' not allowed with/
const CLANGD_FLAGS_REASON = "clangd parses this file as C because compile_flags.txt applies to every file. Map it in compile_commands.json or add -xc++-header to compile_flags.txt."

interface ProjectState {
    readonly key: string
    readonly root: string
    readonly family: Family
    client?: LspClient
    status: "idle" | "starting" | "ready" | "failed"
    error?: string
    warm?: Promise<LspClient | undefined>
    retryAt: number
    used: number
    queue: Promise<unknown>
}

export interface DiagnoseInput {
    readonly paths: readonly string[]
    readonly directory: string
    readonly ceiling: string
    readonly wait: number
    readonly startup?: number
    readonly install: boolean
}

export interface DiagnoseOutput {
    readonly files: FileDiagnostic[]
    readonly projects: { root: string; server: string; status: string; error?: string }[]
}

export class LspManager {
    private readonly projects = new Map<string, ProjectState>()
    private prunedAt = 0

    async diagnose(input: DiagnoseInput): Promise<DiagnoseOutput> {
        const found = new Map<string, FileDiagnostic>()
        const projects: DiagnoseOutput["projects"] = []
        const grouped = new Map<string, { state: ProjectState; paths: string[] }>()
        for (const path of input.paths.slice(0, LIMITS.files)) {
            const family = familyFor(path)
            if (!family) {
                found.set(path, { path, phase: "unavailable", diagnostics: [], reason: `Unsupported file type: ${extname(path) || path}` })
                continue
            }
            const root = await projectRoot(path, family, input.ceiling || input.directory)
            const key = `${family}:${root}`
            const entry = grouped.get(key) ?? { state: this.project(key, root, family), paths: [] }
            entry.paths.push(path)
            grouped.set(key, entry)
        }
        await Promise.all([...grouped.values()].map(({ state, paths }) => {
            const job = state.queue.then(() => this.runProject(state, paths, input))
            state.queue = job.catch(() => undefined)
            return job.then((output) => {
                for (const file of output.files) found.set(file.path, file)
                projects.push(output.project)
            })
        }))
        this.sweep()
        return { files: input.paths.slice(0, LIMITS.files).flatMap((path) => found.get(path) ?? []), projects }
    }

    async warm(paths: readonly string[], input: { directory: string; ceiling: string; install?: boolean }): Promise<void> {
        const jobs: Promise<unknown>[] = []
        for (const path of paths.slice(0, LIMITS.files)) {
            const family = familyFor(path)
            if (!family) continue
            const root = await projectRoot(path, family, input.ceiling || input.directory)
            const state = this.project(`${family}:${root}`, root, family)
            if (state.client || state.warm || state.status === "starting" || state.status === "failed") continue
            jobs.push(this.prewarm(state, input.install === true))
        }
        await Promise.allSettled(jobs)
    }

    status(): { root: string; family: string; server?: string; status: string; error?: string; documents: number; used: number }[] {
        return [...this.projects.values()].map((state) => ({
            root: state.root,
            family: state.family,
            server: state.client?.spec.name,
            status: state.status,
            error: state.error,
            documents: state.client?.documents.size ?? 0,
            used: state.used,
        }))
    }

    async dispose(): Promise<void> {
        const clients = [...this.projects.values()].flatMap((state) => state.client ? [state.client] : [])
        this.projects.clear()
        await Promise.allSettled(clients.map((client) => client.stop()))
    }

    private project(key: string, root: string, family: Family): ProjectState {
        const existing = this.projects.get(key)
        if (existing) return existing
        const state: ProjectState = { key, root, family, status: "idle", retryAt: 0, used: Date.now(), queue: Promise.resolve() }
        this.projects.set(key, state)
        return state
    }

    private async runProject(state: ProjectState, paths: readonly string[], input: DiagnoseInput): Promise<{ files: FileDiagnostic[]; project: DiagnoseOutput["projects"][number] }> {
        const files: FileDiagnostic[] = []
        const client = await this.startWithin(state, input.install, input.startup ?? Math.max(input.wait, 1200))
        if (!client) {
            const reason = state.status === "failed" ? state.error ?? "Language server could not start." : "Language server is still starting."
            for (const path of paths) {
                files.push({ path, phase: state.status === "failed" ? "unavailable" : "pending", diagnostics: [], reason })
            }
            return { files, project: { root: state.root, server: state.family, status: state.status, ...(state.error ? { error: state.error } : {}) } }
        }
        const deadline = Date.now() + Math.max(0, Math.min(input.wait, LIMITS.maxWait))
        for (const raw of paths) {
            let text: string
            try {
                text = await readFile(raw, "utf8")
            } catch {
                files.push({ path: raw, phase: "unavailable", diagnostics: [], reason: "File could not be read." })
                continue
            }
            const path = raw
            try {
                await client.sync(path, text)
                const result = this.checkFamily(state, await client.diagnostics(path, Math.max(0, deadline - Date.now())))
                files.push({ path, phase: result.phase, diagnostics: result.diagnostics, checkedAt: result.checkedAt, reason: result.reason })
            } catch (error) {
                if (error instanceof LspError && error.code === "EXIT") {
                    files.push({ path, phase: "pending", diagnostics: [], reason: "Language server exited; restarting." })
                    state.client = undefined
                    state.status = "idle"
                    continue
                }
                files.push({ path, phase: "unavailable", diagnostics: [], reason: error instanceof Error ? error.message : String(error) })
            }
        }
        return { files, project: { root: state.root, server: client.spec.name, status: "ready" } }
    }

    private checkFamily(state: ProjectState, result: DiagnosticsResult): DiagnosticsResult {
        if (result.phase !== "available" || !result.diagnostics.length) return result
        if (state.family === "java" && result.diagnostics.some((diagnostic) => JDT_UNRESOLVED.test(diagnostic.message))) {
            return { phase: "pending", diagnostics: [], reason: JDT_REASON }
        }
        if (state.family === "c") {
            const driver = result.diagnostics.filter((diagnostic) => DRIVER_ARGUMENT.test(diagnostic.message))
            if (driver.length === result.diagnostics.length) return { phase: "unavailable", diagnostics: [], reason: CLANGD_FLAGS_REASON }
        }
        return result
    }

    private async prewarm(state: ProjectState, install: boolean): Promise<void> {
        let resolved
        try {
            resolved = await resolveServer(state.family, state.root, { install })
        } catch {
            return
        }
        state.status = "starting"
        const warm = LspClient.start(resolved.spec, state.root).then((client) => {
            state.client = client
            state.status = "ready"
            state.used = Date.now()
            return client
        }).catch(() => {
            state.status = "idle"
            return undefined
        }).finally(() => {
            state.warm = undefined
        })
        state.warm = warm
        await warm
    }

    private async startWithin(state: ProjectState, install: boolean, budget: number): Promise<LspClient | undefined> {
        const promise = this.start(state, install)
        return new Promise<LspClient | undefined>((resolve) => {
            const timer = setTimeout(() => resolve(state.client), Math.max(0, budget))
            promise.then((client) => {
                clearTimeout(timer)
                resolve(client ?? state.client)
            }, () => {
                clearTimeout(timer)
                resolve(state.client)
            })
        })
    }

    private async start(state: ProjectState, install: boolean): Promise<LspClient | undefined> {
        state.used = Date.now()
        if (state.client && !state.client.crashed) return state.client
        if (state.client?.crashed) {
            state.client = undefined
            state.status = "idle"
            state.error = "Language server exited; restarting."
        }
        if (state.warm) {
            const warm = await state.warm
            if (warm && !warm.crashed) return warm
        }
        if (state.status === "starting") return undefined
        if (state.status === "failed" && Date.now() < state.retryAt) return undefined
        state.status = "starting"
        state.error = undefined
        const launched = this.launch(state, install)
        state.warm = launched
        try {
            return await launched
        } finally {
            state.warm = undefined
        }
    }

    private async launch(state: ProjectState, install: boolean): Promise<LspClient | undefined> {
        try {
            const resolved = await resolveServer(state.family, state.root, { install })
            const client = await LspClient.start(resolved.spec, state.root)
            state.client = client
            state.status = "ready"
            return client
        } catch (error) {
            state.status = "failed"
            state.error = error instanceof LspError ? error.message : error instanceof Error ? error.message : String(error)
            state.retryAt = Date.now() + (error instanceof LspError && error.code === "MISSING_RUNTIME" ? 300_000 : 20_000)
            return undefined
        }
    }

    private sweep(): void {
        const ready = [...this.projects.values()].filter((state) => state.client && state.status === "ready")
        const excess = ready.length - LIMITS.servers
        if (excess > 0) {
            ready.sort((a, b) => a.used - b.used)
            for (const state of ready.slice(0, excess)) {
                void state.client?.stop()
                state.client = undefined
                state.status = "idle"
            }
        }
        for (const [key, state] of this.projects) {
            if (state.client && Date.now() - state.used > LIMITS.idle) {
                void state.client.stop()
                this.projects.delete(key)
            }
        }
        if (Date.now() < this.prunedAt + LIMITS.workspaceStale) return
        this.prunedAt = Date.now()
        const active = new Set([...this.projects.values()]
            .filter((state) => state.family === "java" && state.client)
            .map((state) => workspaceKey(state.root)))
        // Deleting abandoned workspaces can remove hundreds of megabytes; never block a check on it.
        void pruneWorkspaces(active).catch(() => undefined)
    }
}
