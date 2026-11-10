import { createHash } from "node:crypto"
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import config from "./config/lsp.json"
import { fileExists, installLock, replaceDirectory } from "./fs"
import { LspError } from "./types"

const WINDOWS = process.platform === "win32"

export async function findOnPath(name: string): Promise<string | undefined> {
    const extensions = WINDOWS ? [".exe", ".cmd", ".bat", ""] : [""]
    for (const extension of extensions) {
        const found = Bun.which(name + extension)
        if (found) return found
    }
    return undefined
}

export function cacheRoot(): string {
    if (process.env.OPENCODE_LSP_HOME) return process.env.OPENCODE_LSP_HOME
    if (WINDOWS) return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode", "lsp")
    return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "lsp")
}

export function scratchRoot(): string {
    return join(tmpdir(), "opencode")
}

export async function run(command: string, args: string[], cwd?: string): Promise<string> {
    const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true })
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
    ])
    const code = await child.exited
    if (code !== 0) throw new LspError("COMMAND", `${basename(command)} exited with ${code}: ${(stderr || stdout).trim().slice(0, 500)}`)
    return stdout
}

const versions = new Map<string, number | undefined>()

export async function nodeMajor(path: string): Promise<number | undefined> {
    if (versions.has(path)) return versions.get(path)
    const value = await probe(path, ["--version"]).then((output) => major(output)).catch(() => undefined)
    versions.set(path, value)
    return value
}

export async function javaMajor(path: string): Promise<number | undefined> {
    if (versions.has(path)) return versions.get(path)
    const value = await probe(path, ["-version"], true).then((output) => major(output)).catch(() => undefined)
    versions.set(path, value)
    return value
}

export async function pythonMajor(path: string): Promise<number | undefined> {
    if (versions.has(path)) return versions.get(path)
    const value = await probe(path, ["--version"]).then((output) => major(output)).catch(() => undefined)
    versions.set(path, value)
    return value
}

async function probe(path: string, args: string[], stderr = false): Promise<string> {
    const child = Bun.spawn([path, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    const [out, err] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
    ])
    await child.exited
    return stderr ? err : out
}

