import type { Plugin } from "@opencode/plugin/tui"

export const PREVIOUS_PROMPT = "session.message.user.previous"
export const NEXT_PROMPT = "session.message.user.next"
export const LAST_MESSAGE = "session.last"

export type JumpAction = "next" | "bottom"

const MESSAGE_ID = /msg_[A-Za-z0-9]+/

const isPrompt = (message: any) =>
    message?.type === "user" && String(message.text ?? "").trim().length > 0

export function nextAction(messages: readonly any[], currentIndex: number): JumpAction {
    if (currentIndex < 0) return "next"
    for (let index = currentIndex + 1; index < messages.length; index++) {
        if (isPrompt(messages[index])) return "next"
    }
    return "bottom"
}

export function messageIDFromNodeID(id: string): string | undefined {
    if (!id.startsWith("msg_") && !id.startsWith("session-part:")) return undefined
    return MESSAGE_ID.exec(id)?.[0]
}

const childrenOf = (node: any): any[] =>
    typeof node?.getChildren === "function" ? (node.getChildren() ?? []) : []

const isTranscript = (node: any) =>
    typeof node?.scrollTop === "number" &&
    typeof node?.scrollHeight === "number" &&
    node?.viewport !== undefined &&
    node?.content !== undefined &&
    node?.verticalScrollBar !== undefined

function findTranscript(root: any): any {
    let found: any
    const walk = (node: any, depth: number) => {
        if (found || depth > 80 || !node) return
        if (isTranscript(node)) {
            found = node
            return
        }
        for (const child of childrenOf(node)) walk(child, depth + 1)
    }
    walk(root, 0)
    return found
}

export function viewportIndex(box: any, messages: readonly any[]): number {
    const scrollTop = box.scrollTop
    let best = -1
    let bestOffset = Number.NEGATIVE_INFINITY

    const visit = (node: any, depth: number) => {
        if (depth > 20 || !node) return
        const messageID = messageIDFromNodeID(String(node.id ?? ""))
        if (messageID) {
            const index = messages.findIndex((message) => message.id === messageID)
            if (index !== -1) {
                const offset = node.y - box.y + scrollTop
                if (offset <= scrollTop + 1 && offset >= bestOffset) {
                    best = index
                    bestOffset = offset
                }
            }
        }
        for (const child of childrenOf(node)) visit(child, depth + 1)
    }

    for (const child of childrenOf(box.content)) visit(child, 0)
    return best
}

export function nextCommand(context: Plugin.Context, sessionID: string): string {
    const messages = context.data.session.message.list(sessionID) ?? []
    const box = findTranscript(context.renderer.root)
    const index = box ? viewportIndex(box, messages) : -1
    return nextAction(messages, index) === "bottom" ? LAST_MESSAGE : NEXT_PROMPT
}
