/* knomad daily read — today's Wiktionary word and a Wikipedia article.
 *
 * Both sources are keyless and allow browser requests:
 *   - Wiktionary's Word of the Day is a dated page whose wikitext uses {{WOTD}}.
 *   - Wikipedia's featured feed returns the day's featured article plus the
 *     most-read articles, images, and links.
 *
 * The article pick is deterministic: score the day's candidates against the
 * resume keywords passed in, prefer the featured article on ties, and fall
 * back to it when nothing overlaps. No model, no API key.
 */

const WIKIPEDIA_FEED = 'https://api.wikimedia.org/feed/v1/wikipedia/en/featured';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKTIONARY_API = 'https://en.wiktionary.org/w/api.php';
const CACHE_MS = 6 * 60 * 60 * 1000;
const PORTAL_CACHE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Portals offered in Settings. `selected` sources are curated portal lists;
 * `recognized` sources are WikiProject featured/good article lists. Both are
 * wikitext pages, not rendered portal pages, so the candidate set is stable.
 */
export const DAILY_PORTALS = [
  {
    id: 'computer-programming',
    label: 'Computer science & programming',
    sourcePage: 'Portal:Computer programming/Selected articles',
    sourceKind: 'selected',
    url: 'https://en.wikipedia.org/wiki/Portal:Computer_programming',
    terms: [
      'software', 'software engineer', 'software developer', 'developer', 'programmer',
      'programming', 'computer science', 'frontend', 'front-end', 'backend', 'back-end',
      'full stack', 'full-stack', 'devops', 'sre', 'web developer', 'web development',
      'mobile developer', 'javascript', 'typescript', 'python', 'java', 'c++', 'c#',
      'rust', 'react', 'node.js', 'kubernetes', 'docker', 'sql', 'database',
      'machine learning', 'data engineer'
    ]
  },
  {
    id: 'mathematics',
    label: 'Mathematics',
    sourcePage: 'Wikipedia:WikiProject Mathematics/Recognized content',
    sourceKind: 'recognized',
    url: 'https://en.wikipedia.org/wiki/Portal:Mathematics',
    terms: [
      'mathematician', 'mathematics', 'statistician', 'statistics', 'data scientist',
      'data science', 'actuary', 'actuarial', 'quantitative', 'operations research',
      'econometrics'
    ]
  },
  {
    id: 'physics',
    label: 'Physics',
    sourcePage: 'Wikipedia:WikiProject Physics/Recognized content',
    sourceKind: 'recognized',
    url: 'https://en.wikipedia.org/wiki/Portal:Physics',
    terms: [
      'physicist', 'physics', 'astronomy', 'astronomer', 'astrophysics',
      'quantum mechanics', 'particle physics'
    ]
  },
  {
    id: 'medicine',
    label: 'Medicine',
    sourcePage: 'Wikipedia:WikiProject Medicine/Recognized content',
    sourceKind: 'recognized',
    url: 'https://en.wikipedia.org/wiki/Portal:Medicine',
    terms: [
      'physician', 'doctor', 'medicine', 'medical', 'nurse', 'nursing', 'clinical',
      'healthcare', 'health care', 'public health', 'pharmacist', 'pharmacy',
      'surgeon', 'therapist', 'dentist'
    ]
  },
  {
    id: 'literature',
    label: 'Literature',
    sourcePage: 'Wikipedia:WikiProject Literature/Recognized content',
    sourceKind: 'recognized',
    url: 'https://en.wikipedia.org/wiki/Portal:Literature',
    terms: [
      'writer', 'author', 'editor', 'journalist', 'literature', 'publishing',
      'copywriter', 'novelist', 'poet', 'english professor'
    ]
  }
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const POS_LABELS = {
  noun: 'Noun',
  verb: 'Verb',
  adj: 'Adjective',
  adv: 'Adverb',
  phrase: 'Phrase',
  prop: 'Proper noun',
  pref: 'Prefix',
  suff: 'Suffix'
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function pad(value) {
  return String(value).padStart(2, '0');
}

function dayKey(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function formatDateLabel(date) {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function plainText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatcher(keyword) {
  const text = String(keyword || '').trim();
  if (!text) return null;
  return new RegExp('(^|[^a-z0-9])' + escapeRegExp(text) + '([^a-z0-9]|$)', 'i');
}

function matchKeywords(text, keywords) {
  const haystack = String(text || '');
  const seen = new Set();
  return (Array.isArray(keywords) ? keywords : []).filter((keyword) => {
    const matcher = keywordMatcher(keyword);
    if (!matcher || !matcher.test(haystack)) return false;
    const key = String(keyword).trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitTemplateParams(value) {
  const parts = [];
  let current = '';
  let templateDepth = 0;
  let linkDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (char === '{' && next === '{') {
      templateDepth += 1;
      current += '{{';
      index += 1;
      continue;
    }
    if (char === '}' && next === '}') {
      templateDepth = Math.max(0, templateDepth - 1);
      current += '}}';
      index += 1;
      continue;
    }
    if (char === '[' && next === '[') {
      linkDepth += 1;
      current += '[[';
      index += 1;
      continue;
    }
    if (char === ']' && next === ']') {
      linkDepth = Math.max(0, linkDepth - 1);
      current += ']]';
      index += 1;
      continue;
    }
    if (char === '|' && templateDepth === 0 && linkDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Wiktionary word of the day
// ---------------------------------------------------------------------------

function findWotdTemplate(wikitext) {
  const text = String(wikitext || '');
  const start = text.indexOf('{{WOTD|');
  if (start === -1) return '';

  let depth = 0;
  for (let index = start; index < text.length - 1; index += 1) {
    if (text[index] === '{' && text[index + 1] === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (text[index] === '}' && text[index + 1] === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) return text.slice(start + 2, index - 1);
    }
  }

  return '';
}

function wikiInline(value) {
  let text = String(value || '');

  // {{lb|en|uncountable|figurative}} -> (uncountable, figurative)
  text = text.replace(/\{\{lb\|en\|([^{}]*)\}\}/gi, (_, labels) => {
    const clean = labels.split('|').map((label) => label.trim()).filter(Boolean).join(', ');
    return clean ? '(' + clean + ')' : '';
  });

  // {{l|en|word|display}} and {{m|en|word|display}} -> display or word.
  text = text.replace(/\{\{(?:l|m|link|mention)\|en\|([^{}|]+)(?:\|([^{}]*))?\}\}/gi, (_, word, display) => {
    return display || word;
  });

  // Usage notes and glosses carry meaning; keep their text.
  text = text.replace(/\{\{(?:non-gloss|n-g|ng|gloss)\|([^{}]*)\}\}/gi, '$1');
  text = text.replace(/\{\{(?:q|qual|qualifier|sense)\b([^{}]*)\}\}/gi, (_, note) => {
    const clean = note.split('|').map((part) => part.trim()).filter(Boolean).join(', ');
    return clean ? '(' + clean + ')' : '';
  });

  // Any remaining template is noise in a short card.
  text = text.replace(/\{\{[^{}]*\}\}/g, '');

  // [[page#Anchor|label]] -> label; [[page]] -> page.
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, target) => String(target).split('#')[0]);

  text = text.replace(/'''?/g, '');
  text = text.replace(/<[^>]*>/g, ' ');
  return plainText(text);
}

/** Parse the wikitext of a Wiktionary Word of the Day page.
 * Returns null when the page does not contain a {{WOTD}} template.
 */
export function parseWiktionaryPage(wikitext) {
  const template = findWotdTemplate(wikitext);
  if (!template) return null;

  const params = splitTemplateParams(template);
  if (!params.length || params[0].trim() !== 'WOTD') return null;

  // The template mixes positional values (word, part of speech, definition)
  // with named options (tl=, comment=, audio=). The definition is the next
  // positional value after the word and part of speech.
  const positional = [];
  const named = {};
  params.slice(1).forEach((param) => {
    const match = String(param).match(/^\s*([a-z_-]+)\s*=/i);
    if (match) {
      named[match[1].toLowerCase()] = String(param).slice(match[0].length).trim();
    } else {
      positional.push(param);
    }
  });

  const word = wikiInline(positional[0]);
  if (!word) return null;

  const posRaw = wikiInline(positional[1]);
  const firstPos = posRaw.split(/[,\s]+/)[0].toLowerCase();
  const partOfSpeech = POS_LABELS[firstPos] || posRaw;

  // The first paragraph holds the curated senses. Later paragraphs introduce
  // other parts of speech; a dashboard card does not need all of them.
  const rawDefinition = positional[2] || '';
  const firstBlock = rawDefinition.split(/\n\s*\n/)[0] || rawDefinition;
  const lines = firstBlock
    .split('\n')
    .map((line) => line.replace(/^#\s*/, '').trim())
    .filter(Boolean);
  let definition = lines.map(wikiInline).filter(Boolean).join(' ');
  if (!definition) definition = wikiInline(rawDefinition);

  const topic = named.tl ? wikiInline(named.tl) : '';
  if (topic && definition) definition = '(' + topic + ') ' + definition;

  const page = word.replace(/\s+/g, '_');
  return {
    word,
    partOfSpeech,
    topic,
    definition,
    url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(page) + '#English'
  };
}

// ---------------------------------------------------------------------------
// Wikipedia article normalization
// ---------------------------------------------------------------------------

function normalizeArticle(raw, kind) {
  if (!raw || !raw.title) return null;
  const title = plainText(
    (raw.titles && raw.titles.normalized) ||
    raw.normalizedtitle ||
    String(raw.title).replace(/\s+/g, ' ')
  );
  if (!title) return null;

  const titlePage = String(raw.title).replace(/\s+/g, '_');
  return {
    title,
    kind,
    rank: Number(raw.rank) || 0,
    description: plainText(raw.description || ''),
    extract: plainText(raw.extract || ''),
    thumbnail: raw.thumbnail && raw.thumbnail.source ? String(raw.thumbnail.source) : '',
    url: (raw.content_urls && raw.content_urls.desktop && raw.content_urls.desktop.page) ||
      'https://en.wikipedia.org/wiki/' + encodeURIComponent(titlePage)
  };
}

function scoreArticle(article, keywords) {
  if (!article) return { score: 0, matched: [] };
  const title = article.title;
  const body = [article.title, article.description, article.extract].join(' ');
  const matched = [];
  let score = 0;

  (Array.isArray(keywords) ? keywords : []).forEach((keyword) => {
    const matcher = keywordMatcher(keyword);
    if (!matcher) return;

    if (matcher.test(title)) {
      score += 3;
      matched.push(keyword);
      return;
    }
    if (matcher.test(body)) {
      // Short terms like "go" appear as ordinary words too often to be a
      // strong signal. Longer skills ("python", "kubernetes") earn more.
      score += String(keyword).trim().length >= 5 ? 2 : 1;
      matched.push(keyword);
    }
  });

  return { score, matched };
}

// ---------------------------------------------------------------------------
// Featured / most-read article pick (existing feed picker)
// ---------------------------------------------------------------------------

export function pickDailyArticle(feed, keywords = []) {
  if (!feed) return null;

  const candidates = [];
  const tfa = normalizeArticle(feed.tfa, 'featured');
  if (tfa) candidates.push(tfa);

  const mostread = feed.mostread && Array.isArray(feed.mostread.articles)
    ? feed.mostread.articles
    : [];
  mostread.slice(0, 8).forEach((raw) => {
    if (!raw || !raw.title) return;
    if (raw.namespace && raw.namespace.id !== 0) return;
    const title = String(raw.title);
    // Lists and daily death rolls are not useful reading recommendations.
    if (/^(list_of|deaths_in|main_page|special:)/i.test(title)) return;
    const article = normalizeArticle(raw, 'mostread');
    if (article) candidates.push(article);
  });

  const seen = new Set();
  const unique = candidates.filter((article) => {
    const key = article.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.forEach((article) => {
    const result = scoreArticle(article, keywords);
    article.score = result.score;
    article.matched = result.matched;
  });

  const relevant = unique.filter((article) => article.score >= 2);
  const pool = relevant.length ? relevant : unique;
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.kind !== b.kind) return a.kind === 'featured' ? -1 : 1;
    return a.rank - b.rank;
  });

  const chosen = pool[0] || null;
  if (!chosen) return null;

  return {
    ...chosen,
    sourceLabel: chosen.kind === 'featured' ? 'Featured article' : 'Most read today',
    pickedForResume: Boolean(chosen.kind === 'mostread' && chosen.matched.length)
  };
}

// ---------------------------------------------------------------------------
// Daily card builder
// ---------------------------------------------------------------------------

export function buildDailyRead({ wikipedia, wiktionary, keywords = [], date = new Date(), portalArticle = null }) {
  const word = parseWiktionaryPage(wiktionary);
  if (word) word.matched = matchKeywords(word.word + ' ' + word.definition, keywords);

  const article = portalArticle || pickDailyArticle(wikipedia, keywords);
  return {
    dateLabel: formatDateLabel(date),
    word,
    article,
    keywords: (Array.isArray(keywords) ? keywords : []).slice(0, 8)
  };
}

// ---------------------------------------------------------------------------
// Portal sources
// ---------------------------------------------------------------------------

function isArticleTitle(title) {
  if (!title || title.length > 120) return false;
  if (/^(file|image|category|portal|wikipedia|template|help|talk|user|draft|module|special|mediawiki):/i.test(title)) return false;
  if (/^list of /i.test(title)) return false;
  if (/^(deaths in|main page|special:)/i.test(title)) return false;
  return true;
}

function parseBulletTitle(line) {
  const match = String(line || '').match(/\[\[:?([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/);
  if (!match) return '';
  const title = plainText(decodeEntities(match[1]).replace(/_/g, ' ').trim());
  if (!title || !isArticleTitle(title)) return '';
  return title;
}

function iconQuality(line) {
  if (/\{\{icon\|FA\}\}/i.test(line)) return 3;
  if (/\{\{icon\|GA\}\}/i.test(line)) return 2;
  if (/\{\{icon\|Vital\}\}/i.test(line)) return 1;
  return 0;
}

function dedupeCandidates(rows) {
  const byTitle = new Map();
  rows.forEach((row) => {
    const key = row.title.toLowerCase();
    const previous = byTitle.get(key);
    if (!previous || row.quality > previous.quality) byTitle.set(key, row);
  });
  return [...byTitle.values()];
}

export function parseSelectedArticles(wikitext) {
  const rows = [];
  String(wikitext || '').split('\n').forEach((line) => {
    if (!/^\*/.test(line)) return;
    const title = parseBulletTitle(line);
    if (!title) return;
    rows.push({ title, quality: iconQuality(line) });
  });
  return dedupeCandidates(rows);
}

export function parseRecognizedContent(wikitext) {
  const rows = [];
  let section = '';
  String(wikitext || '').split('\n').forEach((line) => {
    const heading = line.match(/^={2,6}\s*(.*?)\s*={2,6}\s*$/);
    if (heading) {
      section = plainText(heading[1]).replace(/''/g, '').trim();
      return;
    }
    if (!/^(featured articles|good articles)$/i.test(section)) return;
    if (!/^\*/.test(line)) return;
    const title = parseBulletTitle(line);
    if (!title) return;
    rows.push({ title, quality: /^featured/i.test(section) ? 3 : 2 });
  });
  return dedupeCandidates(rows);
}

function hashText(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

export function pickPortalArticle(candidates, portal, date) {
  const rows = Array.isArray(candidates) ? candidates.filter((row) => row && row.title) : [];
  if (!rows.length) return null;
  const qualityRows = rows.filter((row) => row.quality > 0);
  const pool = (qualityRows.length >= 3 ? qualityRows : rows)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title));
  const index = hashText(dayKey(date) + ':' + (portal.id || 'portal')) % pool.length;
  return { ...pool[index], portal };
}

export function resolveDailyPortal(selection = 'auto', profile = {}, keywords = []) {
  if (selection === 'general') return null;
  const explicit = DAILY_PORTALS.find((portal) => portal.id === selection);
  if (explicit) return explicit;

  const text = [
    profile.headline,
    profile.summary,
    profile.resumeText,
    ...(Array.isArray(profile.skills) ? profile.skills : []),
    ...(Array.isArray(keywords) ? keywords : [])
  ].join(' ').toLowerCase();

  let best = null;
  DAILY_PORTALS.forEach((portal) => {
    const score = portal.terms.reduce((count, term) => {
      const matcher = keywordMatcher(term);
      return count + (matcher && matcher.test(text) ? 1 : 0);
    }, 0);
    if (score > 0 && (!best || score > best.score)) best = { portal, score };
  });
  return best ? best.portal : null;
}

async function loadPortalSource(portal, fetchImpl) {
  const key = 'portal:' + portal.id + ':' + dayKey(new Date());
  return cached(key, async () => {
    const data = await fetchJson(
      WIKIPEDIA_API + '?action=parse&page=' + encodeURIComponent(portal.sourcePage) +
        '&prop=wikitext&format=json&origin=*',
      fetchImpl
    );
    const wikitext = data && data.parse && data.parse.wikitext;
    const text = typeof wikitext === 'string' ? wikitext : wikitext && wikitext['*'];
    if (typeof text !== 'string') {
      throw new Error('Wikipedia portal did not return article text.');
    }
    return text;
  });
}

async function loadPortalSummary(title, fetchImpl) {
  const page = String(title || '').replace(/\s+/g, '_');
  if (!page) throw new Error('Portal article has no title.');
  return cached('summary:' + page, () => fetchJson(
    WIKIPEDIA_SUMMARY + encodeURIComponent(page),
    fetchImpl
  ));
}

function buildPortalArticle(raw, portal, chosen, keywords) {
  if (!raw) throw new Error('Portal returned no article summary.');
  const article = normalizeArticle(raw, 'portal');
  if (!article) throw new Error('Portal summary was empty.');
  const matched = matchKeywords([article.title, article.description, article.extract].join(' '), keywords);
  return {
    ...article,
    quality: chosen.quality || 0,
    matched,
    pickedForResume: false,
    portal: { id: portal.id, label: portal.label, url: portal.url },
    sourceLabel: 'Portal pick'
  };
}

async function loadPortalArticle(portal, date, keywords, fetchImpl) {
  const wikitext = await loadPortalSource(portal, fetchImpl);
  const candidates = portal.sourceKind === 'recognized'
    ? parseRecognizedContent(wikitext)
    : parseSelectedArticles(wikitext);
  const chosen = pickPortalArticle(candidates, portal, date);
  if (!chosen) throw new Error('No articles were found for this portal.');

  const summary = await loadPortalSummary(chosen.title, fetchImpl);
  return buildPortalArticle(summary, portal, chosen, keywords);
}

// ---------------------------------------------------------------------------
// Cached network helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, fetchImpl) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) throw new Error('Daily read request failed (' + response.status + ').');
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let sourceCache = new Map();

function cached(key, load) {
  const found = sourceCache.get(key);
  if (found && Date.now() - found.at < CACHE_MS) return found.promise;

  const entry = { at: Date.now(), promise: load() };
  sourceCache.set(key, entry);
  entry.promise.catch(() => {
    // Do not cache a failed request; a retry should reach the network again.
    if (sourceCache.get(key) === entry) sourceCache.delete(key);
  });
  return entry.promise;
}

export function clearDailyReadCache() {
  sourceCache = new Map();
}

async function loadWikipedia(date, fetchImpl) {
  const key = dayKey(date) + ':wikipedia';
  return cached(key, () => fetchJson(
    WIKIPEDIA_FEED + '/' + date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()),
    fetchImpl
  ));
}

async function loadWiktionary(date, fetchImpl) {
  const key = dayKey(date) + ':wiktionary';
  const page = 'Wiktionary:Word of the day/' + date.getFullYear() + '/' +
    MONTHS[date.getMonth()] + ' ' + date.getDate();
  const url = WIKTIONARY_API + '?action=parse&page=' + encodeURIComponent(page) +
    '&prop=wikitext&format=json&origin=*';

  return cached(key, async () => {
    const data = await fetchJson(url, fetchImpl);
    if (!data || !data.parse || !data.parse.wikitext || typeof data.parse.wikitext['*'] !== 'string') {
      throw new Error('Wiktionary did not return today’s entry.');
    }
    return data.parse.wikitext['*'];
  });
}

// ---------------------------------------------------------------------------
// Public: one fetch, both sources, portal-aware
// ---------------------------------------------------------------------------

export async function fetchDailyRead(options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('Network access is not available.');

  const date = options.date ? new Date(options.date) : new Date();
  const keywords = Array.isArray(options.keywords) ? options.keywords : [];
  const selection = options.portal || 'auto';
  const portal = resolveDailyPortal(selection, options.profile || {}, keywords);

  const tasks = [loadWikipedia.bind(null, date), loadWiktionary.bind(null, date)];
  if (portal) tasks.push(loadPortalArticle.bind(null, portal, date, keywords));
  const results = await Promise.allSettled(tasks.map((loader) => loader(fetchImpl)));

  const errors = {};
  if (results[0] && results[0].status === 'rejected') {
    errors.wikipedia = results[0].reason && results[0].reason.message
      ? results[0].reason.message
      : 'Wikipedia is unavailable.';
  }
  if (results[1] && results[1].status === 'rejected') {
    errors.wiktionary = results[1].reason && results[1].reason.message
      ? results[1].reason.message
      : 'Wiktionary is unavailable.';
  }
  if (results[2] && results[2].status === 'rejected') {
    errors.portal = results[2].reason && results[2].reason.message
      ? results[2].reason.message
      : 'Portal is unavailable.';
  }

  return {
    ...buildDailyRead({
      wikipedia: results[0] && results[0].status === 'fulfilled' ? results[0].value : null,
      wiktionary: results[1] && results[1].status === 'fulfilled' ? results[1].value : null,
      keywords,
      date,
      portalArticle: results[2] && results[2].status === 'fulfilled' ? results[2].value : null
    }),
    errors,
    portal
  };
}
