import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { cacheRoot } from "./installer"
import { formatFile, relativeLabel } from "./format"
import { LspManager } from "./manager"
import { familyFor, projectRoot, resolveServer } from "./servers"
import { LspError, LIMITS } from "./types"
import { codePointColumn } from "./uri"

export const inputSchema = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["diagnostics", "status"] },
        paths: {
            type: "array",
            minItems: 1,
            maxItems: LIMITS.files,
            items: { type: "string", minLength: 1, maxLength: 1024 },
            description: "Files relative to the session directory. Defaults to files edited in this session.",
        },
        wait: { type: "integer", minimum: 0, maximum: LIMITS.maxWait, description: "Milliseconds to wait for analysis, default 5000." },
        warnings: { type: "boolean", description: "Include warnings in addition to errors." },
    },
    required: ["action"],
    additionalProperties: false,
} as const

export const outputSchema = {
    type: "object",
    additionalProperties: true,
} as const

export interface LspToolOptions {
    readonly manager: LspManager
    readonly directory: (sessionID: string) => Promise<string>
    readonly tracked: (sessionID: string) => string[]
    readonly track: (sessionID: string, directory: string, paths: readonly string[]) => void
    readonly install: boolean
}

export class LspTool {
    constructor(private readonly options: LspToolOptions) {}

    async execute(value: unknown, execution: {
        sessionID: string
        signal: AbortSignal
        permission: (action: "read" | "edit", resources: string[]) => Promise<void>
    }): Promise<Record<string, unknown>> {
        const input = this.parse(value)
        execution.signal.throwIfAborted()
        if (input.action === "status") {
            return {
                action: "status",
                cache: cacheRoot(),
                projects: this.options.manager.status().map((project) => ({
                    root: project.root,
                    family: project.family,
                    server: project.server ?? null,
                    status: project.status,
                    error: project.error ?? null,
                    documents: project.documents,
                })),
            }
        }
        const directory = await this.options.directory(execution.sessionID)
        const requested = input.paths ?? this.options.tracked(execution.sessionID)
        const paths = requested.map((path) => isAbsolute(path) ? path : resolve(directory, path))
        if (!paths.length) throw new LspError("NO_FILES", "No files to check. Pass paths or edit a supported file first.")
        await execution.permission("read", paths)
        this.options.track(execution.sessionID, directory, requested)
        const reason = await requiresInstall(paths, directory)
        if (reason) await execution.permission("edit", [cacheRoot()])
        const result = await this.options.manager.diagnose({
            paths,
            directory,
            ceiling: directory,
            wait: input.wait ?? 5000,
            install: this.options.install,
        })
        execution.signal.throwIfAborted()
        const blocks: string[] = []
        const files: Record<string, unknown>[] = []
        for (const file of result.files) {
            const text = await readFile(file.path, "utf8").catch(() => undefined)
            const block = formatFile(file, { root: directory, warnings: input.warnings === true, text })
            if (block) blocks.push(block)
            files.push({
                path: relativeLabel(file.path, directory),
                phase: file.phase,
                ...(file.reason ? { reason: file.reason } : {}),
                diagnostics: file.diagnostics.slice(0, LIMITS.diagnostics).map((diagnostic) => ({
                    line: diagnostic.range.start.line + 1,
                    column: text === undefined ? diagnostic.range.start.character + 1 : codePointColumn(text, diagnostic.range.start),
                    severity: diagnostic.severity ?? 1,
                    code: diagnostic.code ?? null,
                    message: diagnostic.message.slice(0, LIMITS.message),
                })),
            })
        }
        return {
            action: "diagnostics",
            text: blocks.join("\n") || "No errors reported for the requested files.",
            projects: result.projects,
            files,
        }
    }

    private parse(value: unknown): { action: "diagnostics" | "status"; paths?: string[]; wait?: number; warnings?: boolean } {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new LspError("INPUT", "Expected an object.")
        const input = value as Record<string, unknown>
        if (input.action !== "diagnostics" && input.action !== "status") throw new LspError("INPUT", "Unknown action.")
        const allowed = input.action === "status" ? ["action"] : ["action", "paths", "wait", "warnings"]
        if (Object.keys(input).some((key) => !allowed.includes(key))) throw new LspError("INPUT", "Parameters do not apply to this action.")
        if (input.paths !== undefined && (!Array.isArray(input.paths) || !input.paths.length
            || input.paths.some((path) => typeof path !== "string" || !path.length || path.length > 1024))) {
            throw new LspError("INPUT", "Provide 1 to 16 file paths.")
        }
        if (input.wait !== undefined && (!Number.isSafeInteger(input.wait) || (input.wait as number) < 0 || (input.wait as number) > LIMITS.maxWait)) {
            throw new LspError("INPUT", "wait must be an integer between 0 and 15000.")
        }
        if (input.warnings !== undefined && typeof input.warnings !== "boolean") throw new LspError("INPUT", "warnings must be a boolean.")
        return input as { action: "diagnostics" | "status"; paths?: string[]; wait?: number; warnings?: boolean }
    }
}

export async function registerLspTool(context: Plugin.Context, options: LspToolOptions): Promise<() => Promise<void>> {
    const tool = new LspTool(options)
    const registration = await context.tool.transform((editor) => {
        editor.add({
            name: "lsp",
            description: "Read syntax and semantic diagnostics for Java, Python and JS/TS/TSX from a persistent language server. Edits are checked automatically; use this to wait out a cold start or Java indexing, or to confirm that a fix cleared previous errors. Lines are one-based and columns count Unicode code points. This is type-aware analysis, not a build or test run.",
            input: inputSchema,
            output: outputSchema,
            options: { codemode: true },
            execute: async (input, invocation) => {
                try {
                    const output = await tool.execute(input, {
                        sessionID: invocation.sessionID,
                        signal: invocation.signal,
                        permission: async (action, resources) => {
                            invocation.signal.throwIfAborted()
                            await context.permission.assert({
                                sessionID: invocation.sessionID,
                                agent: invocation.agent,
                                source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
                                action,
                                resources,
                            })
                        },
                    })
                    const text = typeof output.text === "string" ? output.text : JSON.stringify(output)
                    const { text: _text, ...rest } = output
                    return { output: rest, content: text }
                } catch (error) {
                    if (error instanceof LspError) throw new ToolError({ message: error.message, metadata: { code: error.code, details: error.details } })
                    throw error
                }
            },
        })
    })
    return () => registration.dispose()
}

export async function requiresInstall(paths: readonly string[], directory: string): Promise<string | undefined> {
    for (const path of paths) {
        const family = familyFor(path)
        if (!family) continue
        const root = await projectRoot(path, family, directory)
        try {
            await resolveServer(family, root, { install: false })
        } catch (error) {
            if (error instanceof LspError && error.code.startsWith("MISSING")) return error.message
        }
    }
    return undefined
}

export async function assertInstallAllowed(
    context: Plugin.Context,
    event: { sessionID: string; agent: string; messageID: string; id: string },
    paths: readonly string[],
    directory: string,
): Promise<boolean> {
    const reason = await requiresInstall(paths, directory)
    if (!reason) return true
    try {
        await context.permission.assert({
            sessionID: event.sessionID,
            agent: event.agent,
            source: { type: "tool", messageID: event.messageID, id: event.id },
            action: "edit",
            resources: [cacheRoot()],
            metadata: { reason },
        })
        return true
    } catch {
        return false
    }
}
