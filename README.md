# Claude Forge

This repository is split into three subprojects:

- `cli/`: the existing Forge Windows desktop client and all work completed so far.
- `cli-mac/`: the Forge macOS desktop client (Claude Code backend; Apple Silicon & Intel).
- `agent/`: reserved for the future self-developed Forge agent.

## Platform support

| Platform | Workspace | Build target | Notes |
|----------|-----------|--------------|-------|
| Windows  | `cli`     | NSIS `.exe`  | Claude Code (native + WSL), Codex, Hermes |
| macOS    | `cli-mac` | `.dmg`       | Claude Code (native). Codex/Hermes/WSL are not available on macOS |

The macOS build resolves the `claude` binary itself (scanning PATH plus
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.claude/local`, …) because a
GUI-launched Electron app does not inherit the user's shell PATH.

## Commands

Run commands from the repository root:

```bash
npm install
```

Windows:

```powershell
npm run dev           # launch the Windows client (hot reload)
npm run typecheck
npm run build:win     # produce cli/release/*.exe
```

macOS:

```bash
npm run cli-mac:dev       # launch the macOS client (hot reload)
npm run cli-mac:typecheck
npm run cli-mac:build:mac # produce cli-mac/release/*.dmg
```

The root scripts forward to the corresponding workspace. CLI build output is
written under `cli/release/` (Windows) and `cli-mac/release/` (macOS).

### macOS prerequisites

1. Install Claude Code on your Mac (the app launches it as a subprocess):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash   # or: brew install claude-code
   ```
2. Build and open the `.dmg`, then drag **Forge** into Applications.
3. First launch: right-click the app → **Open** to bypass Gatekeeper (the build
   is unsigned for local use).

## Subprojects

```text
claude-forge/
  cli/       Forge client (Windows)
  cli-mac/   Forge client (macOS)
  agent/     Future Forge agent
```

See `cli/README.md` / `cli-mac/README.md` for the platform-specific client
documentation.
