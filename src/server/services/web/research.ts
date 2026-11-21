import { extractMarkdownAndCode, validateSafeExternalUrl } from '../retrieval/knowledge.ts';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebScrapeResult {
  url: string;
  title: string;
  excerpt: string;
  codeBlocks: string[];
  charCount: number;
  truncated: boolean;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveDuckDuckGoHref(rawHref: string): string {
  const cleaned = decodeHtmlEntities(rawHref);
  try {
    if (cleaned.startsWith('//')) {
      const u = new URL(`https:${cleaned}`);
      const target = u.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : u.toString();
    }
    if (cleaned.startsWith('/l/?')) {
      const u = new URL(`https://html.duckduckgo.com${cleaned}`);
      const target = u.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : cleaned;
    }
    return cleaned;
  } catch {
    return cleaned;
  }
}

export function parseDuckDuckGoHtml(html: string, limit = 5): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRegex =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null && results.length < limit) {
    const resolvedUrl = resolveDuckDuckGoHref(match[1]);
    const title = decodeHtmlEntities(match[2]);
    const snippet = decodeHtmlEntities(match[3] ?? match[4] ?? '');
    if (!title || !resolvedUrl) continue;
    try {
      const safe = validateSafeExternalUrl(resolvedUrl);
      results.push({ title, url: safe.toString(), snippet });
    } catch {
      // Skip unsafe or malformed redirect URLs
    }
  }
  return results;
}

export async function webSearch(query: string, limit = 5): Promise<{
  query: string;
  results: WebSearchResult[];
  note?: string;
}> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('Search query cannot be empty.');
  const maxResults = Math.min(Math.max(1, limit), 8);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodizCLI/1.0; +https://github.com/codiz)',
        Accept: 'text/html',
      },
    });
    if (!res.ok) {
      return {
        query: trimmed,
        results: [],
        note: `Web search HTTP ${res.status}`,
      };
    }
    const html = await res.text();
    const results = parseDuckDuckGoHtml(html, maxResults);
    return {
      query: trimmed,
      results,
      ...(results.length === 0 ? { note: 'No results parsed; try a more specific query or direct URL.' } : {}),
    };
  } catch (err) {
    return {
      query: trimmed,
      results: [],
      note: err instanceof Error ? err.message : 'Web search failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function webScrape(rawUrl: string, maxChars = 4200): Promise<WebScrapeResult> {
  const safeUrl = validateSafeExternalUrl(rawUrl);
  const cappedChars = Math.min(Math.max(500, maxChars), 12000);

  // Polite robots.txt check
  try {
    const rCtrl = new AbortController();
    const rt = setTimeout(() => rCtrl.abort(), 2500);
    const robotsRes = await fetch(`${safeUrl.origin}/robots.txt`, {
      signal: rCtrl.signal,
      headers: { 'User-Agent': 'CodizCLI/1.0' },
    });
    clearTimeout(rt);
    if (robotsRes.ok) {
      const robotsTxt = await robotsRes.text();
      if (/User-agent:\s*\*\s*[\r\n]+Disallow:\s*\/\s*$/im.test(robotsTxt)) {
        throw new Error(`Target ${safeUrl.origin} disallows automated scraping in robots.txt.`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('robots.txt')) throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(safeUrl.toString(), {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodizCLI/1.0)',
        Accept: 'text/html, text/markdown, text/plain, application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Fetch returned HTTP ${res.status} for ${safeUrl.toString()}`);
    }
    const contentType = res.headers.get('content-type') ?? 'text/plain';
    const rawBody = await res.text();

    const titleMatch = rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : `${safeUrl.hostname}${safeUrl.pathname}`;

    const { cleanText, codeBlocks } = extractMarkdownAndCode(rawBody, contentType);
    const truncated = cleanText.length > cappedChars;
    const excerpt = truncated ? `${cleanText.slice(0, cappedChars)}\n... [truncated]` : cleanText;

    return {
      url: safeUrl.toString(),
      title,
      excerpt,
      codeBlocks: codeBlocks.slice(0, 6).map((b) => b.slice(0, 1200)),
      charCount: cleanText.length,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}
