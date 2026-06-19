# Claude Forge

This repository is split into two subprojects:

- `cli/`: the existing Forge Windows desktop client and all work completed so far.
- `agent/`: reserved for the future self-developed Forge agent.

## Commands

Run commands from the repository root:

```powershell
npm install
npm run dev
npm run typecheck
npm run build:win
```

The root scripts forward to the `@claude-forge/cli` workspace. CLI build output is written under `cli/release/`.

## Subprojects

```text
claude-forge/
  cli/      Existing Forge client
  agent/    Future Forge agent
```

See `cli/README.md` for the current Forge client documentation.
