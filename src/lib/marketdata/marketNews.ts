/**
 * Free market news via Google News RSS + Yahoo Finance RSS (no API key).
 */

export type MarketNewsItem = {
  title: string;
  link: string;
  publishedAt: string | null;
  source: string;
};

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseRssItems(xml: string, fallbackSource: string): MarketNewsItem[] {
  const items: MarketNewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    const link =
      block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ??
      block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const pub =
      block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ??
      block.match(/<published>([\s\S]*?)<\/published>/i)?.[1];
    const src =
      block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] ?? fallbackSource;
    if (!title || !link) continue;
    items.push({
      title: decodeXml(title).trim(),
      link: decodeXml(link).trim(),
      publishedAt: pub ? decodeXml(pub).trim() : null,
      source: decodeXml(src).trim(),
    });
  }
  return items;
}

async function fetchRss(
  url: string,
  sourceLabel: string,
): Promise<MarketNewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseRssItems(text, sourceLabel);
  } catch {
    return [];
  }
}

export async function fetchMarketNews(limit = 12): Promise<{
  items: MarketNewsItem[];
  source: string;
  note: string | null;
}> {
  const [google, yahoo] = await Promise.all([
    fetchRss(
      "https://news.google.com/rss/search?q=Nifty%20OR%20RBI%20OR%20Sensex%20OR%20%22India%20markets%22%20when:1d&hl=en-IN&gl=IN&ceid=IN:en",
      "Google News",
    ),
    fetchRss(
      "https://finance.yahoo.com/rss/headline?s=%5ENSEI",
      "Yahoo Finance",
    ),
  ]);

  const seen = new Set<string>();
  const merged: MarketNewsItem[] = [];
  for (const item of [...google, ...yahoo]) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= limit) break;
  }

  return {
    items: merged,
    source: "Google News RSS + Yahoo Finance RSS",
    note: merged.length === 0 ? "News feed temporarily unavailable" : null,
  };
}
