import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { c, stripAnsi } from './ansi.ts';

export const SLASH_COMMANDS = [
  '/help',
  '/mode',
  '/model',
  '/search',
  '/web',
  '/run',
  '/read',
  '/eval',
  '/docs',
  '/index',
  '/approve',
  '/yolo',
  '/finetune',
  '/doctor',
  '/tune',
  '/clear',
  '/serve',
  '/exit',
  '/quit',
];

export interface TextAreaPromptOptions {
  mode: string;
  modelLabel: string;
  workspaceName: string;
  historyFile: string;
  getWorkspaceFiles: () => string[];
}

function loadHistory(historyFile: string): string[] {
  try {
    if (!fs.existsSync(historyFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(-100) : [];
  } catch {
    return [];
  }
}

export function appendHistory(historyFile: string, entry: string): void {
  const trimmed = entry.trim();
  if (!trimmed) return;
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    const existing = loadHistory(historyFile);
    if (existing[existing.length - 1] !== trimmed) {
      existing.push(trimmed);
    }
    fs.writeFileSync(historyFile, JSON.stringify(existing.slice(-100)), 'utf8');
  } catch {
    // non-fatal
  }
}

/**
 * Muse-Code-style bordered interactive multi-line text area.
 * Supports multi-line editing (Shift/Alt+Enter, Ctrl+J, trailing `\`), bracketed paste,
 * `@file` / `/slash` Tab completion, and persistent Up/Down history.
 */
export async function promptMuseTextArea(opts: TextAreaPromptOptions): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const line = await rl.question(`codiz [${opts.mode}] > `);
      return line;
    } catch {
      return null;
    } finally {
      rl.close();
    }
  }

  const history = loadHistory(opts.historyFile);

  return new Promise<string | null>((resolve) => {
    let buffer = '';
    let cursor = 0;
    let historyIdx = history.length;
    let draftBeforeHistory = '';
    let suggestionLine = '';
    let lastCtrlCAt = 0;
    let renderedLines = 0;
    let inBracketedPaste = false;
    let disposed = false;

    const getBoxWidth = () => Math.max(54, Math.min(104, (process.stdout.columns || 84) - 2));

    const getLineAndCol = (pos: number): { line: number; col: number; lines: string[] } => {
      const lines = buffer.split('\n');
      let remaining = pos;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) {
          return { line: i, col: remaining, lines };
        }
        remaining -= lines[i].length + 1;
      }
      return { line: lines.length - 1, col: lines[lines.length - 1].length, lines };
    };

    const clearRendered = () => {
      if (renderedLines === 0) return;
      // Move up to top of rendered box and clear down
      if (renderedLines > 1) {
        process.stdout.write(`\x1b[${renderedLines - 1}A`);
      }
      process.stdout.write('\r\x1b[J');
      renderedLines = 0;
    };

    const render = () => {
      clearRendered();
      const boxW = getBoxWidth();
      const innerW = boxW - 4;
      const wsLabel = opts.workspaceName.slice(0, 22);
      const modelShort = opts.modelLabel.slice(0, 26);
      const maxTitleRest = Math.max(10, boxW - 14 - opts.mode.length);
      const titleRest = ` · ${modelShort} · ${wsLabel}`.slice(0, maxTitleRest);
      const titlePlain = ` codiz [${opts.mode}]${titleRest} `;
      const topFill = Math.max(2, boxW - 3 - titlePlain.length);
      const topBorder =
        c.slate('╭─') +
        c.bold(c.emerald(' codiz ')) +
        c.cyan(`[${opts.mode}]`) +
        c.slate(`${titleRest} `) +
        c.slate('─'.repeat(topFill) + '╮');

      const footerRaw = ' Enter send · Alt/Ctrl+J newline · Tab @file /cmd · Ctrl+C exit ';
      const footerPlain = footerRaw.length > boxW - 5 ? ' Enter send · Ctrl+J newline · Tab @file · Ctrl+C exit '.slice(0, boxW - 5) : footerRaw;
      const botFill = Math.max(2, boxW - 3 - footerPlain.length);
      const bottomBorder =
        c.slate('╰─') +
        c.slate(footerPlain) +
        c.slate('─'.repeat(botFill) + '╯');

      const { line: curLine, col: curCol, lines: rawLines } = getLineAndCol(cursor);
      const displayRows: Array<{ text: string; isCursorRow: boolean; cursorVisualCol: number }> = [];

      rawLines.forEach((rawLine, idx) => {
        const prefix = idx === 0 ? '> ' : '  ';
        const avail = Math.max(16, innerW - prefix.length);
        // Word-independent horizontal slice/wrap so cursor stays exact
        if (rawLine.length === 0 && idx === 0 && buffer.length === 0) {
          const placeholder = 'Ask Codiz to inspect, build, debug, or @file...';
          displayRows.push({
            text: c.emerald(prefix) + c.slate(placeholder.slice(0, avail).padEnd(avail)),
            isCursorRow: idx === curLine,
            cursorVisualCol: 2 + prefix.length + curCol,
          });
          return;
        }

        const chunks: string[] = [];
        for (let offset = 0; offset < Math.max(1, rawLine.length); offset += avail) {
          chunks.push(rawLine.slice(offset, offset + avail));
        }

        chunks.forEach((chunk, cIdx) => {
          const rowPrefix = cIdx === 0 ? (idx === 0 ? c.emerald('> ') : '  ') : '  ';
          const pad = ' '.repeat(Math.max(0, avail - chunk.length));
          const chunkStart = cIdx * avail;
          const chunkEnd = chunkStart + chunk.length;
          const cursorInThisChunk =
            idx === curLine &&
            curCol >= chunkStart &&
            (curCol < chunkEnd || (cIdx === chunks.length - 1 && curCol === rawLine.length));

          displayRows.push({
            text: rowPrefix + chunk + pad,
            isCursorRow: cursorInThisChunk,
            cursorVisualCol: 2 + 2 + (curCol - chunkStart),
          });
        });
      });

      const outLines = [
        topBorder,
        ...displayRows.map((r) => `${c.slate('│ ')}${r.text}${c.slate(' │')}`),
        bottomBorder,
      ];
      if (suggestionLine) {
        outLines.push(`  ${c.slate(suggestionLine.slice(0, boxW - 2))}`);
      }

      process.stdout.write(outLines.join('\n'));
      renderedLines = outLines.length;

      // Position hardware terminal cursor inside the active row
      const cursorRowIndex = 1 + Math.max(0, displayRows.findIndex((r) => r.isCursorRow));
      const linesUpFromBottom = outLines.length - 1 - cursorRowIndex;
      const targetCol = Math.max(
        5,
        (displayRows[cursorRowIndex - 1]?.cursorVisualCol ?? 5) + 1
      );
      if (linesUpFromBottom > 0) {
        process.stdout.write(`\x1b[${linesUpFromBottom}A`);
      }
      process.stdout.write(`\x1b[${targetCol}G`);
      // Remember current cursor line relative to bottom? Simpler: always clear from cursor:
      // Wait: if we move cursor up, clearRendered needs to know cursorRowIndex!
      // Let's adjust renderedLines tracking so clearRendered always jumps to top cleanly:
      renderedLines = cursorRowIndex + 1;
    };

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      process.stdout.write('\x1b[?2004l');
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    const submit = () => {
      // Jump to bottom of box and leave a clean newline
      clearRendered();
      const value = buffer;
      if (value.trim()) {
        appendHistory(opts.historyFile, value);
      }
      const preview = value.trim().split('\n')[0] ?? '';
      console.log(`${c.emerald('›')} ${c.white(preview)}${value.includes('\n') ? c.slate(` (+${value.split('\n').length - 1} lines)`) : ''}`);
      cleanup();
      resolve(value);
    };

    const handleTabComplete = () => {
      const beforeCursor = buffer.slice(0, cursor);
      const afterCursor = buffer.slice(cursor);

      // 1. Slash command completion at start of prompt
      const slashMatch = beforeCursor.match(/^(\/[a-zA-Z0-9_-]*)$/);
      if (slashMatch) {
        const prefix = slashMatch[1];
        const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(prefix));
        if (matches.length === 1) {
          const completed = `${matches[0]} `;
          buffer = completed + afterCursor;
          cursor = completed.length;
          suggestionLine = '';
        } else if (matches.length > 1) {
          suggestionLine = `Commands: ${matches.join('  ')}`;
        }
        return;
      }

      // 2. @file completion anywhere in buffer
      const atMatch = beforeCursor.match(/@([a-zA-Z0-9_./-]*)$/);
      if (atMatch) {
        const prefix = atMatch[1].toLowerCase();
        const files = opts.getWorkspaceFiles();
        const matches = files.filter((f) => f.toLowerCase().includes(prefix)).slice(0, 8);
        if (matches.length === 1) {
          const replacement = `@${matches[0]} `;
          const head = beforeCursor.slice(0, beforeCursor.length - atMatch[0].length);
          buffer = head + replacement + afterCursor;
          cursor = (head + replacement).length;
          suggestionLine = '';
        } else if (matches.length > 1) {
          suggestionLine = `Files: ${matches.slice(0, 5).join('  ')}`;
        } else {
          suggestionLine = `No workspace files matching "${atMatch[1]}"`;
        }
      }
    };

    const insertText = (txt: string) => {
      buffer = buffer.slice(0, cursor) + txt + buffer.slice(cursor);
      cursor += txt.length;
      suggestionLine = '';
    };

    const onData = (chunk: Buffer | string) => {
      let str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      // Handle bracketed paste markers
      if (str.includes('\x1b[200~')) {
        inBracketedPaste = true;
        str = str.replace(/\x1b\[200~/g, '');
      }
      if (str.includes('\x1b[201~')) {
        const beforeEnd = str.split('\x1b[201~')[0].replace(/\r\n?/g, '\n');
        insertText(beforeEnd);
        inBracketedPaste = false;
        render();
        return;
      }
      if (inBracketedPaste) {
        insertText(str.replace(/\r\n?/g, '\n'));
        render();
        return;
      }

      // Shift+Enter / Alt+Enter (CSI u or ESC+CR)
      if (str === '\x1b[13;2u' || str === '\x1b\r' || str === '\n') {
        insertText('\n');
        render();
        return;
      }

      // Arrow & navigation keys
      if (str === '\x1b[D') {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (str === '\x1b[C') {
        cursor = Math.min(buffer.length, cursor + 1);
        render();
        return;
      }
      if (str === '\x1b[H' || str === '\x01') {
        // Home / Ctrl+A
        const lineStart = buffer.lastIndexOf('\n', cursor - 1) + 1;
        cursor = lineStart;
        render();
        return;
      }
      if (str === '\x1b[F' || str === '\x05') {
        // End / Ctrl+E
        const nextNl = buffer.indexOf('\n', cursor);
        cursor = nextNl === -1 ? buffer.length : nextNl;
        render();
        return;
      }
      if (str === '\x1b[A') {
        // Up arrow: history on single-line or move up a line
        if (!buffer.includes('\n')) {
          if (historyIdx === history.length) draftBeforeHistory = buffer;
          if (historyIdx > 0) {
            historyIdx--;
            buffer = history[historyIdx];
            cursor = buffer.length;
          }
        } else {
          const { line, col, lines } = getLineAndCol(cursor);
          if (line > 0) {
            const targetCol = Math.min(col, lines[line - 1].length);
            cursor =
              lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + 1, 0) + targetCol;
          }
        }
        render();
        return;
      }
      if (str === '\x1b[B') {
        // Down arrow
        if (!buffer.includes('\n')) {
          if (historyIdx < history.length) {
            historyIdx++;
            buffer = historyIdx === history.length ? draftBeforeHistory : history[historyIdx];
            cursor = buffer.length;
          }
        } else {
          const { line, col, lines } = getLineAndCol(cursor);
          if (line < lines.length - 1) {
            const targetCol = Math.min(col, lines[line + 1].length);
            cursor =
              lines.slice(0, line + 1).reduce((acc, l) => acc + l.length + 1, 0) + targetCol;
          }
        }
        render();
        return;
      }

      // Ctrl+C
      if (str === '\x03') {
        if (buffer.length > 0) {
          buffer = '';
          cursor = 0;
          suggestionLine = 'Cleared prompt (press Ctrl+C again to exit)';
          lastCtrlCAt = Date.now();
          render();
          return;
        }
        if (Date.now() - lastCtrlCAt < 3000 || buffer.length === 0) {
          clearRendered();
          cleanup();
          resolve(null);
          return;
        }
      }

      // Ctrl+D on empty buffer exits cleanly
      if (str === '\x04' && buffer.length === 0) {
        clearRendered();
        cleanup();
        resolve(null);
        return;
      }

      // Ctrl+L clear screen
      if (str === '\x0c') {
        clearRendered();
        process.stdout.write('\x1b[2J\x1b[H');
        render();
        return;
      }

      // Ctrl+U clear buffer
      if (str === '\x15') {
        buffer = '';
        cursor = 0;
        render();
        return;
      }

      // Tab autocomplete
      if (str === '\t') {
        handleTabComplete();
        render();
        return;
      }

      // Backspace
      if (str === '\x7f' || str === '\b') {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          suggestionLine = '';
          render();
        }
        return;
      }

      // Delete key
      if (str === '\x1b[3~') {
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
          render();
        }
        return;
      }

      // Enter key
      if (str === '\r') {
        // Trailing backslash continues multi-line input
        if (cursor === buffer.length && buffer.endsWith('\\')) {
          buffer = buffer.slice(0, -1) + '\n';
          cursor = buffer.length;
          render();
          return;
        }
        submit();
        return;
      }

      // Multi-line paste without bracketed markers (contains \r or \n plus more text)
      if (str.length > 1 && (str.includes('\r') || str.includes('\n'))) {
        insertText(str.replace(/\r\n?/g, '\n'));
        render();
        return;
      }

      // Ignore unknown escape sequences
      if (str.startsWith('\x1b')) {
        return;
      }

      // Printable text
      const cleaned = stripAnsi(str).replace(/[\x00-\x08\x0b-\x1f]/g, '');
      if (cleaned) {
        insertText(cleaned);
        render();
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write('\x1b[?2004h');
    process.stdin.on('data', onData);
    render();
  });
}
