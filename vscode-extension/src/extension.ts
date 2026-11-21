import * as vscode from 'vscode';

const SECRET_TOKEN_KEY = 'codiz.gatewayBearerToken';

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  codiz_provider?: string;
  model?: string;
  error?: { message?: string };
}

async function getBearerToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const existing = await context.secrets.get(SECRET_TOKEN_KEY);
  if (existing) return existing;

  const entered = await vscode.window.showInputBox({
    title: 'Codiz Gateway Token',
    prompt: 'Enter your CODIZ_API_TOKEN or Codiz session Bearer token (stored in VS Code SecretStorage)',
    password: true,
    ignoreFocusOut: true,
  });
  if (entered && entered.trim()) {
    await context.secrets.store(SECRET_TOKEN_KEY, entered.trim());
    return entered.trim();
  }
  return undefined;
}

async function queryCodizGateway(
  context: vscode.ExtensionContext,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens = 1024
): Promise<{ text: string; meta: string }> {
  const cfg = vscode.workspace.getConfiguration('codiz');
  const gatewayUrl = (cfg.get<string>('gatewayUrl') || 'http://localhost:3000').replace(/\/+$/, '');
  const model = cfg.get<string>('model') || 'qwen3:4b-q4_K_M';
  const useRag = cfg.get<boolean>('useKnowledgeRag') ?? true;
  const token = await getBearerToken(context);

  if (!token) {
    throw new Error('No Codiz Bearer token configured. Run "Codiz: Set Gateway Bearer Token".');
  }

  const res = await fetch(`${gatewayUrl}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      use_codiz_rag: useRag,
    }),
  });

  const data = (await res.json()) as OpenAiChatResponse;
  if (!res.ok) {
    throw new Error(data.error?.message || `Codiz Gateway returned HTTP ${res.status}`);
  }

  const text = data.choices?.[0]?.message?.content ?? '';
  const meta = `${data.codiz_provider ?? 'self-hosted'} · ${data.model ?? model}`;
  return { text, meta };
}

class CodizPanel {
  public static current: CodizPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.panel.onDidDispose(() => {
      CodizPanel.current = undefined;
    });

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ask') {
        try {
          const { text, meta } = await queryCodizGateway(this.context, [
            { role: 'user', content: String(msg.prompt || '') },
          ]);
          this.panel.webview.postMessage({ type: 'reply', text, meta });
        } catch (err) {
          this.panel.webview.postMessage({
            type: 'error',
            message: err instanceof Error ? err.message : 'Request failed',
          });
        }
      }
    });
  }

  public static createOrShow(context: vscode.ExtensionContext, initialPrompt?: string): void {
    if (CodizPanel.current) {
      CodizPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'codizWorkbench',
        'Codiz Self-Hosted AI',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      CodizPanel.current = new CodizPanel(panel, context);
    }

    if (initialPrompt) {
      CodizPanel.current.panel.webview.postMessage({
        type: 'prefill',
        prompt: initialPrompt,
      });
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: var(--vscode-font-family); padding: 14px; color: var(--vscode-foreground); }
    textarea { width: 100%; min-height: 90px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 6px; box-sizing: border-box; }
    button { margin-top: 8px; padding: 8px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
    pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5; }
    .meta { font-size: 11px; opacity: 0.75; margin-top: 10px; }
  </style>
</head>
<body>
  <h3>Codiz Self-Hosted Qwen</h3>
  <textarea id="prompt" placeholder="Ask your self-hosted Qwen coding model..."></textarea>
  <button id="send">Run Task</button>
  <div id="meta" class="meta"></div>
  <pre id="out">Ready.</pre>
  <script>
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById('prompt');
    const outEl = document.getElementById('out');
    const metaEl = document.getElementById('meta');

    document.getElementById('send').addEventListener('click', () => {
      const val = promptEl.value.trim();
      if (!val) return;
      outEl.textContent = 'Running on self-hosted Codiz gateway...';
      vscode.postMessage({ type: 'ask', prompt: val });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'prefill') {
        promptEl.value = msg.prompt;
        outEl.textContent = 'Running on self-hosted Codiz gateway...';
        vscode.postMessage({ type: 'ask', prompt: msg.prompt });
      } else if (msg.type === 'reply') {
        metaEl.textContent = msg.meta || '';
        outEl.textContent = msg.text;
      } else if (msg.type === 'error') {
        outEl.textContent = 'Error: ' + msg.message;
      }
    });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codiz.setToken', async () => {
      await context.secrets.delete(SECRET_TOKEN_KEY);
      const token = await getBearerToken(context);
      if (token) {
        vscode.window.showInformationMessage('Codiz Gateway token saved securely.');
      }
    }),

    vscode.commands.registerCommand('codiz.openChat', () => {
      CodizPanel.createOrShow(context);
    }),

    vscode.commands.registerCommand('codiz.askSelection', () => {
      const editor = vscode.window.activeTextEditor;
      const sel = editor?.document.getText(editor.selection) || '';
      const lang = editor?.document.languageId || 'code';
      CodizPanel.createOrShow(
        context,
        `Explain and suggest clean improvements for this ${lang} code:\n\n\`\`\`${lang}\n${sel}\n\`\`\``
      );
    }),

    vscode.commands.registerCommand('codiz.debugSelection', () => {
      const editor = vscode.window.activeTextEditor;
      const sel = editor?.document.getText(editor.selection) || '';
      const lang = editor?.document.languageId || 'code';
      CodizPanel.createOrShow(
        context,
        `Debug this ${lang} snippet, identify root causes, and provide a minimal fix:\n\n\`\`\`${lang}\n${sel}\n\`\`\``
      );
    }),

    vscode.commands.registerCommand('codiz.reviewSelection', () => {
      const editor = vscode.window.activeTextEditor;
      const sel = editor?.document.getText(editor.selection) || '';
      const lang = editor?.document.languageId || 'code';
      CodizPanel.createOrShow(
        context,
        `Perform a security and performance code review on this ${lang} code:\n\n\`\`\`${lang}\n${sel}\n\`\`\``
      );
    }),

    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      {
        async provideInlineCompletionItems(document, position, _ctx, token) {
          const cfg = vscode.workspace.getConfiguration('codiz');
          if (!cfg.get<boolean>('enableInlineCompletions')) return [];

          const prefix = document.getText(
            new vscode.Range(new vscode.Position(Math.max(0, position.line - 25), 0), position)
          );
          if (prefix.trim().length < 8 || token.isCancellationRequested) return [];

          try {
            const { text } = await queryCodizGateway(
              context,
              [
                {
                  role: 'system',
                  content: 'Output ONLY the immediate code continuation. No markdown fences or prose.',
                },
                { role: 'user', content: prefix },
              ],
              96
            );
            if (!text.trim() || token.isCancellationRequested) return [];
            return [new vscode.InlineCompletionItem(text)];
          } catch {
            return [];
          }
        },
      }
    )
  );
}

export function deactivate(): void {}
