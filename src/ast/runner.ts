import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { AstError, LIMITS } from "./types"

const require = createRequire(import.meta.url)
const config = fileURLToPath(new URL("./config/sgconfig.yml", import.meta.url))

export class AstRunner {
    private binary?: string

    async run<T>(args: string[], cwd: string, signal: AbortSignal, options: { stdin?: Buffer; limit?: number } = {}): Promise<{ records: T[]; truncated: boolean }> {
        signal.throwIfAborted()
        if (!this.binary) {
            this.binary = (require("@ast-grep/cli/postinstall.js") as { resolveBinaryPath(): string | null }).resolveBinaryPath() ?? undefined
            if (!this.binary) throw new AstError("MISSING_BINARY", "Install @ast-grep/cli with optional dependencies enabled.")
        }
        const controller = new AbortController()
        const combined = AbortSignal.any([signal, controller.signal])
        const child = Bun.spawn([this.binary, args[0], "--config", config, "--custom-languages", "ignore", "--json=stream", "--color", "never",
            ...["hidden", "dot", "vcs", "parent", "global", "exclude"].flatMap((kind) => ["--no-ignore", kind]), ...args.slice(1)], {
            cwd,
            stdin: options.stdin ?? "ignore",
            stdout: "pipe",
            stderr: "pipe",
        })
        const timer = setTimeout(() => controller.abort(new AstError("TIMEOUT", "AST query timed out. Narrow paths or simplify the rule.")), LIMITS.timeout)
        const stop = () => child.kill()
        combined.addEventListener("abort", stop, { once: true })
        if (combined.aborted) stop()
        const records: T[] = []
        let truncated = false
        let stderr = ""
        const errors = (async () => {
            for await (const chunk of child.stderr) {
                if (stderr.length < 8192) stderr += new TextDecoder().decode(chunk).slice(0, 8192 - stderr.length)
            }
        })()
        try {
            let pending = ""
            let size = 0
            const decoder = new TextDecoder()
            const consume = (line: string) => {
                if (!line.trim() || truncated || combined.aborted) return
                if (records.length === options.limit) {
                    truncated = true
                    child.kill()
                } else {
                    records.push(JSON.parse(line) as T)
                }
            }
            for await (const chunk of child.stdout) {
                size += chunk.byteLength
                if (size > LIMITS.rawBytes) throw new AstError("OUTPUT_LIMIT", "AST output exceeded 32 MiB. Narrow paths or use a more specific rule.")
                pending += decoder.decode(chunk, { stream: true })
                let newline: number
                while ((newline = pending.indexOf("\n")) >= 0) {
                    consume(pending.slice(0, newline))
                    pending = pending.slice(newline + 1)
                }
            }
            consume(pending + decoder.decode())
            const code = await child.exited
            await errors
            combined.throwIfAborted()
            if (!truncated && code !== 0) throw new AstError("QUERY_FAILED", stderr.trim() || `ast-grep exited with code ${code}.`)
            return { records, truncated }
        } finally {
            clearTimeout(timer)
            combined.removeEventListener("abort", stop)
            child.kill()
            await Promise.allSettled([child.exited, errors])
        }
    }
}
