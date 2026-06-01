# Obsi-Dex

Obsi-Dex is an Obsidian desktop plugin that integrates with the local Codex CLI. It does not call an API directly from the plugin. Instead, it runs `codex exec` as a child process and uses your existing Codex CLI login/configuration.

## Requirements

- Obsidian desktop
- Node/npm for building the plugin
- Codex CLI installed and authenticated (`codex login`)

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
- The plugin can include the active note as prompt context.
- Codex can inspect or modify workspace files according to the configured sandbox and approval settings.

## Safety

The default sandbox is `workspace-write`, which allows Codex to edit files in the vault. Use `read-only` if you want chat-only behavior. The plugin uses `codex exec`, so it relies on the noninteractive CLI behavior plus the configured sandbox rather than interactive approval prompts.
