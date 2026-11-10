import { readdir } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { languages, type Language } from "../ast/scope"
import config from "./config/lsp.json"
import type { ServerSpec } from "./client"
import { fileExists } from "./fs"
import {
    clangdBinary, findOnPath, installClangd, installJdtls, installPackage, javaMajor, packagedScript, pythonMajor,
    resolveJava, resolveNode, resolvePython, runtimeDirectory, serverDirectory,
} from "./installer"
import { LspError } from "./types"

const WINDOWS = process.platform === "win32"

export type Family = "python" | "javascript" | "java" | "c"

const FAMILY_BY_LANGUAGE: Partial<Record<Language, Family>> = {
    python: "python",
    java: "java",
    typescript: "javascript",
    tsx: "javascript",
    javascript: "javascript",
    jsx: "javascript",
    c: "c",
    cpp: "c",
}

const MARKERS: Record<Family, readonly string[]> = {
    python: ["pyrightconfig.json", "pyproject.toml", "setup.cfg", "setup.py"],
    javascript: ["tsconfig.json", "jsconfig.json", "package.json"],
    java: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    c: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "Makefile", "makefile", "meson.build", "BUILD.bazel", "WORKSPACE"],
}

const VENV_PYTHON = ["Scripts/python.exe", "bin/python", "Scripts/python3.exe", "bin/python3"]

export interface ResolvedServer {
    readonly name: string
    readonly spec: ServerSpec
}

export function familyFor(path: string): Family | undefined {
    const extension = extname(path).toLowerCase()
    const language = (Object.keys(languages) as Language[]).find((name) => languages[name].extensions.includes(extension))
    return language ? FAMILY_BY_LANGUAGE[language] : undefined
}

export async function projectRoot(path: string, family: Family, ceiling: string): Promise<string> {
    const stop = dirname(ceiling)
    for (let current = dirname(path);; current = dirname(current)) {
        for (const marker of MARKERS[family]) {
            if (await fileExists(join(current, marker))) return current
        }
        if (current === ceiling || current === stop || dirname(current) === current) return ceiling
    }
}

export async function resolveServer(family: Family, root: string, options: { install: boolean }): Promise<ResolvedServer> {
    if (family === "python") return pythonServer(root, options)
    if (family === "javascript") return javascriptServer(root, options)
    if (family === "c") return clangdServer(root, options)
    return javaServer(root, options)
}

async function pythonServer(root: string, options: { install: boolean }): Promise<ResolvedServer> {
    await requirePython()
    const interpreter = await pythonInterpreter(root)
    const launcher = await pythonLauncher(root, options)
    return {
        name: `pyright ${config.python.version}`,
        spec: {
            name: "pyright",
            command: launcher.command,
            args: launcher.args,
            cwd: root,
            settings: {
                python: {
                    ...(interpreter ? { pythonPath: interpreter } : {}),
                    analysis: { diagnosticMode: "openFilesOnly" },
                },
                pyright: { disableOrganizeImports: true },
            },
            pull: false,
        },
    }
}

async function pythonLauncher(root: string, options: { install: boolean }): Promise<{ command: string; args: string[] }> {
    const standalone = await findOnPath("pyright-langserver")
    if (standalone) return { command: standalone, args: ["--stdio"] }
    const configured = process.env.OPENCODE_LSP_PYRIGHT
    const local = configured && await fileExists(configured) ? configured : await packageEntry(root, "pyright", config.python.server)
    if (local) return { command: await requireNode(), args: [local, "--stdio"] }
    const directory = serverDirectory("pyright", config.python.version)
    const managed = packagedScript(directory, "pyright", config.python.server)
    if (!await fileExists(managed)) {
        if (!options.install) throw new LspError("MISSING_SERVER", `pyright ${config.python.version} is not installed. Install pyright-langserver, set OPENCODE_LSP_PYRIGHT or enable lsp.install.`)
        await installPackage(directory, { pyright: config.python.version }, "nextcode-pyright")
        if (!await fileExists(managed)) throw new LspError("INSTALL", "The pyright package does not contain a language server entrypoint.")
    }
    return { command: await requireNode(), args: [managed, "--stdio"] }
}

