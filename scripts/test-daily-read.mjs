import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyRead,
  clearDailyReadCache,
  fetchDailyRead,
  parseWiktionaryPage,
  pickDailyArticle
} from '../daily-read.js';

const WIKITEXT_BUTTON = `{{WOTD|derailleur|n|tl=bicycle part|A [[mechanism]] on a [[bicycle#Noun|bicycle]] [[wheel#Noun|wheel]] [[use#Verb|used]] while [[cycle#Verb|cycling]] to [[move#Verb|move]] the [[bicycle chain]] from one [[sprocket]] ([[gear#Noun|gear]]) to another, to [[change#Verb|change]] [[speed#Noun|speeds]].\n# The [[entire#Adjective|entire]] [[gearset]] on a bicycle with such a mechanism.|comment=Today is [[w:World Bicycle Day|World Bicycle Day]].|audio=example.wav|June|3}}`;

const WIKIPEDIA_FEED = {
  tfa: {
    title: 'Ice_Warrior',
    titles: { normalized: 'Ice Warrior' },
    extract: 'The Ice Warriors are a fictional extraterrestrial race in Doctor Who.',
    thumbnail: { source: 'https://upload.wikimedia.org/example.jpg' },
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ice_Warrior' } }
  },
  mostread: {
    articles: [
      {
        title: 'Riemann_hypothesis',
        namespace: { id: 0 },
        rank: 5,
        titles: { normalized: 'Riemann hypothesis' },
        extract: 'In mathematics, the Riemann hypothesis concerns the distribution of prime numbers.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Riemann_hypothesis' } }
      },
      {
        title: 'Grand_Theft_Auto_VI',
        namespace: { id: 0 },
        rank: 2,
        titles: { normalized: 'Grand Theft Auto VI' },
        extract: 'Grand Theft Auto VI is an action-adventure game.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Grand_Theft_Auto_VI' } }
      }
    ]
  }
};

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}

test('parses Wiktionary WOTD templates with labels and named options', () => {
  const word = parseWiktionaryPage(WIKITEXT_BUTTON);
  assert.equal(word.word, 'derailleur');
  assert.equal(word.partOfSpeech, 'n');
  assert.equal(word.topic, 'bicycle part');
  assert.match(word.definition, /^\(?bicycle part\)? A mechanism on a bicycle wheel/);
  assert.match(word.definition, /entire gearset/);
  assert.doesNotMatch(word.definition, /comment=|audio=|\[\[/);
  assert.equal(word.url, 'https://en.wiktionary.org/wiki/derailleur#English');
});

test('returns null for a page without a WOTD template', () => {
  assert.equal(parseWiktionaryPage('Just a plain page with no template.'), null);
});

test('uses the featured article when the resume has no overlap', () => {
  const article = pickDailyArticle(WIKIPEDIA_FEED, []);
  assert.equal(article.title, 'Ice Warrior');
  assert.equal(article.kind, 'featured');
  assert.equal(article.pickedForResume, false);
});

test('prefers a matching most-read article and reports the match', () => {
  const article = pickDailyArticle(WIKIPEDIA_FEED, ['mathematics', 'communication']);
  assert.equal(article.title, 'Riemann hypothesis');
  assert.equal(article.kind, 'mostread');
  assert.equal(article.pickedForResume, true);
  assert.deepEqual(article.matched, ['mathematics']);
});

test('a title match outranks an extract-only match', () => {
  const feed = {
    tfa: {
      ...WIKIPEDIA_FEED.tfa,
      extract: 'This article mentions Grand Theft Auto VI in passing.'
    },
    mostread: WIKIPEDIA_FEED.mostread
  };
  const article = pickDailyArticle(feed, ['Grand Theft Auto VI']);
  assert.equal(article.title, 'Grand Theft Auto VI');
  assert.equal(article.score, 3);
});

test('builds the card with word and article ties to the resume', () => {
  const data = buildDailyRead({
    wikipedia: WIKIPEDIA_FEED,
    wiktionary: WIKITEXT_BUTTON,
    keywords: ['bicycle', 'mathematics'],
    date: new Date(2026, 5, 3)
  });
  assert.equal(data.dateLabel, 'June 3, 2026');
  assert.equal(data.word.word, 'derailleur');
  assert.deepEqual(data.word.matched, ['bicycle']);
  assert.equal(data.article.title, 'Riemann hypothesis');
  assert.deepEqual(data.article.matched, ['mathematics']);
});

test('fetches both sources and tolerates one failure', async () => {
  clearDailyReadCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('wiktionary.org')) return jsonResponse({ parse: { wikitext: { '*': WIKITEXT_BUTTON } } });
    if (url.includes('featured')) return jsonResponse(WIKIPEDIA_FEED);
    throw new Error('unexpected URL ' + url);
  };

  const data = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 5, 3),
    keywords: ['bicycle'],
    portal: null
  });

  assert.equal(data.word.word, 'derailleur');
  assert.equal(data.article.title, 'Ice Warrior');
  assert.equal(data.errors.wikipedia, undefined);
  assert.equal(data.errors.wiktionary, undefined);
  assert.ok(urls.some((url) => url.includes('origin=*')));
  assert.ok(urls.some((url) => url.includes('/2026/06/03')));
});

