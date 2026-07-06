# docs/assets

Static assets referenced by the project docs.

## Wanted: `tui.png`

The top-level `README.md` references `docs/assets/tui.png` — a screenshot (or
GIF) of the full-screen terminal UI: the message pane, the live member sidebar,
and the dedicated input box. Until that file exists the README shows a broken
image.

To capture it: run a real session in a TTY (`./scripts/onboard.sh login
--username you`), get into a conversation with a couple of members, and grab a
~760px-wide screenshot of the terminal. Drop it here as `tui.png`.