function major(output: string): number | undefined {
    const value = Number(/version "?(?:1\.)?(\d+)|v?(\d+)\./i.exec(output)?.slice(1).find(Boolean))
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export async function resolveNode(): Promise<string | undefined> {
    const configured = process.env.OPENCODE_LSP_NODE
    if (configured && await fileExists(configured)) return configured
    const found = await findOnPath("node")
    if (found && ((await nodeMajor(found)) ?? 0) >= 18) return found
    return undefined
}

export async function resolveJava(): Promise<string | undefined> {
    const configured = process.env.OPENCODE_LSP_JAVA
    if (configured && await fileExists(configured)) return configured
    if (process.env.JAVA_HOME) {
        const candidate = join(process.env.JAVA_HOME, "bin", WINDOWS ? "java.exe" : "java")
        if (await fileExists(candidate)) return candidate
    }
    return await findOnPath("java")
}

export async function resolvePython(): Promise<string | undefined> {
    const configured = process.env.OPENCODE_LSP_PYTHON
    if (configured && await fileExists(configured)) return configured
    for (const name of WINDOWS ? ["python", "python3"] : ["python3", "python"]) {
        const found = await findOnPath(name)
        if (found && ((await pythonMajor(found)) ?? 0) >= 3) return found
    }
    return undefined
}

export function serverDirectory(name: string, version: string): string {
    return join(cacheRoot(), "servers", `${name}-${version}`)
}

export function platformKey(): string {
    return `${process.platform}-${process.arch}`
}

export function clangdBinary(): string {
    return join(serverDirectory("clangd", config.c.clangd.version), "bin", WINDOWS ? "clangd.exe" : "clangd")
}

export function runtimeDirectory(name: string): string {
    return join(cacheRoot(), "runtimes", name)
}

export async function extract(archive: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true })
    if (archive.toLowerCase().endsWith(".zip")) {
        const unzip = await findOnPath("unzip")
        if (unzip) {
            await run(unzip, ["-o", "-d", destination, archive])
            return
        }
    }
    const tar = await findOnPath("tar") ?? (WINDOWS ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar")
    await run(tar, ["-xf", archive, "-C", destination])
}

export async function installPackage(directory: string, dependencies: Readonly<Record<string, string>>, label: string): Promise<void> {
    if (await fileExists(join(directory, "node_modules"))) return
    const release = await installLock(cacheRoot(), basename(directory))
    try {
        if (await fileExists(join(directory, "node_modules"))) return
        const staging = `${directory}.tmp-${process.pid}-${Date.now()}`
        await mkdir(staging, { recursive: true })
        try {
            await writeFile(join(staging, "package.json"), JSON.stringify({ name: label, private: true, version: "0.0.0", dependencies }, null, 4))
            await installDependencies(staging)
            await replaceDirectory(staging, directory)
        } catch (error) {
            await rm(staging, { recursive: true, force: true })
            throw error
        }
    } finally {
        await release()
    }
}

async function installDependencies(directory: string): Promise<void> {
    const errors: string[] = []
    for (const manager of [await findOnPath("bun") ?? process.execPath, await findOnPath("npm")]) {
        if (!manager) continue
        try {
            await run(manager, ["install", "--production", "--no-audit", "--no-fund"], directory)
            return
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
        }
    }
    throw new LspError("INSTALL", `Could not install language server dependencies. ${errors.join(" ")}`.trim())
}

export function packagedScript(directory: string, module: string, entry: string): string {
    return join(directory, "node_modules", module, entry)
}

export async function installJdtls(): Promise<string> {
    const { version, build, base } = config.java.jdt
    const directory = serverDirectory("jdtls", `${version}-${build}`)
    if (await fileExists(join(directory, "plugins"))) return directory
    const release = await installLock(cacheRoot(), `jdtls-${version}-${build}`)
    try {
        if (await fileExists(join(directory, "plugins"))) return directory
        const name = `jdt-language-server-${version}-${build}`
        const archive = join(scratchRoot(), `${name}.tar.gz`)
        const checksum = await fetch(`${base}/${version}/${name}.tar.gz.sha256`).then((response) => {
            if (!response.ok) throw new LspError("DOWNLOAD", "The jdtls checksum file is unavailable.")
            return response.text()
        }).then((text) => /([0-9a-f]{64})/i.exec(text)?.[1])
        await download(`${base}/${version}/${name}.tar.gz`, archive, checksum)
        const staging = `${directory}.tmp-${process.pid}`
        await rm(staging, { recursive: true, force: true })
        await extract(archive, staging)
        await replaceDirectory(staging, directory)
        await rm(archive, { force: true })
        if (!await fileExists(join(directory, "plugins"))) throw new LspError("INSTALL", "The jdtls archive did not contain plugins.")
        return directory
    } finally {
        await release()
    }
}

export async function installClangd(): Promise<string> {
    const { version, base, assets } = config.c.clangd
    const key = platformKey()
    const binary = clangdBinary()
    if (await fileExists(binary)) return binary
    const asset = (assets as Record<string, { file: string; sha256: string } | undefined>)[key]
    if (!asset) throw new LspError("MISSING_SERVER", `clangd ${version} has no build for ${key}. Set OPENCODE_LSP_CLANGD to use a local clangd.`)
    const release = await installLock(cacheRoot(), `clangd-${version}`)
    try {
        if (await fileExists(binary)) return binary
        const archive = join(scratchRoot(), asset.file)
        await download(`${base}/${version}/${asset.file}`, archive, asset.sha256)
        const staging = `${serverDirectory("clangd", version)}.tmp-${process.pid}`
        await rm(staging, { recursive: true, force: true })
        try {
            await extract(archive, staging)
            const found = await findClangd(staging)
            if (!found) throw new LspError("INSTALL", `The clangd archive did not contain ${WINDOWS ? "clangd.exe" : "clangd"}.`)
            await mkdir(join(binary, ".."), { recursive: true })
            await rename(found, binary)
        } finally {
            await rm(staging, { recursive: true, force: true })
            await rm(archive, { force: true })
        }
        return binary
    } finally {
        await release()
    }
}

async function findClangd(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
            const found = await findClangd(path)
            if (found) return found
        } else if (entry.name === (WINDOWS ? "clangd.exe" : "clangd")) {
            return path
        }
    }
    return undefined
}

async function download(url: string, destination: string, checksum?: string): Promise<void> {
    await mkdir(join(destination, ".."), { recursive: true })
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok) throw new LspError("DOWNLOAD", `Download failed with ${response.status}: ${url}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (checksum) {
        const actual = createHash("sha256").update(bytes).digest("hex")
        if (actual !== checksum.toLowerCase()) throw new LspError("CHECKSUM", `Checksum mismatch for ${basename(destination)}.`)
    }
    const temporary = `${destination}.${process.pid}.part`
    await writeFile(temporary, bytes)
    await rename(temporary, destination)
}
