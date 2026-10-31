import type { Plugin } from "@opencode/plugin/tui"
import { nextCommand } from "./prompt"

export const PREVIOUS_PROMPT = "session.message.user.previous"
export const NEXT_PROMPT = "session.message.user.next"

export interface JumpLayer {
    readonly mode: "global"
    readonly priority: number
    readonly commands: readonly {
        readonly id: string
        readonly title: string
        readonly group: string
        readonly bind: string
        readonly run: () => void
    }[]
}

export function jumpLayer(
    context: Plugin.Context,
    sessionID: () => string | undefined,
    dispatch: (commandID: string) => void,
): JumpLayer {
    return {
        mode: "global",
        priority: 10,
        commands: [
            {
                id: "prompt-jump.previous",
                title: "Jump to previous prompt",
                group: "Session",
                bind: "ctrl+up",
                run: () => dispatch(PREVIOUS_PROMPT),
            },
            {
                id: "prompt-jump.next",
                title: "Jump to next prompt or bottom",
                group: "Session",
                bind: "ctrl+down",
                run: () => {
                    const id = sessionID()
                    dispatch(id ? nextCommand(context, id) : NEXT_PROMPT)
                },
            },
        ],
    }
}
