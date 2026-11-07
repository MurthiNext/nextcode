import type { Readable, Writable } from "node:stream"
import { LspError, LIMITS } from "./types"

interface ResponseMessage {
    jsonrpc: "2.0"
    id?: number | string | null
    method?: string
    params?: unknown
    result?: unknown
    error?: { code: number; message: string; data?: unknown }
}

export interface RpcHandlers {
    request(method: string, params: unknown): unknown
    notify(method: string, params: unknown): void
}

interface Pending {
    resolve(value: unknown): void
    reject(error: unknown): void
    timer: ReturnType<typeof setTimeout>
}

export class JsonRpc {
    private buffer: Buffer = Buffer.alloc(0)
    private nextID = 1
    private readonly pending = new Map<number, Pending>()
    private closed = false
    private readonly onExit: () => void

    constructor(
        input: Readable,
        private readonly output: Writable,
        private readonly handlers: RpcHandlers,
        onExit: () => void,
    ) {
        this.onExit = onExit
        input.on("data", (chunk: Buffer) => this.receive(chunk))
        input.on("error", () => this.fail(new LspError("TRANSPORT", "Language server stream failed.")))
        input.on("close", () => this.fail(new LspError("EXIT", "Language server stream closed.")))
    }

    request<T = unknown>(method: string, params: unknown, timeout: number = LIMITS.request): Promise<T> {
        if (this.closed) return Promise.reject(new LspError("EXIT", "Language server is not running."))
        const id = this.nextID++
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new LspError("TIMEOUT", `Language server did not answer ${method}.`))
            }, timeout)
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
            this.write({ jsonrpc: "2.0", id, method, params })
        })
    }

    notify(method: string, params: unknown): void {
        if (this.closed) return
        this.write({ jsonrpc: "2.0", method, params })
    }

    dispose(reason = "Language server stopped."): void {
        this.fail(new LspError("EXIT", reason))
    }

    private fail(error: unknown): void {
        if (this.closed) return
        this.closed = true
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        this.pending.clear()
        this.onExit()
    }

    private write(message: object): void {
        const body = JSON.stringify(message)
        this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }

    private receive(chunk: Buffer): void {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer as Buffer, chunk as Buffer]) as Buffer : chunk
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n")
            if (headerEnd < 0) {
                if (this.buffer.length > 4096) this.fail(new LspError("PROTOCOL", "Malformed language server header."))
                return
            }
            const header = this.buffer.subarray(0, headerEnd).toString("ascii")
            const length = /content-length:\s*(\d+)/i.exec(header)
            if (!length) {
                this.fail(new LspError("PROTOCOL", "Language server response has no Content-Length."))
                return
            }
            const size = Number(length[1])
            if (!Number.isSafeInteger(size) || size > LIMITS.frame) {
                this.fail(new LspError("PROTOCOL", "Language server response exceeds the frame limit."))
                return
            }
            const start = headerEnd + 4
            if (this.buffer.length < start + size) return
            const body = this.buffer.subarray(start, start + size).toString("utf8")
            this.buffer = this.buffer.subarray(start + size)
            let message: ResponseMessage
            try {
                message = JSON.parse(body) as ResponseMessage
            } catch {
                this.fail(new LspError("PROTOCOL", "Language server sent invalid JSON."))
                return
            }
            this.dispatch(message)
        }
    }

    private dispatch(message: ResponseMessage): void {
        if (message.method !== undefined) {
            if (message.id === undefined || message.id === null) {
                try { this.handlers.notify(message.method, message.params) } catch { /* ignore malformed notifications */ }
                return
            }
            void this.answer(message.id, message.method, message.params)
            return
        }
        if (typeof message.id !== "number") return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new LspError("SERVER", message.error.message, message.error))
        else pending.resolve(message.result)
    }

    private async answer(id: number | string, method: string, params: unknown): Promise<void> {
        try {
            const result = await this.handlers.request(method, params)
            this.write({ jsonrpc: "2.0", id, result })
        } catch (error) {
            this.write({
                jsonrpc: "2.0",
                id,
                error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            })
        }
    }
}
