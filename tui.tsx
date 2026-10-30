/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import { formatCount, summarize } from "./src/tokens"

type Context = Plugin.Context

interface Row {
    readonly value: string
    readonly label: string
}

interface BlockProps {
    readonly context: Context
    readonly sessionID: () => string
}

export function UsageBlock(props: BlockProps) {
    const usage = createMemo(() =>
        summarize(props.context.data.session.message.list(props.sessionID()) ?? []),
    )

    const rows = createMemo<Row[]>(() => {
        const current = usage()
        return [
            { value: formatCount(current.cached), label: "cached" },
            { value: formatCount(current.uncached), label: "uncached" },
            { value: formatCount(current.output), label: "output" },
            { value: formatCount(current.total), label: "total usage" },
        ]
    })

    const palette = () => props.context.theme.text

    return (
        <box flexDirection="column" gap={0}>
            <Show when={usage().total > 0}>
                <box flexDirection="column" gap={0}>
                    <text fg={palette().base}>
                        <b>Context</b>
                    </text>
                    <For each={rows()}>
                        {(row) => (
                            <text wrapMode="none">
                                <span>{row.value}</span>
                                <span style={{ fg: palette().muted }}> {row.label}</span>
                            </text>
                        )}
                    </For>
                </box>
            </Show>
        </box>
    )
}

export default Plugin.define({
    id: "context-usage",
    setup(context) {
        context.ui.slot({
            append: "sidebar.content",
            render: (input) => <UsageBlock context={context} sessionID={() => input.sessionID} />,
        })
    },
})