async function javascriptServer(root: string, options: { install: boolean }): Promise<ResolvedServer> {
    const configured = process.env.OPENCODE_LSP_TYPESCRIPT
    if (configured && await fileExists(configured)) {
        const node = await requireNode()
        return { name: "TypeScript · configured", spec: { name: "typescript", command: node, args: [configured, "--stdio"], cwd: root } }
    }
    const native = await nativeTypeScript(root)
    if (native) {
        const version = await readVersion(join(native.directory, "package.json"))
        return {
            name: `TypeScript ${version ?? "7"} · native`,
            spec: {
                name: "typescript",
                command: native.command,
                args: native.args,
                cwd: root,
                initializationOptions: { hostInfo: "nextcode" },
                pull: true,
            },
        }
    }
    const node = await requireNode()
    const local = await packageEntry(root, "typescript-language-server", "lib/cli.mjs")
    if (local) return { name: "TypeScript · project", spec: languageServerSpec(local, root, node) }
    const directory = serverDirectory("typescript-language-server", config.typescript.languageServer.version)
    const managed = packagedScript(directory, "typescript-language-server", config.typescript.languageServer.entry)
    if (!await fileExists(managed)) {
        if (!options.install) throw new LspError("MISSING_SERVER", "No TypeScript language server is installed. Set OPENCODE_LSP_TYPESCRIPT or enable lsp.install.")
        await installPackage(directory, {
            "typescript-language-server": config.typescript.languageServer.version,
            typescript: config.typescript.compiler.version,
        }, "nextcode-typescript")
        if (!await fileExists(managed)) throw new LspError("INSTALL", "The typescript-language-server package does not contain an entrypoint.")
    }
    return { name: `TypeScript ${config.typescript.compiler.version} · managed`, spec: languageServerSpec(managed, root, node, join(directory, "node_modules", "typescript", "lib")) }
}

function languageServerSpec(entry: string, root: string, node: string, tsdk?: string): ServerSpec {
    return {
        name: "typescript",
        command: node,
        args: [entry, "--stdio"],
        cwd: root,
        initializationOptions: {
            hostInfo: "nextcode",
            disableAutomaticTypingAcquisition: true,
            ...(tsdk ? { tsserver: { path: tsdk } } : {}),
        },
        pull: false,
    }
}

async function clangdServer(root: string, options: { install: boolean }): Promise<ResolvedServer> {
    const configured = process.env.OPENCODE_LSP_CLANGD
    const local = configured && await fileExists(configured) ? configured : undefined
    const system = local ? undefined : await findOnPath("clangd")
    const database = await fileExists(join(root, "compile_commands.json")) || await fileExists(join(root, "compile_flags.txt"))
    return {
        name: local ? "clangd · configured" : system ? "clangd · system" : `clangd ${config.c.clangd.version}`,
        spec: {
            name: "clangd",
            command: local ?? system ?? await managedClangd(options),
            args: [
                "--background-index",
                "--clang-tidy=false",
                "--header-insertion=never",
                "--pch-storage=memory",
                ...(database ? [`--compile-commands-dir=${root}`] : []),
            ],
            cwd: root,
            pull: false,
        },
    }
}

async function managedClangd(options: { install: boolean }): Promise<string> {
    const binary = clangdBinary()
    if (await fileExists(binary)) return binary
    if (!options.install) throw new LspError("MISSING_SERVER", `clangd ${config.c.clangd.version} is not installed. Install clangd, set OPENCODE_LSP_CLANGD or enable lsp.install.`)
    return installClangd()
}

async function javaServer(root: string, options: { install: boolean }): Promise<ResolvedServer> {
    const java = await requireJava()
    const jdtls = await jdtlsDirectory(options)
    const launcher = await launcherJar(jdtls)
    if (!launcher) throw new LspError("INSTALL", "The jdtls installation has no Equinox launcher.")
    const platform = process.platform === "win32" ? "config_win" : process.platform === "darwin" ? "config_mac" : "config_linux"
    const runtime = await resolveJava()
    const settings = {
        java: {
            import: { gradle: { enabled: true }, maven: { enabled: true } },
            completion: { guessMethodArguments: false },
            referencesCodeLens: { enabled: false },
            implementationsCodeLens: { enabled: false },
            ...(runtime ? {
                configuration: {
                    runtimes: [{ name: `JavaSE-${config.java.jdk.feature}`, path: runtime, default: true }],
                },
            } : {}),
            jdt: { ls: { java: { home: runtime ?? java } } },
        },
    }
    return {
        name: `JDT LS ${config.java.jdt.version}`,
        spec: {
            name: "jdtls",
            command: java,
            args: [
                "-Declipse.application=org.eclipse.jdt.ls.core.id1",
                "-Dosgi.bundles.defaultStartLevel=4",
                "-Declipse.product=org.eclipse.jdt.ls.core.product",
                "-Dlog.level=ERROR",
                "-Xmx1G",
                "--add-modules=ALL-SYSTEM",
                "--add-opens", "java.base/java.util=ALL-UNNAMED",
                "--add-opens", "java.base/java.lang=ALL-UNNAMED",
                "-jar", launcher,
                "-configuration", join(jdtls, platform),
                "-data", join(runtimeDirectory("jdtls-workspaces"), workspaceKey(root)),
            ],
            cwd: root,
            initializationOptions: {
                extendedClientCapabilities: {
                    progressReportProvider: false,
                    classFileContentsSupport: false,
                    promptOnDecompiledSources: false,
                    actionableNotificationSupport: false,
                    executeClientCommandSupport: false,
                    overrideMethodsPromptSupport: false,
                },
                settings,
            },
            settings,
            pull: false,
        },
    }
}

