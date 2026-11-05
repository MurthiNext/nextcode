import { expect, test } from "bun:test"
import { NEXT_PROMPT, PREVIOUS_PROMPT, jumpLayer } from "./src/jump"

test("jumpLayer binds ctrl+up and ctrl+down", () => {
    const layer = jumpLayer(() => undefined)
    expect(layer.commands.map((command) => command.bind)).toEqual(["ctrl+up", "ctrl+down"])
    expect(layer.mode).toBe("global")
})

test("jumpLayer dispatches the host navigation commands", () => {
    const dispatched: string[] = []
    const layer = jumpLayer((commandID) => dispatched.push(commandID))
    for (const command of layer.commands) command.run()
    expect(dispatched).toEqual([PREVIOUS_PROMPT, NEXT_PROMPT])
})
