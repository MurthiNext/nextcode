/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { jumpLayer } from "./src/jump"
import { UsageBlock } from "./src/UsageBlock"

export default Plugin.define({
    id: "nextcode",
    setup(context) {
        const sessionID = () => {
            const route = context.ui.router.current()
            return route.type === "session" ? route.sessionID : undefined
        }

        context.ui.slot({
            append: "sidebar.content",
            render: (input) => <UsageBlock context={context} sessionID={() => input.sessionID} />,
        })

        context.keymap.layer(() =>
            jumpLayer(context, sessionID, (commandID) => context.keymap.dispatch(commandID)),
        )
    },
})