test('keeps the word when the Wikipedia feed fails', async () => {
  clearDailyReadCache();
  const fetchImpl = async (url) => {
    if (url.includes('wiktionary.org')) return jsonResponse({ parse: { wikitext: { '*': WIKITEXT_BUTTON } } });
    throw new Error('Wikipedia is down.');
  };

  const data = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 5, 3),
    keywords: ['bicycle'],
    portal: null
  });

  assert.equal(data.word.word, 'derailleur');
  assert.equal(data.article, null);
  assert.equal(data.errors.wikipedia, 'Wikipedia is down.');
});

test('fetches the article when Wiktionary is missing', async () => {
  clearDailyReadCache();
  const fetchImpl = async (url) => {
    if (url.includes('wiktionary.org')) return jsonResponse({ parse: {} });
    if (url.includes('featured')) return jsonResponse(WIKIPEDIA_FEED);
    throw new Error('unexpected URL ' + url);
  };

  const data = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 10, 23),
    keywords: []
  });

  assert.equal(data.word, null);
  assert.equal(data.article.title, 'Ice Warrior');
  assert.match(data.errors.wiktionary, /did not return/);
});

test('chooses a portal article deterministically for the day', async () => {
  clearDailyReadCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('wiktionary.org')) return jsonResponse({ parse: { wikitext: { '*': WIKITEXT_BUTTON } } });
    if (url.includes('featured')) return jsonResponse(WIKIPEDIA_FEED);
    if (url.includes('Portal%3AComputer%20programming%2FSelected')) {
      const wikitext = `* [[Ada (programming language)]] {{icon|FA}}\n* [[Riemann hypothesis]] {{icon|GA}}\n* [[Bletchley Park]] {{icon|Vital}}`;
      // The live API wraps text as parse.wikitext['*'].
      return jsonResponse({ parse: { wikitext: { '*': wikitext } } });
    }
    if (url.includes('/summary/')) {
      const title = decodeURIComponent(url.split('/summary/')[1]).replace(/_/g, ' ');
      return jsonResponse({ title, extract: 'A summary of ' + title + '.' });
    }
    throw new Error('unexpected URL ' + url);
  };

  const data = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 5, 3),
    keywords: ['ada', 'programming'],
    portal: 'computer-programming'
  });

  assert.equal(data.word.word, 'derailleur');
  assert.equal(data.portal.id, 'computer-programming');
  assert.equal(data.article.portal.label, 'Computer science & programming');
  assert.ok(['Ada (programming language)', 'Bletchley Park', 'Riemann hypothesis'].includes(data.article.title));
  assert.ok(urls.some((u) => u.includes('Portal%3AComputer%20programming%2FSelected')));
  assert.ok(urls.some((u) => u.includes('/summary/')));
  assert.equal(data.errors.portal, undefined);

  // The pick is seeded by the day, so a second call resolves the same article.
  const again = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 5, 3),
    keywords: ['ada', 'programming'],
    portal: 'computer-programming'
  });
  assert.equal(again.article.title, data.article.title);
});

test('falls back to the general feed when the auto portal cannot be resolved', async () => {
  clearDailyReadCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('wiktionary.org')) return jsonResponse({ parse: { wikitext: { '*': WIKITEXT_BUTTON } } });
    if (url.includes('featured')) return jsonResponse(WIKIPEDIA_FEED);
    throw new Error('unexpected URL ' + url);
  };

  const data = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 5, 1),
    profile: { headline: 'Warehouse associate', summary: 'Stocking shelves and loading vans' },
    portal: 'auto'
  });

  assert.equal(data.portal, null);
  assert.equal(data.article.title, 'Ice Warrior');
  assert.equal(data.errors.portal, undefined);
  assert.ok(!urls.some((u) => u.includes('%2FRecognized%20content')));
});

test('resolves developer profiles to computer programming', async () => {
  clearDailyReadCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('wiktionary.org')) return jsonResponse({ parse: { wikitext: { '*': WIKITEXT_BUTTON } } });
    if (url.includes('featured')) return jsonResponse(WIKIPEDIA_FEED);
    if (url.includes('Portal%3AComputer%20programming%2FSelected')) {
      const wikitext = `* [[Python (programming language)]] {{icon|FA}}\n* [[Kubernetes]] {{icon|GA}}`;
      return jsonResponse({ parse: { wikitext: { '*': wikitext } } });
    }
    if (url.includes('/summary/')) {
      const title = decodeURIComponent(url.split('/summary/')[1]).replace(/_/g, ' ');
      return jsonResponse({ title, extract: 'A summary of ' + title + '.' });
    }
    throw new Error('unexpected URL ' + url);
  };

  const data = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 5, 1),
    profile: { headline: 'Software engineer', skills: ['Python', 'Kubernetes'] },
    portal: 'auto'
  });

  assert.equal(data.portal.id, 'computer-programming');
  assert.ok(['Kubernetes', 'Python (programming language)'].includes(data.article.title));
  assert.equal(data.errors.portal, undefined);
});

test('uses the explicit general feed option', async () => {
  clearDailyReadCache();
  const fetchImpl = async (url) => {
    if (url.includes('wiktionary.org')) return jsonResponse({ parse: { wikitext: { '*': WIKITEXT_BUTTON } } });
    if (url.includes('featured')) return jsonResponse(WIKIPEDIA_FEED);
    throw new Error('unexpected URL ' + url);
  };

  const data = await fetchDailyRead({
    fetchImpl,
    date: new Date(2026, 5, 1),
    portal: 'general'
  });

  assert.equal(data.article.title, 'Ice Warrior');
  assert.equal(data.errors.portal, undefined);
});
