# docs/assets

Static assets referenced by the project docs.

## `tui.png`

The hero image in the top-level `README.md`. It shows the v0.2 full-screen
terminal UI: the message pane, the live member sidebar (with the AI member's
`●`/`○` active-vs-passive marker and an out-of-band-verified `✓`), and the
dedicated input box.

It is a **faithful render of the actual TUI layout** — the frame is transcribed
directly from `apps/cli/src/tui.tsx` (same borders, colors, markers, and the
three-line member rows), not a mock invented for marketing. It is a rendered
representation rather than a photograph of a live relay session; to replace it
with a real capture, run a session in a TTY (`./scripts/onboard.sh login
--username you`), get into a conversation, and grab a ~760px-wide screenshot.
