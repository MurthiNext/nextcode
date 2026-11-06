import { resolve } from "node:path"
import { AstRunner } from "./runner"
import { FileScope, languageFor, languages, type Language } from "./scope"
import { AstError, LIMITS, publicRange, type Match, type OutlineEntry, type OutlineFile, type Query, type Snapshot } from "./types"

export class AstQuery {
    private readonly structures = new Map<string, { hash: string; matches: Match[]; size: number }>()

    constructor(private readonly runner = new AstRunner()) {}

    async search(scope: FileScope, files: string[], language: Language, query: Query, limit: number, replacement?: string): Promise<{ matches: Match[]; truncated: boolean }> {
        const rules = this.rules(language, query, replacement)
        const matches: Match[] = []
        let truncated = false
        for (const batch of this.batches(files)) {
            const result = await this.runner.run<Match>(["scan", "--inline-rules", rules, "--threads", "4", "--", ...batch], scope.root, scope.execution.signal, { limit: limit - matches.length })
            const allowed = new Set(batch)
            for (const match of result.records) {
                match.file = await scope.validate(resolve(scope.root, match.file))
                if (!allowed.has(match.file)) throw new AstError("UNEXPECTED_PATH", "ast-grep returned an unexpected file path.")
                matches.push(match)
            }
            if (result.truncated) {
                truncated = true
                break
            }
        }
        return { matches, truncated }
    }

    async rewrite(scope: FileScope, snapshot: Snapshot, language: Language, query: Query, replacement: string): Promise<Match[]> {
        const result = await this.runner.run<Match>(["scan", "--inline-rules", this.rules(language, query, replacement), "--stdin"], scope.root, scope.execution.signal, { stdin: snapshot.bytes, limit: LIMITS.edits })
        if (result.truncated) throw new AstError("EDIT_LIMIT", `More than ${LIMITS.edits} edits. Narrow paths or the rule.`)
        return result.records.map((match) => ({ ...match, file: snapshot.path }))
    }

    async outline(scope: FileScope, files: string[], limit: number): Promise<{ files: object[]; truncated: boolean }> {
        const output: object[] = []
        let truncated = false
        for (const batch of this.batches(files)) {
            const result = await this.runner.run<OutlineFile>(["outline", "--items", "structure", "--view", "expanded", "--threads", "4", "--", ...batch], scope.root, scope.execution.signal, { limit: limit - output.length })
            const allowed = new Set(batch)
            for (const file of result.records) {
                const full = await scope.validate(resolve(scope.root, file.path))
                if (!allowed.has(full)) throw new AstError("UNEXPECTED_PATH", "ast-grep returned an unexpected file path.")
                let entries = 0
                const entry = (item: OutlineEntry): object | null => {
                    if (++entries > 100) return null
                    return {
                        name: item.name,
                        kind: item.astKind,
                        type: item.symbolType,
                        signature: item.signature.slice(0, 500),
                        signatureTruncated: item.signature.length > 500,
                        range: publicRange(item.range),
                        ...(item.members?.length ? { members: item.members.map(entry).filter((member) => member !== null) } : {}),
                    }
                }
                const items = file.items.map(entry).filter((item) => item !== null)
                const clipped = entries > 100
                truncated ||= clipped
                output.push({ path: scope.label(full), language: file.language, items, truncated: clipped })
            }
            if (result.truncated) {
                truncated = true
                break
            }
        }
        return { files: output, truncated }
    }

    async locate(scope: FileScope, path: string, line: number, column?: number): Promise<object> {
        const snapshot = await scope.snapshot(path)
        const language = languageFor(path, true)
        const lines = snapshot.text.split("\n")
        if (line > lines.length) throw new AstError("POSITION", "Line is outside the file.")
        const sourceLine = lines[line - 1].replace(/\r$/, "")
        const characters = Array.from(sourceLine)
        const character = column === undefined ? Array.from(sourceLine.match(/^\s*/)?.[0] ?? "").length : column - 1
        if (character > characters.length) throw new AstError("POSITION", "Column is outside the line. Columns count Unicode code points.")
        const offset = Buffer.byteLength(characters.slice(0, character).join(""))
        const index = Buffer.byteLength(lines.slice(0, line - 1).join("\n")) + (line > 1 ? 1 : 0) + offset
        let cached = this.structures.get(snapshot.path)
        if (cached?.hash !== snapshot.hash) {
            const rules = languages[language].structures.map((kind) => JSON.stringify({ id: kind, language: languages[language].cli, severity: "hint", rule: { kind } })).join("\n---\n")
            const result = await this.runner.run<Match>(["scan", "--inline-rules", rules, "--stdin"], scope.root, scope.execution.signal, { stdin: snapshot.bytes })
            cached = { hash: snapshot.hash, matches: result.records.map((match) => ({ file: "", text: "", range: match.range, ruleId: match.ruleId })), size: result.records.length * 256 }
            if (cached.size <= 4 * 1024 * 1024) {
                while (this.structures.size >= 64 || [...this.structures.values()].reduce((sum, value) => sum + value.size, cached.size) > 4 * 1024 * 1024) {
                    this.structures.delete(this.structures.keys().next().value!)
                }
                this.structures.set(snapshot.path, cached)
            }
        }
        const containing = cached.matches.filter((match) => match.range.byteOffset.start <= index && index < match.range.byteOffset.end)
            .sort((a, b) => (a.range.byteOffset.end - a.range.byteOffset.start) - (b.range.byteOffset.end - b.range.byteOffset.start))
        const match = containing[0]
        const text = match ? snapshot.bytes.subarray(match.range.byteOffset.start, match.range.byteOffset.end).toString("utf8") : ""
        return {
            path: scope.label(snapshot.path),
            language,
            block: match ? { kind: match.ruleId, range: publicRange(match.range), text: text.slice(0, 12_000), truncated: text.length > 12_000 } : null,
            ancestors: containing.slice(1).map((parent) => ({
                kind: parent.ruleId,
                range: publicRange(parent.range),
                signature: snapshot.bytes.subarray(parent.range.byteOffset.start, Math.min(parent.range.byteOffset.end, parent.range.byteOffset.start + 2000)).toString("utf8").split("\n", 1)[0].slice(0, 500),
            })),
        }
    }

    clear(): void {
        this.structures.clear()
    }

    private rules(language: Language, query: Query, replacement?: string): string {
        const value = JSON.stringify({
            id: "nextcode-query",
            language: languages[language].cli,
            severity: "hint",
            rule: query.rule ?? { pattern: query.pattern },
            ...(query.constraints ? { constraints: query.constraints } : {}),
            ...(query.utils ? { utils: query.utils } : {}),
            ...(replacement !== undefined ? { fix: replacement } : {}),
        })
        if (Buffer.byteLength(value) > LIMITS.queryBytes) throw new AstError("QUERY_LIMIT", "Query and replacement must fit within 4 KiB.")
        return value
    }

    private *batches(files: string[]): Generator<string[]> {
        let batch: string[] = []
        let size = 0
        for (const file of files) {
            if (size + file.length > 6000 && batch.length) {
                yield batch
                batch = []
                size = 0
            }
            batch.push(file)
            size += file.length + 3
        }
        if (batch.length) yield batch
    }
}
