import process from 'node:process';

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');

const wrap = (open: string, close = '\x1b[0m') =>
  (text: string): string => (useColor ? `${open}${text}${close}` : text);

export const c = {
  bold: wrap('\x1b[1m'),
  dim: wrap('\x1b[2m'),
  italic: wrap('\x1b[3m'),
  emerald: wrap('\x1b[38;5;42m'),
  green: wrap('\x1b[32m'),
  cyan: wrap('\x1b[36m'),
  amber: wrap('\x1b[33m'),
  red: wrap('\x1b[31m'),
  slate: wrap('\x1b[90m'),
  white: wrap('\x1b[97m'),
  bgCode: wrap('\x1b[48;5;236m'),
};

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private idx = 0;
  private timer: NodeJS.Timeout | null = null;
  private label = '';
  private startedAt = Date.now();
  private active = false;

  start(label: string): void {
    this.label = label;
    this.startedAt = Date.now();
    if (!process.stdout.isTTY) {
      process.stdout.write(`${label}...\n`);
      return;
    }
    this.active = true;
    this.render();
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), 90);
    }
  }

  update(label: string): void {
    this.label = label;
    if (this.active) this.render();
  }

  stop(finalLine?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active && process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }
    this.active = false;
    if (finalLine) {
      process.stdout.write(`${finalLine}\n`);
    }
  }

  private render(): void {
    const frame = this.frames[this.idx++ % this.frames.length];
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const cols = Math.max(40, process.stdout.columns || 80);
    const text = `${c.emerald(frame)} ${this.label} ${c.slate(`(${secs}s)`)}`;
    process.stdout.write(`\r\x1b[K${text.slice(0, cols + 24)}`);
  }
}

export function renderMarkdownToTerminal(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';

  for (const line of lines) {
    const fence = line.match(/^```([a-zA-Z0-9_.-]*)\s*$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] || 'code';
        out.push(c.slate(`  ┌─ ${codeLang} ${'─'.repeat(Math.max(8, 48 - codeLang.length))}`));
      } else {
        inCode = false;
        codeLang = '';
        out.push(c.slate(`  └${'─'.repeat(53)}`));
      }
      continue;
    }

    if (inCode) {
      out.push(`${c.slate('  │ ')}${c.cyan(line)}`);
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, '');
      out.push('');
      out.push(c.bold(c.emerald(heading)));
      continue;
    }

    let formatted = line
      .replace(/`([^`]+)`/g, (_m, code) => c.cyan(code))
      .replace(/\*\*([^*]+)\*\*/g, (_m, boldText) => c.bold(boldText));

    if (/^\s*[-*]\s+/.test(formatted)) {
      formatted = formatted.replace(/^(\s*)[-*]\s+/, `$1${c.emerald('•')} `);
    }

    out.push(formatted);
  }

  if (inCode) {
    out.push(c.slate(`  └${'─'.repeat(53)}`));
  }

  return out.join('\n');
}

export function renderUnifiedDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string,
  reason: string
): string {
  const header = [
    c.bold(c.cyan(`--- ${oldContent === null ? '/dev/null (NEW FILE)' : `a/${filePath}`}`)),
    c.bold(c.emerald(`+++ b/${filePath}`)),
    c.slate(`Reason: ${reason}`),
  ];

  const oldLines = oldContent === null ? [] : oldContent.replace(/\r\n/g, '\n').split('\n');
  const newLines = newContent.replace(/\r\n/g, '\n').split('\n');

  const body: string[] = [];
  const maxLines = Math.max(oldLines.length, newLines.length);
  let shown = 0;

  for (let i = 0; i < maxLines; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) {
      const prevChanged = i > 0 && oldLines[i - 1] !== newLines[i - 1];
      const nextChanged = i + 1 < maxLines && oldLines[i + 1] !== newLines[i + 1];
      if (prevChanged || nextChanged) {
        body.push(c.slate(`  ${String(i + 1).padStart(4)} │  ${b ?? ''}`));
      }
      continue;
    }
    if (a !== undefined) {
      body.push(c.red(`- ${String(i + 1).padStart(4)} │ -${a}`));
      shown++;
    }
    if (b !== undefined) {
      body.push(c.green(`+ ${String(i + 1).padStart(4)} │ +${b}`));
      shown++;
    }
    if (shown >= 120) {
      body.push(c.amber(`... [diff preview truncated after 120 changed lines; full file is ${newLines.length} lines]`));
      break;
    }
  }

  if (body.length === 0) {
    body.push(c.slate('  (No line changes detected)'));
  }

  return [...header, ...body].join('\n');
}
