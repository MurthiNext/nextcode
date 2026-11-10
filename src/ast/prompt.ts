export const AST_GUIDANCE = `# ast_grep
Prefer ast_grep over grep/read for structural questions in Java, Python, JS/TS/TSX and C/C++: it matches syntax, ignores comments and string lookalikes, and returns exact ranges.
- outline: signatures of a file or directory before reading whole files. \`path\` works as an alias for a single \`paths\` entry.
- search: pattern like \`System.out.println($ARG)\` or a rule object; add constraints/util when a pattern is too broad.
- locate: the enclosing block at a position, to read only the needed region.
- rewrite then apply: shows a diff with a previewId; apply consumes it once. Re-preview after any file change.
Positions are one-based Unicode code-point columns. For plain text or filenames use grep and glob instead.`
