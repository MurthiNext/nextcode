export interface ChangeSet {
    readonly paths: string[]
}

const ADD = /^\*\*\* Add File: (.+)$/gm
const UPDATE = /^\*\*\* Update File: (.+)$/gm
const DELETE = /^\*\*\* Delete File: (.+)$/gm
const MOVE_TO = /^\*\*\* Move to: (.+)$/gm

export function isEditTool(tool: string): boolean {
    return tool === "edit" || tool === "write" || tool === "patch" || tool === "ast_grep"
}

export function editsFromTool(tool: string, input: unknown, output: unknown): ChangeSet {
    if (tool === "ast_grep") return astChanges(input, output)
    if (tool === "patch") return patchChanges(input)
    if (tool !== "edit" && tool !== "write") return { paths: [] }
    const path = (input as Record<string, unknown> | undefined)?.path
    return { paths: typeof path === "string" ? [path] : [] }
}

function astChanges(input: unknown, output: unknown): ChangeSet {
    if ((input as Record<string, unknown> | undefined)?.action !== "apply") return { paths: [] }
    const applied = (output as { applied?: unknown } | undefined)?.applied
    return { paths: Array.isArray(applied) ? applied.filter((path): path is string => typeof path === "string") : [] }
}

function patchChanges(input: unknown): ChangeSet {
    const text = (input as Record<string, unknown> | undefined)?.patchText
    if (typeof text !== "string") return { paths: [] }
    const paths = new Set<string>()
    for (const pattern of [ADD, UPDATE, DELETE, MOVE_TO]) {
        for (const match of text.matchAll(pattern)) {
            const path = match[1]?.trim()
            if (path) paths.add(path)
        }
    }
    return { paths: [...paths] }
}
