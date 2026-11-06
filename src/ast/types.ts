export const LIMITS = {
    files: 2000,
    fileBytes: 2 * 1024 * 1024,
    rawBytes: 32 * 1024 * 1024,
    outputBytes: 24 * 1024,
    queryBytes: 4096,
    matches: 50,
    rewriteFiles: 20,
    edits: 200,
    previews: 8,
    previewBytes: 16 * 1024 * 1024,
    previewAge: 10 * 60 * 1000,
    timeout: 15_000,
} as const

export class AstError extends Error {
    constructor(readonly code: string, message: string, readonly details?: unknown) {
        super(message)
        this.name = "AstError"
    }
}

export interface Execution {
    directory: string
    sessionID: string
    signal: AbortSignal
    permission(action: "read" | "edit", resources: string[], metadata?: Record<string, unknown>): Promise<void>
}

export interface Query {
    pattern?: string
    rule?: Record<string, unknown>
    constraints?: Record<string, unknown>
    utils?: Record<string, unknown>
}

export type AstInput =
    | { action: "outline"; paths: string[]; language?: string; limit?: number }
    | ({ action: "search"; paths: string[]; language: string; limit?: number } & Query)
    | { action: "locate"; path: string; line: number; column?: number }
    | ({ action: "rewrite"; paths: string[]; language: string; replacement: string } & Query)
    | { action: "apply"; previewId: string }

export interface Position {
    line: number
    column: number
}

export interface AstRange {
    byteOffset: { start: number; end: number }
    start: Position
    end: Position
}

export interface Match {
    ruleId?: string
    file: string
    text: string
    range: AstRange
    replacement?: string
    replacementOffsets?: { start: number; end: number }
    metaVariables?: {
        single?: Record<string, { text: string }>
        multi?: Record<string, { text: string }[]>
    }
}

export interface OutlineEntry {
    name: string
    symbolType: string
    signature: string
    astKind: string
    range: AstRange
    members?: OutlineEntry[]
}

export interface OutlineFile {
    path: string
    language: string
    items: OutlineEntry[]
}

export interface Snapshot {
    path: string
    bytes: Buffer
    text: string
    hash: string
    mode: number
}

export function publicRange(range: AstRange): AstRange {
    return {
        byteOffset: range.byteOffset,
        start: { line: range.start.line + 1, column: range.start.column + 1 },
        end: { line: range.end.line + 1, column: range.end.column + 1 },
    }
}
