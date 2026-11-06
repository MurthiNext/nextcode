import { randomUUID } from "node:crypto"
import { lstat, open, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createTwoFilesPatch } from "diff"
import { AstQuery } from "./query"
import { FileScope, type Language } from "./scope"
import { AstError, LIMITS, type Query } from "./types"

interface Change {
    path: string
    hash: string
    bytes: Buffer
    mode: number
    edits: number
}

interface Preview {
    sessionID: string
    root: string
    expires: number
    changes: Change[]
    size: number
}

export class AstRewrite {
    private readonly previews = new Map<string, Preview>()
    private writing = false

    constructor(private readonly query: AstQuery) {}

    async preview(scope: FileScope, files: string[], language: Language, query: Query, replacement: string): Promise<object> {
        const found = await this.query.search(scope, files, language, query, LIMITS.edits)
        if (found.truncated) throw new AstError("EDIT_LIMIT", `More than ${LIMITS.edits} matches. Narrow paths or the rule.`)
        const candidates = [...new Set(found.matches.map((match) => match.file))]
        if (candidates.length > LIMITS.rewriteFiles) throw new AstError("REWRITE_FILE_LIMIT", `More than ${LIMITS.rewriteFiles} matching files. Narrow paths.`)
        const changes: Change[] = []
        let diff = ""
        let edits = 0
        let size = 0
        for (const path of candidates) {
            const snapshot = await scope.snapshot(path)
            const matches = await this.query.rewrite(scope, snapshot, language, query, replacement)
            const patches = matches.map((match) => {
                const range = match.replacementOffsets
                if (!range || match.replacement === undefined || !Number.isInteger(range.start) || !Number.isInteger(range.end)
                    || range.start < 0 || range.end < range.start || range.end > snapshot.bytes.length) {
                    throw new AstError("INVALID_EDIT", "ast-grep returned an invalid replacement range.")
                }
                const newline = snapshot.text.includes("\r\n") ? "\r\n" : "\n"
                const text = match.replacement.replace(/\r?\n/g, newline)
                return { start: range.start, end: range.end, bytes: Buffer.from(text) }
            }).sort((a, b) => a.start - b.start || a.end - b.end)
            let end = 0
            const chunks: Buffer[] = []
            for (const patch of patches) {
                if (patch.start < end) throw new AstError("OVERLAPPING_EDITS", "Overlapping AST replacements require a narrower rule.")
                chunks.push(snapshot.bytes.subarray(end, patch.start), patch.bytes)
                end = patch.end
            }
            chunks.push(snapshot.bytes.subarray(end))
            const bytes = Buffer.concat(chunks)
            if (snapshot.bytes.equals(bytes)) continue
            edits += patches.length
            size += bytes.length
            if (edits > LIMITS.edits || size > LIMITS.previewBytes || bytes.length > LIMITS.fileBytes) {
                throw new AstError("PREVIEW_LIMIT", "Rewrite preview is too large. Narrow paths or the rule.")
            }
            const label = scope.label(path)
            diff += createTwoFilesPatch(label, label, snapshot.text, bytes.toString("utf8"), undefined, undefined, { context: 3 })
            if (Buffer.byteLength(diff) > LIMITS.outputBytes - 4096) throw new AstError("DIFF_LIMIT", "Full diff exceeds the preview limit. Narrow paths or the rule.")
            changes.push({ path, hash: snapshot.hash, bytes, mode: snapshot.mode, edits: patches.length })
        }
        if (!changes.length) return { action: "rewrite", files: [], edits: 0, diff: "", scanComplete: true }
        this.expire()
        while (this.previews.size >= LIMITS.previews || [...this.previews.values()].reduce((sum, value) => sum + value.size, size) > LIMITS.previewBytes) {
            this.previews.delete(this.previews.keys().next().value!)
        }
        const previewId = randomUUID()
        const expires = Date.now() + LIMITS.previewAge
        const output = { action: "rewrite", previewId, expiresAt: new Date(expires).toISOString(), files: changes.map((change) => ({ path: scope.label(change.path), edits: change.edits })), edits, diff, scanComplete: true }
        if (Buffer.byteLength(JSON.stringify(output)) > LIMITS.outputBytes - 256) throw new AstError("DIFF_LIMIT", "Full preview exceeds the output limit. Narrow paths or the rule.")
        this.previews.set(previewId, { sessionID: scope.execution.sessionID, root: scope.root, expires, changes, size })
        return output
    }

    async apply(scope: FileScope, previewId: string): Promise<object> {
        this.expire()
        const preview = this.previews.get(previewId)
        if (!preview || preview.sessionID !== scope.execution.sessionID || preview.root !== scope.root) {
            throw new AstError("INVALID_PREVIEW", "Preview expired, belongs to another session, or was already consumed. Generate a new preview.")
        }
        if (this.writing) throw new AstError("BUSY", "Another AST rewrite is being applied. Retry after it finishes.")
        this.writing = true
        const applied: string[] = []
        let staged: string | undefined
        try {
            const paths = preview.changes.map((change) => change.path)
            await scope.execution.permission("read", paths)
            await scope.execution.permission("edit", paths, { previewId, files: paths.map((path) => scope.label(path)) })
            for (const change of preview.changes) await this.check(scope, change)
            scope.execution.signal.throwIfAborted()
            this.previews.delete(previewId)
            try {
                for (const change of preview.changes) {
                    scope.execution.signal.throwIfAborted()
                    await this.check(scope, change)
                    staged = join(dirname(change.path), `.nextcode-${randomUUID()}.tmp`)
                    const handle = await open(staged, "wx", change.mode & 0o777)
                    try {
                        await handle.writeFile(change.bytes)
                        await handle.chmod(change.mode & 0o777)
                        await handle.sync()
                    } finally {
                        await handle.close()
                    }
                    scope.execution.signal.throwIfAborted()
                    await this.check(scope, change)
                    await rename(staged, change.path)
                    staged = undefined
                    applied.push(scope.label(change.path))
                }
            } catch (error) {
                let leftover: string | undefined
                if (staged) {
                    try {
                        const child = Bun.spawn(["trash", staged], { stdout: "ignore", stderr: "ignore" })
                        if (await child.exited !== 0) leftover = staged
                    } catch { leftover = staged }
                }
                throw new AstError("APPLY_FAILED", "Rewrite stopped. Applied files are not rolled back; generate a fresh preview before retrying.", {
                    applied,
                    remaining: preview.changes.map((change) => scope.label(change.path)).filter((path) => !applied.includes(path)),
                    cause: error instanceof Error ? error.message : String(error),
                    ...(leftover ? { stagedFile: leftover } : {}),
                })
            }
            return { action: "apply", applied, edits: preview.changes.reduce((sum, change) => sum + change.edits, 0) }
        } finally {
            this.writing = false
        }
    }

    clear(): void {
        this.previews.clear()
    }

    private async check(scope: FileScope, change: Change): Promise<void> {
        const snapshot = await scope.snapshot(change.path)
        const info = await lstat(change.path)
        if (info.nlink > 1) throw new AstError("HARD_LINK", `Refusing to replace a hard-linked file: ${scope.label(change.path)}`)
        if (snapshot.hash !== change.hash || snapshot.mode !== change.mode) {
            throw new AstError("FILE_CHANGED", `File changed after preview: ${scope.label(change.path)}`)
        }
    }

    private expire(): void {
        for (const [id, preview] of this.previews) {
            if (preview.expires <= Date.now()) this.previews.delete(id)
        }
    }
}
