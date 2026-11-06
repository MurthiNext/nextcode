import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { AstQuery } from "./query"
import { AstRewrite } from "./rewrite"
import { FileScope, languageFor } from "./scope"
import { AstError, LIMITS, publicRange, type AstInput, type Execution } from "./types"

const properties = {
    action: { type: "string", enum: ["outline", "search", "locate", "rewrite", "apply"] },
    paths: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1024 }, description: "Files or directories relative to the current session directory. No globs or symbolic links." },
    path: { type: "string", minLength: 1, maxLength: 1024 },
    language: { type: "string", enum: ["java", "python", "py", "typescript", "ts", "tsx", "javascript", "js", "jsx"] },
    pattern: { type: "string", minLength: 1, maxLength: 2048, description: "ast-grep pattern, e.g. System.out.println($ARG). Mutually exclusive with rule." },
    rule: { type: "object", additionalProperties: true, description: "ast-grep Rule object. Supports kind, pattern context/selector, inside, has, all, any, not, etc." },
    constraints: { type: "object", additionalProperties: true },
    utils: { type: "object", additionalProperties: true },
    replacement: { type: "string", maxLength: 2048, description: "ast-grep fix template. Empty string deletes the match. Only generates a preview." },
    line: { type: "integer", minimum: 1 },
    column: { type: "integer", minimum: 1, description: "One-based Unicode code-point column, not a UTF-8 byte offset or UTF-16 index. Defaults to the first non-whitespace column." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum matches or outline files, default 50. Output is also byte-limited." },
    previewId: { type: "string", minLength: 1, maxLength: 64 },
}

export const outputSchema = {
    type: "object",
    additionalProperties: true,
} as const

export const inputSchema = {
    type: "object",
    properties,
    required: ["action"],
    additionalProperties: false,
    oneOf: [
        { properties: { action: { const: "outline" } }, required: ["paths"] },
        { properties: { action: { const: "search" } }, required: ["paths", "language"], oneOf: [{ required: ["pattern"] }, { required: ["rule"] }] },
        { properties: { action: { const: "locate" } }, required: ["path", "line"] },
        { properties: { action: { const: "rewrite" } }, required: ["paths", "language", "replacement"], oneOf: [{ required: ["pattern"] }, { required: ["rule"] }] },
        { properties: { action: { const: "apply" } }, required: ["previewId"] },
    ],
} as const

export class AstTool {
    private readonly query = new AstQuery()
    private readonly rewrite = new AstRewrite(this.query)

    async execute(value: unknown, execution: Execution): Promise<Record<string, unknown>> {
        const input = this.parse(value)
        execution.signal.throwIfAborted()
        const scope = await FileScope.create(execution)
        let result: Record<string, unknown>
        if (input.action === "apply") {
            result = await this.rewrite.apply(scope, input.previewId) as Record<string, unknown>
        } else if (input.action === "locate") {
            const path = await scope.validate(input.path)
            await execution.permission("read", [path])
            result = { action: "locate", ...await this.query.locate(scope, path, input.line, input.column) }
        } else {
            const language = input.language ? languageFor(input.language) : undefined
            const { files, skipped } = await scope.collect(input.paths, language)
            if (input.action === "rewrite") {
                if (skipped.length) throw new AstError("INCOMPLETE_SCAN", "Some files exceed 2 MiB. Narrow paths before rewriting.", { skipped })
                result = await this.rewrite.preview(scope, files, language!, input, input.replacement) as Record<string, unknown>
            } else if (input.action === "outline") {
                const outline = await this.query.outline(scope, files, input.limit ?? LIMITS.matches)
                result = { action: "outline", ...outline, skipped, scanComplete: !outline.truncated && !skipped.length }
            } else {
                const found = await this.query.search(scope, files, language!, input, input.limit ?? LIMITS.matches)
                const matches = found.matches.map((match) => ({
                    path: scope.label(match.file),
                    range: publicRange(match.range),
                    text: match.text.slice(0, 2000),
                    textTruncated: match.text.length > 2000,
                    captures: {
                        ...Object.fromEntries(Object.entries(match.metaVariables?.single ?? {}).slice(0, 20).map(([key, variable]) => [key, variable.text.slice(0, 300)])),
                        ...Object.fromEntries(Object.entries(match.metaVariables?.multi ?? {}).slice(0, 20).map(([key, variables]) => [key, variables.slice(0, 20).map((variable) => variable.text.slice(0, 300))])),
                    },
                    capturesTruncated: Object.keys(match.metaVariables?.single ?? {}).length > 20
                        || Object.keys(match.metaVariables?.multi ?? {}).length > 20
                        || Object.values(match.metaVariables?.single ?? {}).some((variable) => variable.text.length > 300)
                        || Object.values(match.metaVariables?.multi ?? {}).some((variables) => variables.length > 20 || variables.some((variable) => variable.text.length > 300)),
                }))
                result = { action: "search", matches, truncated: found.truncated, scanComplete: !found.truncated && !skipped.length, skipped }
            }
        }
        result.positionEncoding = "unicode-codepoints"
        result.lineBase = 1
        this.budget(result)
        if (input.action !== "apply") execution.signal.throwIfAborted()
        return result
    }

    clear(): void {
        this.query.clear()
        this.rewrite.clear()
    }

