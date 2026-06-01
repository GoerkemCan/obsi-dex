import {
  App,
  ButtonComponent,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TextAreaComponent,
  WorkspaceLeaf
} from "obsidian";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const VIEW_TYPE_OBSI_DEX = "obsi-dex-chat-view";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type MessageRole = "user" | "assistant";

interface ObsiDexSettings {
  codexCommand: string;
  model: string;
  profile: string;
  sandboxMode: SandboxMode;
  includeActiveNote: boolean;
  maxHistoryMessages: number;
  extraArgs: string;
  customWorkspace: string;
}

interface ChatMessage {
  role: MessageRole;
  content: string;
  timestamp: number;
}

interface CodexChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface ObsiDexData {
  settings: ObsiDexSettings;
  chats: CodexChat[];
  activeChatId: string | null;
}

const DEFAULT_SETTINGS: ObsiDexSettings = {
  codexCommand: "codex",
  model: "",
  profile: "",
  sandboxMode: "workspace-write",
  includeActiveNote: true,
  maxHistoryMessages: 12,
  extraArgs: "",
  customWorkspace: ""
};

export default class ObsiDexPlugin extends Plugin {
  settings: ObsiDexSettings = { ...DEFAULT_SETTINGS };
  chats: CodexChat[] = [];
  activeChatId: string | null = null;
  private runningProcess: ChildProcessWithoutNullStreams | null = null;
  private runWasStopped = false;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(
      VIEW_TYPE_OBSI_DEX,
      (leaf) => new ObsiDexView(leaf, this)
    );

