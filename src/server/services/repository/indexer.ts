import fs from 'node:fs';
import path from 'node:path';
import { getEnv } from '../../config/env.ts';

export interface IndexedFileSummary {
  relativePath: string;
  language: string;
  sizeBytes: number;
  lineCount: number;
  symbols: string[];
  imports: string[];
}

export interface RepoIndexSnapshot {
  rootName: string;
  indexedAt: string;
  totalFiles: number;
  totalLines: number;
  languages: Record<string, number>;
  files: IndexedFileSummary[];
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-cli',
  'build',
  '.next',
  '.nuxt',
  '.codiz-data',
  '__pycache__',
  '.venv',
  'coverage',
]);

const TEXT_EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript-react',
  '.js': 'javascript',
  '.jsx': 'javascript-react',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.dart': 'dart',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.css': 'css',
  '.html': 'html',
  '.json': 'json',
  '.md': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
  '.ps1': 'powershell',
};

interface CachedFileEntry {
  mtimeMs: number;
  sizeBytes: number;
  summary: IndexedFileSummary;
}

const fileSummaryCache = new Map<string, CachedFileEntry>();
let snapshotCache: { rootDir: string; expiresAt: number; snapshot: RepoIndexSnapshot } | null = null;

export function invalidateRepoIndexCache(): void {
  snapshotCache = null;
}

export function resolveSafeWorkspacePath(relativePath: string): string {
  const env = getEnv();
  const baseDir = path.resolve(env.CODIZ_WORKSPACE_ROOT);
  const cleaned = relativePath.replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, cleaned);

  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new Error('Access denied: path escapes workspace sandbox boundary.');
  }
  return resolved;
}

function extractSymbolsAndImports(content: string, lang: string): {
  symbols: string[];
  imports: string[];
} {
  const symbols: string[] = [];
  const imports: string[] = [];

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (lang.startsWith('typescript') || lang.startsWith('javascript')) {
      const exportMatch = trimmed.match(
        /^export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z0-9_]+)/
      );
      if (exportMatch) symbols.push(exportMatch[1]);
      const impMatch = trimmed.match(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
      if (impMatch) imports.push(impMatch[1]);
    } else if (lang === 'python') {
      const pyMatch = trimmed.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z0-9_]+)/);
      if (pyMatch) symbols.push(pyMatch[1]);
      const pyImp = trimmed.match(/^(?:from|import)\s+([A-Za-z0-9_.]+)/);
      if (pyImp) imports.push(pyImp[1]);
    } else if (lang === 'dart') {
      const dartMatch = trimmed.match(/^(?:class|abstract\s+class|mixin|enum)\s+([A-Za-z0-9_]+)/);
      if (dartMatch) symbols.push(dartMatch[1]);
    }
  }

  return {
    symbols: Array.from(new Set(symbols)).slice(0, 25),
    imports: Array.from(new Set(imports)).slice(0, 25),
  };
}

export function indexWorkspaceRepository(forceRefresh = false): RepoIndexSnapshot {
  const env = getEnv();
  const rootDir = path.resolve(env.CODIZ_WORKSPACE_ROOT);

  if (
    !forceRefresh &&
    snapshotCache &&
    snapshotCache.rootDir === rootDir &&
    Date.now() < snapshotCache.expiresAt
  ) {
    return snapshotCache.snapshot;
  }

  const files: IndexedFileSummary[] = [];
  const languages: Record<string, number> = {};
  let totalLines = 0;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const lang = TEXT_EXT_TO_LANG[ext];
      if (!lang) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > 512 * 1024) continue; // Skip huge generated bundles

      const cached = fileSummaryCache.get(fullPath);
      let summary: IndexedFileSummary;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.size) {
        summary = cached.summary;
      } else {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lineCount = content.split('\n').length;
        const { symbols, imports } = extractSymbolsAndImports(content, lang);
        summary = {
          relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
          language: lang,
          sizeBytes: stat.size,
          lineCount,
          symbols,
          imports,
        };
        fileSummaryCache.set(fullPath, {
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          summary,
        });
      }

      totalLines += summary.lineCount;
      languages[lang] = (languages[lang] ?? 0) + 1;
      files.push(summary);
    }
  };

  walk(rootDir);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const snapshot: RepoIndexSnapshot = {
    rootName: path.basename(rootDir),
    indexedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalLines,
    languages,
    files,
  };
  snapshotCache = {
    rootDir,
    expiresAt: Date.now() + 4000,
    snapshot,
  };
  return snapshot;
}

export function selectCompressedContext(params: {
  query: string;
  explicitFiles?: string[];
  maxTokenBudget?: number;
}): {
  selectedFiles: Array<{ path: string; score: number; excerpt: string }>;
  estimatedTokens: number;
  totalRepoFiles: number;
  compressionRatio: number;
} {
  const snapshot = indexWorkspaceRepository();
  const budgetTokens = params.maxTokenBudget ?? 2400;
  const charBudget = budgetTokens * 4;

  const terms = params.query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);

  const explicitSet = new Set(params.explicitFiles ?? []);

  const scored = snapshot.files.map((f) => {
    let score = explicitSet.has(f.relativePath) ? 100 : 0;
    const pathLower = f.relativePath.toLowerCase();
    const symLower = f.symbols.join(' ').toLowerCase();
    for (const term of terms) {
      if (pathLower.includes(term)) score += 12;
      if (symLower.includes(term)) score += 15;
    }
    return { file: f, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topCandidates = scored.filter((s) => s.score > 0).slice(0, 8);
  if (topCandidates.length === 0) {
    topCandidates.push(...scored.slice(0, 4));
  }

  let usedChars = 0;
  const selectedFiles: Array<{ path: string; score: number; excerpt: string }> = [];

  for (const item of topCandidates) {
    if (usedChars >= charBudget) break;
    const full = resolveSafeWorkspacePath(item.file.relativePath);
    const raw = fs.readFileSync(full, 'utf8');
    const remaining = charBudget - usedChars;
    const excerpt =
      raw.length <= remaining
        ? raw
        : `${raw.slice(0, remaining)}\n... [Codiz Context Compressor: truncated ${raw.length - remaining} chars to fit 4B token budget]`;

    usedChars += excerpt.length;
    selectedFiles.push({
      path: item.file.relativePath,
      score: item.score,
      excerpt,
    });
  }

  const totalRepoChars = Math.max(snapshot.totalLines * 36, 1);
  return {
    selectedFiles,
    estimatedTokens: Math.ceil(usedChars / 4),
    totalRepoFiles: snapshot.totalFiles,
    compressionRatio: Number((usedChars / totalRepoChars).toFixed(3)),
  };
}
