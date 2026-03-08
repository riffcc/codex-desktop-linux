# Controller Support

Codex Desktop for Linux injects a lightweight controller layer into the webview.

It vendors `gamepad_standardizer` locally so non-standard pads, including 8BitDo-style controllers, get normalized before Riff-specific bindings are applied.

Current bindings:

- `LB`: previous thread
- `RB`: next thread
- `LT`: previous folder, with pressure-sensitive repeat
- `RT`: next folder, with pressure-sensitive repeat
- left stick: arrow-key survey/navigation input
- `D-pad`: arrow-key survey/navigation input
- right stick left/right: switch focus between sidebar and main panel
- right stick up/down: scroll vertically
- `A`: confirm (`Enter`)
- `B`: back/cancel (`Escape`)
- `X`: space
- `Y`: slash
- hold `Select` / Back: hold `Ctrl+Space` for Handy push-to-talk
- hold `Share` on pads that expose it via the browser Gamepad API: open the Riff radial overlay

The Share-button radial overlay is a transparent full-window command wheel:

- left stick: choose the tool family
- right stick: choose the action within that family
- `D-pad`: coarse fallback navigation
- release `Share` or press `A`: execute the highlighted action
- `B`: cancel

Current radial families:

- `Plane`: related tickets, board, current cycle, create issue
- `Search`: current topic, repo search, docs search
- `DeepWiki`: ask question, architecture, read docs
- `Codex-MCP`: work on this, view active agents, abort
- `Session`: interrupt, new thread, resume context
- `Voice`: couch mode, Handy status, survey me

The Handy integration is now a direct keyboard chord bridge. While the button is held, the controller shim emits `Ctrl+Space`; releasing the button releases the chord.
