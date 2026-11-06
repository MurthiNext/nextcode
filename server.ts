import { Plugin } from "@opencode/plugin"
import { registerAstTool } from "./src/ast/tool"

export default Plugin.define({
    id: "nextcode",
    setup: registerAstTool,
})
