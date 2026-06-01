# Obsi-Dex

Obsi-Dex is an Obsidian desktop plugin that integrates with the local Codex CLI. It does not call an API directly from the plugin. Instead, it runs `codex exec` as a child process and uses your existing Codex CLI login/configuration.

## Status

Obsi-Dex is experimental software. Use it at your own discretion and keep backups of important vaults before allowing automated edits.

This project is not affiliated with, endorsed by, or sponsored by OpenAI or Obsidian.

## Requirements

- Obsidian desktop
- Node/npm for building the plugin
- Codex CLI installed and authenticated (`codex login`)
- A local environment where running Codex from the command line already works

## Development

```bash
npm install
npm run build
```

Copy or symlink this folder into an Obsidian vault at:

```text
.obsidian/plugins/obsi-dex
```

Then enable **Obsi-Dex** in Community plugins.

## How It Works

- Open the command palette and run **Open Codex chat**.
- Messages are stored in Obsidian plugin data.
- Each send runs `codex exec` with the vault as the working directory.
- The plugin can include the active note path as prompt context.
- Codex can inspect or modify workspace files according to the configured sandbox and approval settings.
- The plugin does not bundle OpenAI credentials, API keys, or Codex auth data.

## Safety

The default sandbox is `workspace-write`, which allows Codex to edit files in the vault. Use `read-only` if you want chat-only behavior. The plugin uses `codex exec`, so it relies on the noninteractive CLI behavior plus the configured sandbox rather than interactive approval prompts.

Review changes made by Codex before relying on them. The plugin is provided as-is, without warranty, and you are responsible for how you use Codex and any files it can access.

## Privacy

Obsi-Dex runs the local Codex CLI and sends your prompts to that CLI process. It does not directly call the OpenAI API, and it does not include or publish your Codex credentials. Your use of Codex itself is governed by the terms and privacy rules that apply to your Codex/OpenAI account.

## License

MIT. See [LICENSE](LICENSE).