    this.addRibbonIcon("bot", "Open Codex chat", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-codex-chat",
      name: "Open Codex chat",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "show-obsi-dex-debug",
      name: "Show Obsi-Dex debug info",
      callback: () => {
        new Notice(`Obsi-Dex ${this.manifest.version} loaded from ${this.manifest.dir ?? "unknown"}`);
        // Keep a console breadcrumb because Notice truncates long paths.
        console.log("Obsi-Dex debug", {
          version: this.manifest.version,
          dir: this.manifest.dir,
          viewLeaves: this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSI_DEX).length
        });
      }
    });

    this.addSettingTab(new ObsiDexSettingTab(this.app, this));
  }

  onunload(): void {
    this.stopCodexRun();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OBSI_DEX);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSI_DEX)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new ObsiDexModal(this.app, this).open();
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_OBSI_DEX,
      active: true,
      state: {}
    });
    this.app.workspace.revealLeaf(leaf);
  }

  getActiveChat(): CodexChat {
    let chat = this.chats.find((item) => item.id === this.activeChatId);
    if (!chat) {
      chat = this.createChat();
    }
    return chat;
  }

  createChat(): CodexChat {
    const now = Date.now();
    const chat: CodexChat = {
      id: String(now),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.chats.unshift(chat);
    this.activeChatId = chat.id;
    void this.savePluginData();
    return chat;
  }

  async selectChat(chatId: string): Promise<void> {
    this.activeChatId = chatId;
    await this.savePluginData();
  }

  async sendMessage(
    message: string,
    onStatus: (status: string) => void,
    onSaved?: () => void
  ): Promise<string> {
    const chat = this.getActiveChat();
    const now = Date.now();
    chat.messages.push({ role: "user", content: message, timestamp: now });
    chat.updatedAt = now;
    if (chat.title === "New chat") {
      chat.title = this.titleFromMessage(message);
    }
    await this.savePluginData();
    onSaved?.();

    const prompt = await this.buildCodexPrompt(chat);
    const reply = await this.runCodex(prompt, onStatus);

    chat.messages.push({
      role: "assistant",
      content: reply || "(Codex finished without a final message.)",
      timestamp: Date.now()
    });
    chat.updatedAt = Date.now();
    await this.savePluginData();
    return reply;
  }

  stopCodexRun(): void {
    if (!this.runningProcess) {
      return;
    }

    this.runWasStopped = true;
    this.runningProcess.kill();
  }

  async savePluginData(): Promise<void> {
    const data: ObsiDexData = {
      settings: this.settings,
      chats: this.chats,
      activeChatId: this.activeChatId
    };
    await this.saveData(data);
  }

  private async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as Partial<ObsiDexData> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(data?.settings ?? {})
    };
    this.chats = data?.chats ?? [];
    this.activeChatId = data?.activeChatId ?? this.chats[0]?.id ?? null;
    if (this.chats.length === 0) {
      this.createChat();
    }
  }

  private titleFromMessage(message: string): string {
    const compact = message.replace(/\s+/g, " ").trim();
    return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact || "New chat";
  }

  private async buildCodexPrompt(chat: CodexChat): Promise<string> {
    const history = chat.messages.slice(-this.settings.maxHistoryMessages);
    const activeNote = this.settings.includeActiveNote
      ? await this.getActiveNoteContext()
      : "";

    return [
      "You are Codex running from an Obsidian plugin.",
      "Use the vault workspace as the project root. Answer the user directly and modify files only when the user asks for changes.",
      "When referencing files, prefer vault-relative paths.",
      "",
      activeNote,
      activeNote ? "" : "",
      "Conversation:",
      ...history.map((message) => {
        const role = message.role === "user" ? "User" : "Codex";
        return `<${role}>\n${message.content}\n</${role}>`;
      })
    ].filter(Boolean).join("\n");
  }

  private async getActiveNoteContext(): Promise<string> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      return "";
    }

    return [
      `<active-note path="${file.path}">`,
      "The user currently has this note open. Read it from the vault only if needed.",
      "</active-note>"
    ].join("\n");
  }

  private getWorkspacePath(): string {
    const custom = this.settings.customWorkspace.trim();
    if (custom) {
      return custom;
    }

    const adapter = this.app.vault.adapter as { basePath?: string };
    return adapter.basePath ?? process.cwd();
  }

  private async runCodex(
    prompt: string,
    onStatus: (status: string) => void
  ): Promise<string> {
    if (this.runningProcess) {
      throw new Error("Codex is already running.");
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsi-dex-"));
    const outputPath = path.join(tempDir, "last-message.txt");
    const args = this.buildCodexArgs(outputPath);
    const workspacePath = this.getWorkspacePath();
    const command = this.settings.codexCommand.trim() || "codex";
    let stderr = "";
    this.runWasStopped = false;

    onStatus("Starting Codex...");

    return new Promise((resolve, reject) => {
      const child = this.spawnCodex(command, args, workspacePath);

      this.runningProcess = child;

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          onStatus(this.statusFromStdout(text));
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (error) => {
        this.runningProcess = null;
        this.cleanupTempDir(tempDir);
        reject(error);
      });

      child.on("close", (code) => {
        const wasStopped = this.runWasStopped;
        this.runWasStopped = false;
        this.runningProcess = null;
        const output = fs.existsSync(outputPath)
          ? fs.readFileSync(outputPath, "utf8").trim()
          : "";
        this.cleanupTempDir(tempDir);

        if (wasStopped) {
          reject(new CodexRunStoppedError());
          return;
        }

        if (code === 0) {
          resolve(output);
          return;
        }

        const detail = stderr.trim() || `Codex exited with code ${code ?? "unknown"}.`;
        reject(new Error(detail));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  private spawnCodex(
    command: string,
    args: string[],
    workspacePath: string
  ): ChildProcessWithoutNullStreams {
    if (process.platform !== "win32") {
      return spawn(command, args, {
        cwd: workspacePath,
        env: process.env,
        shell: false
      });
    }

    const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd: workspacePath,
      env: process.env,
      shell: false,
      windowsHide: true
    });
  }

  private buildCodexArgs(outputPath: string): string[] {
    const args = [
      "exec",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-s",
      this.settings.sandboxMode,
      "-o",
      outputPath
    ];

    if (this.settings.model.trim()) {
      args.push("-m", this.settings.model.trim());
    }

    if (this.settings.profile.trim()) {
      args.push("-p", this.settings.profile.trim());
    }

    args.push(...splitArgs(this.settings.extraArgs));
    args.push("-");
    return args;
  }

  private statusFromStdout(text: string): string {
    const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
    if (!lastLine) {
      return "Codex is running...";
    }

    try {
      const event = JSON.parse(lastLine) as { type?: string; message?: string };
      return event.message ?? event.type ?? "Codex is running...";
    } catch {
      return lastLine.length > 80 ? `${lastLine.slice(0, 77)}...` : lastLine;
    }
  }

  private cleanupTempDir(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort.
    }
  }
}

class ObsiDexView extends ItemView {
  private plugin: ObsiDexPlugin;
  private rootEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private chatListEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private chatTitleEl: HTMLElement | null = null;
  private input: TextAreaComponent | null = null;
  private sendButton: ButtonComponent | null = null;
  private stopButton: ButtonComponent | null = null;
  private isSidebarCollapsed = false;
  private isThinking = false;

  constructor(leaf: WorkspaceLeaf, plugin: ObsiDexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_OBSI_DEX;
  }

  getDisplayText(): string {
    return "Codex chat";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    try {
      this.render();
    } catch (error) {
      this.renderError(error);
    }
  }

  render(): void {
    const container = this.contentEl;
    this.rootEl = container;
    container.empty();
    container.removeClass("obsi-dex-error");
    container.addClass("obsi-dex-view");
    container.toggleClass("obsi-dex-sidebar-is-collapsed", this.isSidebarCollapsed);

    const sidebar = container.createDiv();
    sidebar.addClass("obsi-dex-sidebar");
    const main = container.createDiv();
    main.addClass("obsi-dex-main");

    sidebar.createEl("div", { text: "Loading chats..." });
    main.createEl("div", { text: "Loading Codex chat..." });

    sidebar.empty();
    main.empty();
    this.renderSidebar(sidebar);
    this.renderMain(main);
    this.refresh();
  }

  private renderError(error: unknown): void {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    this.contentEl.empty();
    this.contentEl.removeClass("obsi-dex-view");
    this.contentEl.addClass("obsi-dex-error");
    this.contentEl.createEl("h3", { text: "Obsi-Dex failed to render" });
    this.contentEl.createEl("pre", { text: detail });
    new Notice("Obsi-Dex failed to render. Check the chat pane for details.");
  }

  private renderSidebar(sidebar: HTMLElement): void {
    sidebar.toggleClass("is-collapsed", this.isSidebarCollapsed);
    const header = sidebar.createDiv("obsi-dex-sidebar-header");
    if (!this.isSidebarCollapsed) {
      header.createEl("strong", { text: "Chats" });
    }

    new ButtonComponent(header)
      .setIcon(this.isSidebarCollapsed ? "panel-left-open" : "panel-left-close")
      .setTooltip(this.isSidebarCollapsed ? "Show chats" : "Hide chats")
      .onClick(() => {
        this.isSidebarCollapsed = !this.isSidebarCollapsed;
        this.render();
      });

    new ButtonComponent(header)
      .setIcon("plus")
      .setTooltip("New chat")
      .onClick(() => {
        this.plugin.createChat();
        this.refresh();
      });

    this.chatListEl = this.isSidebarCollapsed
      ? null
      : sidebar.createDiv("obsi-dex-chat-list");
  }

  private renderMain(main: HTMLElement): void {
    const toolbar = main.createDiv("obsi-dex-toolbar");
    this.chatTitleEl = toolbar.createDiv("obsi-dex-title");
    this.statusEl = toolbar.createDiv("obsi-dex-status");

    this.messagesEl = main.createDiv("obsi-dex-messages");

    const composer = main.createDiv("obsi-dex-composer");
    this.input = new TextAreaComponent(composer)
      .setPlaceholder("Ask Codex to inspect, explain, or edit files in this vault...");
    this.input.inputEl.addClass("obsi-dex-input");
    this.input.inputEl.addEventListener("keydown", (event) => {
      if (shouldSubmitFromTextarea(event)) {
        event.preventDefault();
        void this.submit();
      }
    });

    const actions = composer.createDiv("obsi-dex-composer-actions");
    new Setting(actions)
      .setClass("obsi-dex-option")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeActiveNote)
          .onChange(async (value) => {
            this.plugin.settings.includeActiveNote = value;
            await this.plugin.savePluginData();
          });
      })
      .setName("Active note path");

    this.sendButton = new ButtonComponent(actions)
      .setButtonText("Send")
      .setCta()
      .onClick(() => void this.submit());

    this.stopButton = new ButtonComponent(actions)
      .setButtonText("Stop")
      .onClick(() => {
        this.isThinking = false;
        this.plugin.stopCodexRun();
        this.refresh();
        this.setBusy(false, "Stopped.");
      });
    this.stopButton.buttonEl.hide();
  }

  private refresh(): void {
    const chat = this.plugin.getActiveChat();

    if (this.chatTitleEl) {
      this.chatTitleEl.setText(chat.title);
    }
    if (this.statusEl) {
      this.statusEl.setText(this.isThinking ? "Waiting for Codex..." : `${chat.messages.length} messages`);
    }

    this.renderChatList();
    this.renderMessages();
  }

  private renderChatList(): void {
    if (!this.chatListEl) {
      return;
    }

    this.chatListEl.empty();
    for (const chat of this.plugin.chats) {
      const button = this.chatListEl.createEl("button", {
        cls: "obsi-dex-chat-button",
        text: chat.title
      });
      if (chat.id === this.plugin.activeChatId) {
        button.addClass("is-active");
      }
      button.addEventListener("click", async () => {
        await this.plugin.selectChat(chat.id);
        this.refresh();
      });
    }
  }

  private renderMessages(): void {
    if (!this.messagesEl) {
      return;
    }

    this.messagesEl.empty();
    const chat = this.plugin.getActiveChat();
    for (const message of chat.messages) {
      const item = this.messagesEl.createDiv({
        cls: `obsi-dex-message obsi-dex-message-${message.role}`
      });
      item.createDiv({
        cls: "obsi-dex-message-role",
        text: message.role === "user" ? "You" : "Codex"
      });
      item.createDiv({
        cls: "obsi-dex-message-content",
        text: message.content
      });
    }

    if (this.isThinking) {
      const item = this.messagesEl.createDiv({
        cls: "obsi-dex-message obsi-dex-message-assistant obsi-dex-message-thinking"
      });
      item.createDiv({
        cls: "obsi-dex-message-role",
        text: "Codex"
      });
      const content = item.createDiv("obsi-dex-message-content");
      content.createSpan({ text: "Thinking" });
      const dots = content.createSpan("obsi-dex-thinking-dots");
      dots.createSpan({ text: "." });
      dots.createSpan({ text: "." });
      dots.createSpan({ text: "." });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async submit(): Promise<void> {
    const message = this.input?.getValue().trim() ?? "";
    if (!message) {
      return;
    }

    this.input?.setValue("");
    this.isThinking = true;
    this.setBusy(true, "Running Codex...");
    this.refresh();

    try {
      await this.plugin.sendMessage(
        message,
        (status) => this.setStatus(status),
        () => this.refresh()
      );
      this.isThinking = false;
      this.refresh();
      this.setBusy(false, "Ready.");
    } catch (error) {
      this.isThinking = false;
      this.refresh();
      if (error instanceof CodexRunStoppedError) {
        this.setBusy(false, "Stopped.");
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`Codex failed: ${detail}`);
      this.setBusy(false, "Failed.");
    }
  }

  private setBusy(isBusy: boolean, status: string): void {
    this.setStatus(status);
    this.sendButton?.setDisabled(isBusy);
    if (isBusy) {
      this.stopButton?.buttonEl.show();
    } else {
      this.stopButton?.buttonEl.hide();
    }
  }

  private setStatus(status: string): void {
    this.statusEl?.setText(status);
  }
}

class ObsiDexModal extends Modal {
  private plugin: ObsiDexPlugin;
  private rootEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private chatListEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private chatTitleEl: HTMLElement | null = null;
  private input: TextAreaComponent | null = null;
  private sendButton: ButtonComponent | null = null;
  private stopButton: ButtonComponent | null = null;
  private isSidebarCollapsed = false;
  private isThinking = false;

  constructor(app: App, plugin: ObsiDexPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass("obsi-dex-modal");
    this.contentEl.empty();
    this.rootEl = this.contentEl;
    this.contentEl.addClass("obsi-dex-view");
    this.contentEl.toggleClass("obsi-dex-sidebar-is-collapsed", this.isSidebarCollapsed);

    const sidebar = this.contentEl.createDiv();
    sidebar.addClass("obsi-dex-sidebar");
    const main = this.contentEl.createDiv();
    main.addClass("obsi-dex-main");

    this.renderSidebar(sidebar);
    this.renderMain(main);
    this.refresh();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderSidebar(sidebar: HTMLElement): void {
    sidebar.toggleClass("is-collapsed", this.isSidebarCollapsed);
    const header = sidebar.createDiv("obsi-dex-sidebar-header");
    if (!this.isSidebarCollapsed) {
      header.createEl("strong", { text: "Chats" });
    }

    new ButtonComponent(header)
      .setIcon(this.isSidebarCollapsed ? "panel-left-open" : "panel-left-close")
      .setTooltip(this.isSidebarCollapsed ? "Show chats" : "Hide chats")
      .onClick(() => {
        this.isSidebarCollapsed = !this.isSidebarCollapsed;
        this.onOpen();
      });

    new ButtonComponent(header)
      .setIcon("plus")
      .setTooltip("New chat")
      .onClick(() => {
        this.plugin.createChat();
        this.refresh();
      });

    this.chatListEl = this.isSidebarCollapsed
      ? null
      : sidebar.createDiv("obsi-dex-chat-list");
  }

  private renderMain(main: HTMLElement): void {
    const toolbar = main.createDiv("obsi-dex-toolbar");
    this.chatTitleEl = toolbar.createDiv("obsi-dex-title");
    this.statusEl = toolbar.createDiv("obsi-dex-status");

    this.messagesEl = main.createDiv("obsi-dex-messages");

    const composer = main.createDiv("obsi-dex-composer");
    this.input = new TextAreaComponent(composer)
      .setPlaceholder("Ask Codex to inspect, explain, or edit files in this vault...");
    this.input.inputEl.addClass("obsi-dex-input");
    this.input.inputEl.addEventListener("keydown", (event) => {
      if (shouldSubmitFromTextarea(event)) {
        event.preventDefault();
        void this.submit();
      }
    });

    const actions = composer.createDiv("obsi-dex-composer-actions");
    new Setting(actions)
      .setClass("obsi-dex-option")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeActiveNote)
          .onChange(async (value) => {
            this.plugin.settings.includeActiveNote = value;
            await this.plugin.savePluginData();
          });
      })
      .setName("Active note path");

    this.sendButton = new ButtonComponent(actions)
      .setButtonText("Send")
      .setCta()
      .onClick(() => void this.submit());

    this.stopButton = new ButtonComponent(actions)
      .setButtonText("Stop")
      .onClick(() => {
        this.isThinking = false;
        this.plugin.stopCodexRun();
        this.refresh();
        this.setBusy(false, "Stopped.");
      });
    this.stopButton.buttonEl.hide();
  }

  private refresh(): void {
    const chat = this.plugin.getActiveChat();

    this.chatTitleEl?.setText(chat.title);
    this.statusEl?.setText(this.isThinking ? "Waiting for Codex..." : `${chat.messages.length} messages`);
    this.renderChatList();
    this.renderMessages();
  }

  private renderChatList(): void {
    if (!this.chatListEl) {
      return;
    }

    this.chatListEl.empty();
    for (const chat of this.plugin.chats) {
      const button = this.chatListEl.createEl("button", {
        cls: "obsi-dex-chat-button",
        text: chat.title
      });
      if (chat.id === this.plugin.activeChatId) {
        button.addClass("is-active");
      }
      button.addEventListener("click", async () => {
        await this.plugin.selectChat(chat.id);
        this.refresh();
      });
    }
  }

  private renderMessages(): void {
    if (!this.messagesEl) {
      return;
    }

    this.messagesEl.empty();
    const chat = this.plugin.getActiveChat();
    for (const message of chat.messages) {
      const item = this.messagesEl.createDiv({
        cls: `obsi-dex-message obsi-dex-message-${message.role}`
      });
      item.createDiv({
        cls: "obsi-dex-message-role",
        text: message.role === "user" ? "You" : "Codex"
      });
      item.createDiv({
        cls: "obsi-dex-message-content",
        text: message.content
      });
    }

    if (this.isThinking) {
      const item = this.messagesEl.createDiv({
        cls: "obsi-dex-message obsi-dex-message-assistant obsi-dex-message-thinking"
      });
      item.createDiv({
        cls: "obsi-dex-message-role",
        text: "Codex"
      });
      const content = item.createDiv("obsi-dex-message-content");
      content.createSpan({ text: "Thinking" });
      const dots = content.createSpan("obsi-dex-thinking-dots");
      dots.createSpan({ text: "." });
      dots.createSpan({ text: "." });
      dots.createSpan({ text: "." });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async submit(): Promise<void> {
    const message = this.input?.getValue().trim() ?? "";
    if (!message) {
      return;
    }

    this.input?.setValue("");
    this.isThinking = true;
    this.setBusy(true, "Running Codex...");
    this.refresh();

    try {
      await this.plugin.sendMessage(
        message,
        (status) => this.setStatus(status),
        () => this.refresh()
      );
      this.isThinking = false;
      this.refresh();
      this.setBusy(false, "Ready.");
    } catch (error) {
      this.isThinking = false;
      this.refresh();
      if (error instanceof CodexRunStoppedError) {
        this.setBusy(false, "Stopped.");
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`Codex failed: ${detail}`);
      this.setBusy(false, "Failed.");
    }
  }

  private setBusy(isBusy: boolean, status: string): void {
    this.setStatus(status);
    this.sendButton?.setDisabled(isBusy);
    if (isBusy) {
      this.stopButton?.buttonEl.show();
    } else {
      this.stopButton?.buttonEl.hide();
    }
  }

  private setStatus(status: string): void {
    this.statusEl?.setText(status);
  }
}

class ObsiDexSettingTab extends PluginSettingTab {
  plugin: ObsiDexPlugin;

  constructor(app: App, plugin: ObsiDexPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsi-Dex" });

    new Setting(containerEl)
      .setName("Codex command")
      .setDesc("Command or absolute path used to launch the Codex CLI.")
      .addText((text) => text
        .setPlaceholder("codex")
        .setValue(this.plugin.settings.codexCommand)
        .onChange(async (value) => {
          this.plugin.settings.codexCommand = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Optional model passed as `-m`. Leave empty to use your Codex CLI default.")
      .addText((text) => text
        .setPlaceholder("default")
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Profile")
      .setDesc("Optional Codex profile passed as `-p`.")
      .addText((text) => text
        .setPlaceholder("default")
        .setValue(this.plugin.settings.profile)
        .onChange(async (value) => {
          this.plugin.settings.profile = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Sandbox")
      .setDesc("Controls how much filesystem access Codex has.")
      .addDropdown((dropdown) => dropdown
        .addOption("read-only", "read-only")
        .addOption("workspace-write", "workspace-write")
        .addOption("danger-full-access", "danger-full-access")
        .setValue(this.plugin.settings.sandboxMode)
        .onChange(async (value: SandboxMode) => {
          this.plugin.settings.sandboxMode = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Include active note path")
      .setDesc("Adds only the active note path. Codex can read the file from the vault if needed.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeActiveNote)
        .onChange(async (value) => {
          this.plugin.settings.includeActiveNote = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("History messages")
      .setDesc("Number of recent local chat messages sent to Codex each turn.")
      .addText((text) => text
        .setPlaceholder("12")
        .setValue(String(this.plugin.settings.maxHistoryMessages))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.maxHistoryMessages = Number.isFinite(parsed)
            ? Math.max(2, Math.min(40, parsed))
            : DEFAULT_SETTINGS.maxHistoryMessages;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Custom workspace")
      .setDesc("Optional absolute path passed to Codex as the workspace. Empty uses the vault root.")
      .addText((text) => text
        .setPlaceholder("Vault root")
        .setValue(this.plugin.settings.customWorkspace)
        .onChange(async (value) => {
          this.plugin.settings.customWorkspace = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Extra Codex arguments")
      .setDesc("Optional extra arguments appended before the stdin prompt marker.")
      .addText((text) => text
        .setPlaceholder("--search")
        .setValue(this.plugin.settings.extraArgs)
        .onChange(async (value) => {
          this.plugin.settings.extraArgs = value;
          await this.plugin.savePluginData();
        }));
  }
}

function splitArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    args.push(current);
  }
  return args;
}

class CodexRunStoppedError extends Error {
  constructor() {
    super("Codex run stopped.");
    this.name = "CodexRunStoppedError";
  }
}

function quoteWindowsArg(value: string): string {
  if (value.length === 0) {
    return "\"\"";
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  let result = "\"";
  let backslashes = 0;

  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }

    if (char === "\"") {
      result += "\\".repeat(backslashes * 2 + 1);
      result += char;
      backslashes = 0;
      continue;
    }

    result += "\\".repeat(backslashes);
    result += char;
    backslashes = 0;
  }

  result += "\\".repeat(backslashes * 2);
  result += "\"";
  return result;
}

function shouldSubmitFromTextarea(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return false;
  }

  return true;
}
