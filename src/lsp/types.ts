export const LIMITS = {
    initialize: 40_000,
    request: 20_000,
    wait: 1_200,
    maxWait: 15_000,
    files: 16,
    diagnostics: 20,
    outputBytes: 8 * 1024,
    message: 800,
    frame: 32 * 1024 * 1024,
    servers: 6,
    documents: 48,
    progressStale: 30_000,
    poll: 150,
    idle: 20 * 60 * 1000,
    workspaceStale: 30 * 60 * 1000,
    lockWait: 300_000,
    lockStale: 15 * 60 * 1000,
} as const

export class LspError extends Error {
    constructor(readonly code: string, message: string, readonly details?: unknown) {
        super(message)
        this.name = "LspError"
    }
}

export interface Position {
    line: number
    character: number
}

export interface Range {
    start: Position
    end: Position
}

export interface Diagnostic {
    range: Range
    severity?: number
    code?: string | number
    source?: string
    message: string
    tags?: number[]
}

export interface DocumentState {
    readonly path: string
    readonly uri: string
    version: number
    text: string
    syncedAt: number
}

export interface PublishedDiagnostics {
    version?: number
    diagnostics: Diagnostic[]
    at: number
}

export type DiagnosticsPhase = "available" | "pending" | "stale" | "unavailable"

export interface DiagnosticsResult {
    phase: DiagnosticsPhase
    diagnostics: Diagnostic[]
    checkedAt?: number
    reason?: string
}

export interface FileDiagnostic {
    readonly path: string
    readonly phase: DiagnosticsPhase
    readonly diagnostics: readonly Diagnostic[]
    readonly checkedAt?: number
    readonly reason?: string
}
