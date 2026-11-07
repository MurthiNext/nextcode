import { Plugin } from "@opencode/plugin"
import { registerAstTool } from "./src/ast/tool"
import { lspOptions, registerLsp } from "./src/lsp"

export default Plugin.define({
    id: "nextcode",
    async setup(context) {
        const disposeAst = await registerAstTool(context)
        const disposeLsp = await registerLsp(context, lspOptions(context.options))
        return async () => {
            await Promise.allSettled([disposeAst(), disposeLsp()])
        }
    },
})
