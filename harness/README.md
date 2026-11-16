# Chartelis × dsh

Windows x64 bundles dsh **0.2.1-rc.2** and Node **24.13.1**. Users do not need Node, npm, or a separately installed dsh. The editor's existing AI panel displays dsh's original conversation UI. Its left thread manager, right panel, column handles, and workspace picker are hidden; the editor toolbar provides New conversation and Assistant settings. Chat rendering, streaming, model configuration, tool approvals, and stop controls remain owned by dsh.

## Build

`pnpm desktop` and `pnpm desktop:build --bundles nsis` run `scripts/prepare-harness.mjs`. It installs the pinned npm lockfile into ignored `.tools/dsh`, verifies the pinned Node executable's SHA-256, and copies the small integration overlay. `tauri.windows.conf.json` packages that directory as `dsh/`. Node and dependency license notices are included. Existing macOS builds remain available, but this first bundled assistant runtime targets Windows x64.

Stop running development instances before refreshing the dependency lockfile: Windows cannot replace a loaded native addon. The normal build skips npm installation when the lockfile hash matches. To upgrade dsh, update the version and lockfile in this directory, then review the UI selectors and run the checks below; do not silently upgrade the runtime.

## Workspace and lifecycle

The workspace is `folder.trail[0].path`, the folder chosen in Chartelis. Browsing into a subfolder does not switch the agent's project. The host plugin initializes dsh's workspace registry with the canonical selected path and refuses creation of another workspace or removal of that binding. This is workspace selection, **not an additional filesystem sandbox**; dsh's access modes and tool approvals still govern agent actions.

dsh launches only after the assistant is opened with a folder selected. Hiding the assistant keeps the conversation and current work alive. Switching/closing the project, reconnecting, or exiting the application stops the old runtime; a Windows Job Object also terminates its subprocesses. Returning to a project reuses its history. Each canonical project has its own DSH_HOME under the app data directory, including dsh's settings and credentials; configure the model in Assistant settings for that project. Existing Chartelis API profiles are not migrated. No dsh data is written into the project directory by the integration.

The native child WebView uses dsh's authenticated loopback URL without weakening its SameSite=Strict cookie. It receives no editor IPC permissions. Launch tokens stay in memory, and process output/chat logs are not persisted by the integration. Chartelis passes its current palette to the child; the pinned CSS overlay maps dsh tokens and keeps only the conversation column. Editor dialogs temporarily hide the native child to preserve correct stacking.

The agent operates on **saved files**, not unsaved editor buffers. Save before asking it to edit. Use the refresh button next to the folder name to review/reload the current document afterwards; the existing reload confirmation and undo history apply. Existing save conflict detection prevents silently overwriting a file edited externally.

## Verification

- `pnpm test` and `pnpm build`
- `pnpm test:harness`
- `pnpm test:harness:runtime` (Windows; real startup/authentication and two isolated workspaces, no UI automation or model calls)
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Windows UI: open a folder, open AI assistant, confirm only conversation UI is visible; configure a model through the settings button; change theme; open an editor dialog; hide/reopen the assistant; switch projects and confirm the old process exits; close the app and confirm its descendants exit.
- Test generation and tool approvals with a configured provider. No API key is bundled or copied from the developer machine.
