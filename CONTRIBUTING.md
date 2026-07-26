# Contributing

Thanks for helping improve MCP Matrix.

## Development

Use Node.js 20.19 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run the local app with `npm run dev`, then open <http://127.0.0.1:4318>.

## Adapter changes

- Start from the coding agent's official documentation and record material compatibility findings in `docs/official-client-matrix.md`.
- Normalize native configuration into the canonical model before serializing for another agent. Never copy a native node directly across agents.
- Preserve comments, unrelated settings, scope precedence, and client-specific semantics.
- Block a change when the target cannot represent the source faithfully. Do not guess a transport or materialize a secret to make a conversion work.
- Keep real user configuration read-only during development. Write-path tests must use temporary directories and an isolated `MCP_MATRIX_HOME`.

## Pull requests

Keep changes focused, explain user-visible behavior and safety implications, and include targeted tests. All checks in the development section must pass before review.

By submitting a contribution, you agree that it may be distributed under the project's MIT License.