    private parse(value: unknown): AstInput {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new AstError("INPUT", "Expected an object.")
        const input = value as Record<string, unknown>
        const allowed: Record<string, string[]> = {
            outline: ["action", "paths", "language", "limit"],
            search: ["action", "paths", "language", "pattern", "rule", "constraints", "utils", "limit"],
            locate: ["action", "path", "line", "column"],
            rewrite: ["action", "paths", "language", "pattern", "rule", "constraints", "utils", "replacement"],
            apply: ["action", "previewId"],
        }
        const keys = typeof input.action === "string" && Object.hasOwn(allowed, input.action) ? allowed[input.action] : undefined
        if (!keys || Object.keys(input).some((key) => !keys.includes(key))) throw new AstError("INPUT", "Unknown action or parameters not applicable to this action.")
        for (const [key, value] of Object.entries(input)) {
            if (["language", "path", "pattern", "replacement", "previewId"].includes(key)
                && (typeof value !== "string" || (key !== "replacement" && !value.length) || value.length > (key === "previewId" ? 64 : 2048))) {
                throw new AstError("INPUT", `Invalid ${key}.`)
            }
            if (["line", "column", "limit"].includes(key) && (!Number.isSafeInteger(value) || (value as number) < 1 || (key === "limit" && (value as number) > 100))) {
                throw new AstError("INPUT", `Invalid ${key}.`)
            }
            if (["rule", "constraints", "utils"].includes(key) && (!value || typeof value !== "object" || Array.isArray(value))) throw new AstError("INPUT", `Invalid ${key}.`)
        }
        if (["outline", "search", "rewrite"].includes(input.action as string) && (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 20
            || input.paths.some((path) => typeof path !== "string" || !path.length || path.length > 1024))) throw new AstError("INPUT", "Provide 1 to 20 file or directory paths.")
        if (["search", "rewrite"].includes(input.action as string) && (!input.language || (input.pattern === undefined) === (input.rule === undefined))) {
            throw new AstError("INPUT", "Provide language and exactly one of pattern or rule.")
        }
        if (input.action === "rewrite" && input.replacement === undefined) throw new AstError("INPUT", "replacement is required.")
        if (input.action === "locate" && (!input.path || !input.line)) throw new AstError("INPUT", "path and line are required.")
        if (input.action === "apply" && !input.previewId) throw new AstError("INPUT", "previewId is required.")
        return input as unknown as AstInput
    }

    private budget(result: Record<string, unknown>): void {
        while (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) {
            if (result.action === "rewrite" || result.action === "apply") throw new AstError("OUTPUT_LIMIT", "Result exceeds the output limit. Narrow paths.")
            const matches = result.matches as { text: string; textTruncated: boolean; captures: Record<string, unknown>; capturesTruncated: boolean }[] | undefined
            const files = result.files as { items: { members?: unknown[] }[]; truncated: boolean }[] | undefined
            const skipped = result.skipped as string[] | undefined
            if (skipped?.length) {
                skipped.pop()
            } else if (matches?.length) {
                if (matches.length > 1) matches.pop()
                else {
                    const keys = Object.keys(matches[0].captures)
                    if (keys.length) {
                        delete matches[0].captures[keys.at(-1)!]
                        matches[0].capturesTruncated = true
                    } else {
                        matches[0].text = matches[0].text.slice(0, Math.floor(matches[0].text.length / 2))
                        matches[0].textTruncated = true
                    }
                }
            } else if (files?.length) {
                if (files.length > 1) files.pop()
                else if (files[0].items.length) {
                    const item = files[0].items.at(-1)!
                    if (item.members?.length) item.members.pop()
                    else files[0].items.pop()
                    files[0].truncated = true
                } else throw new AstError("OUTPUT_LIMIT", "Result exceeds the output limit. Narrow paths.")
            } else if (result.action === "locate" && result.block) {
                const block = result.block as { text: string; truncated: boolean }
                if (block.text.length) {
                    block.text = block.text.slice(0, Math.floor(block.text.length / 2))
                    block.truncated = true
                } else {
                    (result.ancestors as unknown[]).pop()
                }
            } else {
                throw new AstError("OUTPUT_LIMIT", "Result exceeds the output limit. Narrow paths.")
            }
            result.truncated = true
            result.scanComplete = false
        }
    }
}

export async function registerAstTool(context: Plugin.Context): Promise<() => void> {
    const tool = new AstTool()
    await context.tool.transform((editor) => {
        editor.add({
            name: "ast_grep",
            description: "Inspect and rewrite AST structures in Java, Python, JS/TS/TSX. Use outline for signatures, search for structural pattern/rule matches, locate for the enclosing block at a position. Search, locate and rewrite honor ast-grep-ignore suppression comments. Use glob for filenames and grep for plain text instead. rewrite only returns a full diff and a session-bound previewId; apply consumes that preview with edit permission and stale-file checks. Never pass apply=true or write flags. Positions are one-based Unicode code-point columns, ends exclusive; byteOffset is zero-based UTF-8. This is syntax matching, not type-aware reference resolution.",
            input: inputSchema,
            output: outputSchema,
            options: { codemode: true, pinned: true },
            execute: async (input, invocation) => {
                try {
                    const session = await context.session.get({ sessionID: invocation.sessionID })
                    const output = await tool.execute(input, {
                        directory: session.location.directory,
                        sessionID: invocation.sessionID,
                        signal: invocation.signal,
                        permission: async (action, resources, metadata) => {
                            invocation.signal.throwIfAborted()
                            await context.permission.assert({
                                sessionID: invocation.sessionID,
                                agent: invocation.agent,
                                source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
                                action,
                                resources,
                                ...(metadata ? { metadata } : {}),
                            })
                        },
                    })
                    return { output, content: JSON.stringify(output) }
                } catch (error) {
                    if (error instanceof AstError) throw new ToolError({ message: error.message, metadata: { code: error.code, details: error.details } })
                    throw error
                }
            },
        })
    })
    return () => tool.clear()
}
