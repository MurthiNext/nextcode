export interface TokenUsage {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
        readonly read: number
        readonly write: number
    }
}

export interface UsageMessage {
    readonly type?: string
    readonly tokens?: TokenUsage
}

export interface Usage {
    readonly cached: number
    readonly uncached: number
    readonly output: number
    readonly total: number
}

const EMPTY: Usage = { cached: 0, uncached: 0, output: 0, total: 0 }

const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

export function summarize(messages: readonly UsageMessage[]): Usage {
    const sum = messages.reduce(
        (acc, message) => {
            const usage = message.tokens
            if (message.type !== "assistant" || usage === undefined) return acc
            acc.cached += num(usage.cache?.read) + num(usage.cache?.write)
            acc.uncached += num(usage.input)
            acc.output += num(usage.output) + num(usage.reasoning)
            return acc
        },
        { cached: 0, uncached: 0, output: 0 },
    )
    const total = sum.cached + sum.uncached + sum.output
    if (total === 0) return EMPTY
    return { ...sum, total }
}

const UNITS = ["", "K", "M", "G"] as const

export function formatCount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0"
    let scaled = value
    let unit = 0
    let rounded = Math.round(scaled * 10) / 10
    while (rounded >= 1000 && unit < UNITS.length - 1) {
        scaled /= 1000
        unit += 1
        rounded = Math.round(scaled * 10) / 10
    }
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    return text + UNITS[unit]
}
