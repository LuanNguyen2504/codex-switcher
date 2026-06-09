<p align="center">
  <img src="src-tauri/icons/logo.svg" alt="Codex Switcher" width="128" height="128">
</p>

<h1 align="center">Codex Switcher Custom</h1>

<p align="center">
  A customized desktop application for managing multiple OpenAI <a href="https://github.com/openai/codex">Codex CLI</a> accounts.<br>
  Switch accounts, monitor quota, keep reports, and coordinate active accounts from the macOS menu bar.
</p>

## Origin and Attribution

This repository is a custom version based on the original public project:

- Original repository: [Lampese/codex-switcher](https://github.com/Lampese/codex-switcher)
- Original author/owner: [Lampese](https://github.com/Lampese)

Thanks to Lampese for creating and publishing the original Codex Switcher project. This custom version keeps the original project attribution and documents the additional behavior added for personal workflow needs.

No `LICENSE` file was present in the checked original repository at the time this README was updated. If you reuse this project, review the original repository and respect the original author's copyright and licensing choices.

## License

The custom modifications in this repository are published under the MIT License. See [LICENSE](LICENSE).

Because this repository is derived from [Lampese/codex-switcher](https://github.com/Lampese/codex-switcher), original upstream portions remain copyright their original author(s). See [NOTICE.md](NOTICE.md) for attribution and scope details.

## Custom Features

- **Multi-account management** - Add, rename, delete, import, export, and manage multiple Codex accounts.
- **OAuth and auth file import** - Add accounts with OAuth login or by importing an existing `auth.json`.
- **Generate new login link** - Create a fresh OAuth link without waiting for the previous callback flow to time out.
- **Quick account switching** - Switch active Codex account from the main UI or the menu bar popup.
- **Codex-running guard** - Manual switching is blocked while Codex is running; automatic switching can still force a switch when quota requires it.
- **Automatic quota reload** - Reloads quota every 3 minutes using the shared quota reload path.
- **Quota fallback** - If an account reload fails, the previous quota value is retained for coordination and the failure is still visible in reports/UI.
- **Persistent quota history** - Keeps quota history across app restarts, including quota values, reload errors, and reset timing details.
- **Quota reports** - Opens an in-app popup report with the latest snapshots, quota bars, reload status, and clear-log support.
- **Priority auto switch accounts** - Mark priority accounts from the main screen; auto switch chooses eligible priority accounts first.
- **Quota-based auto switch** - After quota reload, the app switches only when the active account has no 5-hour quota or no weekly quota.
- **Alive-account filtering** - Auto switch does not select accounts whose latest quota reload failed.
- **Menu bar quota overview** - Shows active quota in the macOS menu bar and opens a custom HTML quota popup on click.
- **Active-account refresh from menu bar** - Clicking the menu bar item triggers a quota refresh for the active account and updates the menu bar value.
- **Menu-bar-only mode** - The app can stay out of the Dock while hidden and return to the Dock when the main window is opened.
- **LAN dashboard mode** - Serves the same dashboard over HTTP for local network access when needed.

## Auto Switch Order

When automatic switching is needed, eligible accounts are sorted by:

1. Accounts with both 5-hour quota and weekly quota remaining.
2. Priority accounts marked with the star toggle.
3. Highest weekly quota remaining.
4. Nearest weekly reset time.
5. Highest 5-hour quota remaining.
6. Nearest 5-hour reset time.

Accounts with 0% 5-hour quota, 0% weekly quota, or failed quota reload are placed after selectable accounts and are not used for automatic switching.

## Installation

### Download DMG

The current public release includes a macOS Apple Silicon DMG:

- [custom-v0.2.2 release](https://github.com/LuanNguyen2504/codex-switcher/releases/tag/custom-v0.2.2)

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)
- macOS build tools when building `.app` or `.dmg` locally

### Local Toolchain Option

This project can be built without installing Rust and npm caches globally by keeping toolchain data inside the project directory:

```bash
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export PATH="$PWD/.tools/cargo/bin:$PATH"
export npm_config_cache="$PWD/.tools/npm-cache"
```

Install dependencies:

```bash
npx pnpm@11.5.1 install
```

Run the app in development mode:

```bash
npx pnpm@11.5.1 tauri dev
```

Build the frontend:

```bash
npx pnpm@11.5.1 build
```

Build the macOS application bundle:

```bash
npx pnpm@11.5.1 tauri build --bundles app
```

Build the macOS DMG installer:

```bash
npx pnpm@11.5.1 tauri build --bundles dmg
```

Build outputs are written under:

```text
src-tauri/target/release/bundle/
```

If updater artifacts are enabled, Tauri expects `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for signing updater files. The `.app` or `.dmg` bundle may still be created before updater signing fails.

### Run the Dashboard in a Browser

You can also serve the built dashboard over HTTP instead of opening the Tauri shell:

```bash
npx pnpm@11.5.1 lan
```

Optional environment variables:

- `CODEX_SWITCHER_WEB_HOST` to override the bind host.
- `CODEX_SWITCHER_WEB_PORT` to override the port.

The browser dashboard serves the same UI and backend actions through `/api/invoke/*`, which makes it usable over LAN, Tailscale, or a remote host tunnel when you expose the chosen port safely.

## Release Builds

The repository includes a GitHub Actions workflow at `.github/workflows/build.yml` that can build release artifacts for:

- macOS arm64
- macOS x64
- Linux x64
- Windows x64

The workflow can run on version tags such as `v0.2.2` or from manual workflow dispatch.

For updater JSON/signing support, configure these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## Disclaimer

This tool is designed exclusively for individuals who personally own multiple OpenAI/ChatGPT accounts. It is intended to help users manage their own accounts more conveniently.

This tool is not intended for:

- Sharing accounts between multiple users.
- Circumventing OpenAI's terms of service.
- Any form of account pooling or credential sharing.

By using this software, you agree that you are the rightful owner of all accounts you add to the application. The maintainers of this custom version are not responsible for misuse or violations of OpenAI's terms of service.

## Versioning

Use the version bump helper to keep app versions in sync across Tauri, Cargo, and the frontend.

```bash
# Exact version
npx pnpm@11.5.1 version:bump 0.2.2

# Semver bumps
npx pnpm@11.5.1 version:patch
npx pnpm@11.5.1 version:minor
npx pnpm@11.5.1 version:major

# Prepare a release commit and tag
npx pnpm@11.5.1 release patch

# Prepare and push a release
npx pnpm@11.5.1 release patch -- --push
```
