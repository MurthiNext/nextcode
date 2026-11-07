import { access, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LspError, LIMITS } from "./types"

export async function fileExists(path: string): Promise<boolean> {
    return access(path).then(() => true, () => false)
}

export async function installLock(root: string, name: string): Promise<() => Promise<void>> {
    const directory = join(root, "locks")
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${name}.lock`)
    const deadline = Date.now() + LIMITS.lockWait
    for (;;) {
        try {
            await writeFile(file, String(process.pid), { flag: "wx" })
            return async () => { await rm(file, { force: true }) }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
            const age = await stat(file).then((info) => Date.now() - info.mtimeMs).catch(() => 0)
            if (age > LIMITS.lockStale) {
                await rm(file, { force: true })
                continue
            }
            if (Date.now() > deadline) throw new LspError("BUSY", `Installation of ${name} is already running.`)
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
    }
}

export async function replaceDirectory(staging: string, directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true })
    await mkdir(join(directory, ".."), { recursive: true })
    await rename(staging, directory)
}