async function jdtlsDirectory(options: { install: boolean }): Promise<string> {
    const configured = process.env.OPENCODE_LSP_JDTLS
    if (configured && await fileExists(join(configured, "plugins"))) return configured
    const directory = serverDirectory("jdtls", `${config.java.jdt.version}-${config.java.jdt.build}`)
    if (await fileExists(join(directory, "plugins"))) return directory
    if (!options.install) throw new LspError("MISSING_SERVER", `Eclipse JDT LS ${config.java.jdt.version} is not installed. Set OPENCODE_LSP_JDTLS or enable lsp.install.`)
    return installJdtls()
}

async function requireJava(): Promise<string> {
    const found = await resolveJava()
    if (found && ((await javaMajor(found)) ?? 0) >= config.java.jdk.feature) return found
    throw new LspError("MISSING_RUNTIME", `Eclipse JDT LS requires a local JDK ${config.java.jdk.feature} or newer. Install one or set JAVA_HOME / OPENCODE_LSP_JAVA; runtimes are never downloaded.`)
}

async function requireNode(): Promise<string> {
    const found = await resolveNode()
    if (found) return found
    throw new LspError("MISSING_RUNTIME", "This language server needs a local Node.js 18 or newer runtime. Install one or set OPENCODE_LSP_NODE; runtimes are never downloaded.")
}

async function requirePython(): Promise<string> {
    const found = await resolvePython()
    if (found && ((await pythonMajor(found)) ?? 0) >= 3) return found
    throw new LspError("MISSING_RUNTIME", "pyright needs a local Python 3 runtime. Install one or set OPENCODE_LSP_PYTHON; runtimes are never downloaded.")
}

async function launcherJar(directory: string): Promise<string | undefined> {
    let entries: string[]
    try {
        entries = await readdir(join(directory, "plugins"))
    } catch {
        return undefined
    }
    const launcher = entries.find((entry) => entry.startsWith("org.eclipse.equinox.launcher_") && entry.endsWith(".jar"))
    return launcher ? join(directory, "plugins", launcher) : undefined
}

async function nativeTypeScript(root: string): Promise<{ directory: string; command: string; args: string[] } | undefined> {
    const directory = await packageDirectory(root, "typescript")
    if (!directory) return undefined
    const executable = await nativeBinary(directory)
    if (!executable) return undefined
    const version = await readVersion(join(directory, "package.json"))
    if (!version || Number(version.split(".")[0]) < 7) return undefined
    return { directory, command: executable.command, args: [...executable.args, "--lsp", "--stdio"] }
}

async function nativeBinary(directory: string): Promise<{ command: string; args: string[] } | undefined> {
    const packageName = `typescript-${process.platform}-${process.arch}`
    const native = join(directory, "..", "@typescript", packageName, "lib", WINDOWS ? "tsc.exe" : "tsc")
    if (await fileExists(native)) return { command: native, args: [] }
    const script = join(directory, "lib", "tsc.js")
    if (await fileExists(script)) {
        const node = await resolveNode()
        if (node) return { command: node, args: [script] }
    }
    return undefined
}

async function packageEntry(root: string, module: string, entry: string): Promise<string | undefined> {
    const directory = await packageDirectory(root, module)
    if (!directory) return undefined
    const path = join(directory, entry)
    return await fileExists(path) ? path : undefined
}

async function packageDirectory(root: string, module: string): Promise<string | undefined> {
    for (let current = root;; current = dirname(current)) {
        const candidate = join(current, "node_modules", module)
        if (await fileExists(join(candidate, "package.json"))) return candidate
        if (dirname(current) === current) return undefined
    }
}

async function readVersion(path: string): Promise<string | undefined> {
    try {
        const value = await Bun.file(path).json() as { version?: unknown }
        return typeof value.version === "string" ? value.version : undefined
    } catch {
        return undefined
    }
}

async function pythonInterpreter(root: string): Promise<string | undefined> {
    for (const directory of [".venv", "venv"]) {
        for (const relative of VENV_PYTHON) {
            const candidate = join(root, directory, relative)
            if (await fileExists(candidate)) return candidate
        }
    }
    return undefined
}

function workspaceKey(value: string): string {
    let result = 0
    for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) | 0
    return Math.abs(result).toString(36)
}
