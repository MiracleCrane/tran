# Changelog

## v1.0.3 - 2026-06-17

### Highlights

- Added the new agent backend architecture, including Claude Code and Codex adapters, Codex App Server integration, Codex history loading, and backend-aware model lists.
- Improved foreground responsiveness: view switches, project/session clicks, composer submission, and transcript scrolling now update UI first and ignore stale async results when a newer interaction wins.
- Added progressive transcript hydration for history sessions, loading recent messages first and preloading older messages in the background without interrupting scroll.
- Restored the in-session startup spinner while keeping it non-blocking for normal foreground interaction.
- Improved path and attachment previews: clicking a file or directory now opens the preview pane immediately, shows a loading state, and reports missing or unreadable paths inside the pane instead of freezing the client.
- Added timeout protection around slow path reads, directory scans, and reveal-in-Explorer calls, especially for stale WSL or network paths.
- Reduced WSL path blocking by moving file and directory reads off synchronous filesystem APIs.
- Added a blocking full-screen spinner only for OS directory picker calls, where waiting on Explorer is expected.

### UI And Workflow

- Added Codex-aware runtime status, provider/model handling, composer defaults, and settings controls.
- Improved project switching so rapid clicks can supersede earlier project changes.
- Improved sidebar/session list loading behavior and reduced visible loading churn.
- Improved transcript virtualization tuning for Codex sessions to reduce flicker while scrolling.
- Added safer attachment drag/drop and picker behavior so stale reads cannot re-add attachments after removal or submit.

### Updates And Diagnostics

- Added configurable update download flow with progress reporting.
- Improved diagnostic export/settings import surfaces and runtime status reporting.
- Added marketplace/backend filtering support for plugins and skills.

### Verification

- `npm run typecheck`
- `npm run build`
