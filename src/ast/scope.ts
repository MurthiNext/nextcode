import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import ignore, { type Ignore } from "ignore"
import catalog from "./rules/languages.json"
import { AstError, LIMITS, type Execution, type Snapshot } from "./types"

export type Language = keyof typeof catalog
export const languages = catalog

export function languageFor(value: string, file = false): Language {
    const key = value.toLowerCase()
    const found = (Object.keys(catalog) as Language[]).find((name) => {
        const entry = catalog[name]
        return file ? entry.extensions.some((extension) => extension === extname(key))
            : name === key || entry.aliases.some((alias) => alias === key)
    })
    if (!found) throw new AstError("UNSUPPORTED_LANGUAGE", `Unsupported language: ${value}`)
    return found
}

export function digest(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex")
}

export class FileScope {
    private readonly ignores = new Map<string, Ignore>()

    private constructor(readonly root: string, readonly execution: Execution) {}

    static async create(execution: Execution): Promise<FileScope> {
        return new FileScope(await realpath(execution.directory), execution)
    }

    label(path: string): string {
        return relative(this.root, path).split(sep).join("/")
    }

    async validate(path: string): Promise<string> {
        this.execution.signal.throwIfAborted()
        const full = resolve(this.root, path)
        const local = relative(this.root, full)
        if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)
            || local.includes("\0") || (process.platform === "win32" && local.includes(":"))) {
            throw new AstError("OUTSIDE_DIRECTORY", "Paths must stay inside the session directory.")
        }
        const actual = await realpath(full)
        if (relative(full, actual) !== "" || (await lstat(full)).isSymbolicLink()) {
            throw new AstError("SYMLINK", `Symbolic links and junctions are not supported: ${this.label(full)}`)
        }
        return full
    }

    async collect(paths: string[], language?: Language): Promise<{ files: string[]; skipped: string[] }> {
        const files = new Set<string>()
        const skipped: string[] = []
        const visit = async (path: string): Promise<void> => {
            this.execution.signal.throwIfAborted()
            const info = await lstat(path)
            const name = path.slice(dirname(path).length + 1)
            if (info.isSymbolicLink() || (path !== this.root && (name.startsWith(".") || ["node_modules", "target", "dist", "build", "venv", "__pycache__", "coverage", "vendor"].includes(name)))) return
            if (path !== this.root && await this.ignored(path, info.isDirectory())) return
            if (info.isDirectory()) {
                for (const entry of await readdir(path)) await visit(join(path, entry))
                return
            }
            if (!info.isFile()) return
            let detected: Language
            try { detected = languageFor(path, true) } catch { return }
            if (language && detected !== language) return
            await this.validate(path)
            if (info.size > LIMITS.fileBytes) {
                skipped.push(this.label(path))
                return
            }
            files.add(path)
            if (files.size > LIMITS.files) throw new AstError("FILE_LIMIT", `More than ${LIMITS.files} files. Narrow paths.`)
        }
        for (const path of paths) {
            const full = await this.validate(path)
            let parent = dirname(full)
            let excluded = false
            while (parent !== this.root && full !== this.root) {
                if (await this.ignored(parent, true)) {
                    excluded = true
                    break
                }
                parent = dirname(parent)
            }
            if (!excluded) await visit(full)
        }
        const result = [...files].sort()
        if (result.length) await this.execution.permission("read", result)
        return { files: result, skipped }
    }

    async snapshot(path: string): Promise<Snapshot> {
        path = await this.validate(path)
        const info = await lstat(path)
        if (!info.isFile() || info.size > LIMITS.fileBytes) throw new AstError("FILE_LIMIT", "Expected a regular file no larger than 2 MiB.")
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
            const before = await handle.stat()
            if (before.ino !== info.ino || before.dev !== info.dev) throw new AstError("FILE_CHANGED", "File changed while opening it.")
            const bytes = await handle.readFile()
            const after = await handle.stat()
            if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || bytes.length > LIMITS.fileBytes) {
                throw new AstError("FILE_CHANGED", "File changed while reading it.")
            }
            let text: string
            try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }
            catch { throw new AstError("ENCODING", `Only UTF-8 files are supported: ${this.label(path)}`) }
            if (text.includes("\0")) throw new AstError("ENCODING", `Binary files are not supported: ${this.label(path)}`)
            return { path, bytes, text, hash: digest(bytes), mode: info.mode }
        } finally {
            await handle.close()
        }
    }

    private async ignored(path: string, directory: boolean): Promise<boolean> {
        const ancestors: string[] = []
        for (let current = dirname(path);; current = dirname(current)) {
            ancestors.unshift(current)
            if (current === this.root) break
        }
        let excluded = false
        for (const ancestor of ancestors) {
            let matcher = this.ignores.get(ancestor)
            if (!matcher) {
                matcher = ignore()
                for (const name of [".gitignore", ".ignore"]) {
                    const config = join(ancestor, name)
                    try { await lstat(config) } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
                        throw error
                    }
                    await this.execution.permission("read", [config])
                    matcher.add((await this.snapshot(config)).text)
                }
                this.ignores.set(ancestor, matcher)
            }
            const result = matcher.test(relative(ancestor, path).split(sep).join("/") + (directory ? "/" : ""))
            if (result.ignored) excluded = true
            if (result.unignored) excluded = false
        }
        return excluded
    }
}
