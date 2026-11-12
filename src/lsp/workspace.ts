import { readdir, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileExists } from "./fs"
import { runtimeDirectory } from "./installer"
import { LIMITS } from "./types"

const WINDOWS = process.platform === "win32"

// JDT LS keeps one Eclipse workspace per project root. The key must depend only on the
// canonical location, so a trailing separator or a different slash style reuses the index.
export function workspaceKey(root: string): string {
    let result = 0
    const identity = identityOf(root)
    for (let index = 0; index < identity.length; index++) result = (result * 31 + identity.charCodeAt(index)) | 0
    return Math.abs(result).toString(36)
}

export function workspaceDirectory(root: string): string {
    return join(runtimeDirectory("jdtls-workspaces"), workspaceKey(root))
}

export async function pruneWorkspaces(active: ReadonlySet<string>): Promise<void> {
    const root = runtimeDirectory("jdtls-workspaces")
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const deadline = Date.now() - LIMITS.workspaceStale
    for (const entry of entries) {
        if (!entry.isDirectory() || active.has(entry.name)) continue
        const directory = join(root, entry.name)
        if (await fileExists(join(directory, ".metadata", ".lock"))) continue
        const touched = await stat(join(directory, ".metadata")).then((info) => info.mtimeMs).catch(() => 0)
        if (touched > deadline) continue
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
}

function identityOf(root: string): string {
    const normalized = resolve(root).replace(/[\\/]+/g, "/").replace(/\/$/, "")
    return WINDOWS ? normalized.toLowerCase() : normalized
}
