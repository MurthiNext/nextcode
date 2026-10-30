/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { formatCount, summarize } from "./src/tokens"
import { UsageBlock } from "./tui"

const theme = {
    text: { base: "#ffffff", muted: "#808080" },
} as unknown as Plugin.Context["theme"]

const messages = [
    { type: "user" },
    {
        type: "assistant",
        tokens: { input: 1000, output: 500, reasoning: 100, cache: { read: 2000, write: 300 } },
    },
    {
        type: "assistant",
        tokens: { input: 2000, output: 800, reasoning: 0, cache: { read: 5000, write: 0 } },
    },
]

function context(data: unknown[]) {
    return {
        theme,
        data: { session: { message: { list: () => data } } },
    } as unknown as Plugin.Context
}

async function paint(ctx: Plugin.Context) {
    const setup = await testRender(() => <UsageBlock context={ctx} sessionID={() => "ses_1"} />, {
        width: 40,
        height: 8,
    })
    await setup.flush()
    const frame = setup.captureCharFrame()
    await setup.dispose()
    return frame
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
}

test("summarize aggregates assistant token usage across the session", () => {
    expect(summarize(messages)).toEqual({
        cached: 7300,
        uncached: 3000,
        output: 1400,
        total: 11700,
    })
    expect(summarize([])).toEqual({ cached: 0, uncached: 0, output: 0, total: 0 })
})

test("formatCount uses K/M/G units", () => {
    expect([0, 999, 1000, 1234, 233281, 1234567, 2500000000].map(formatCount)).toEqual([
        "0",
        "999",
        "1K",
        "1.2K",
        "233.3K",
        "1.2M",
        "2.5G",
    ])
})

test("UsageBlock renders the four usage rows", async () => {
    expect(await paint(context(messages))).toEqual([
        "Context",
        "7.3K cached",
        "3K uncached",
        "1.4K output",
        "11.7K total usage",
    ])
})

test("UsageBlock stays hidden without usage", async () => {
    expect(await paint(context([]))).toEqual([])
})
