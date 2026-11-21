# Codiz VS Code Extension (`codiz-vscode`)

A lightweight, subscription-free VS Code extension that connects directly to your **Codiz Cloud / Self-Hosted Gateway** (`/api/v1/chat/completions`), powered by your own trained **Qwen3-4B / Qwen2.5-Coder** model.

## Build & Install Locally

```bash
cd vscode-extension
npm install
npm run compile
# Package into a local .vsix and install in VS Code:
npm run package
code --install-extension codiz-vscode-1.0.0.vsix
```

Or press `F5` inside VS Code with the `vscode-extension/` folder open to launch an Extension Development Host.

## Configuration

1. Open VS Code Settings (`Ctrl+,`) and search for **Codiz**:
   - `codiz.gatewayUrl`: Your Codiz Cloud Run URL (or `http://localhost:3000` locally)
   - `codiz.model`: Your self-hosted Qwen model tag (e.g. `qwen3:4b-q4_K_M` or your LoRA adapter model)
   - `codiz.enableInlineCompletions`: Optional inline Qwen code completion
2. Run **Command Palette -> `Codiz: Set Gateway Bearer Token`** and paste your `CODIZ_API_TOKEN` (stored securely in VS Code `SecretStorage`).
3. Highlight any code and right-click for **Codiz: Explain/Refactor**, **Codiz: Debug**, or **Codiz: Security & Code Review**.
