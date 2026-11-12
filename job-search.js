/* knomad job search — public job APIs + deterministic filtering.
 *
 * There is no model in this file. Listings come from three public, key-less
 * job APIs. The role query is matched against titles/tags with token rules,
 * and "open to Nigerians" is decided by parsing the location string each
 * provider already publishes (e.g. "Worldwide", "Africa", "USA only").
 */

export const DEFAULT_TARGET = 'Nigeria';

const COUNTRY_ALIASES = {
  nigeria: ['nigeria', 'naija'],
  kenya: ['kenya'],
  ghana: ['ghana'],
  'south africa': ['south africa'],
  egypt: ['egypt'],
  morocco: ['morocco'],
  rwanda: ['rwanda'],
  ethiopia: ['ethiopia'],
  tanzania: ['tanzania'],
  uganda: ['uganda'],
  cameroon: ['cameroon'],
  'ivory coast': ['ivory coast', "cote d'ivoire"],
  senegal: ['senegal'],
  algeria: ['algeria'],
  tunisia: ['tunisia'],
  zambia: ['zambia'],
  zimbabwe: ['zimbabwe']
};

const COUNTRY_LABELS = {
  nigeria: 'Nigeria',
  kenya: 'Kenya',
  ghana: 'Ghana',
  'south africa': 'South Africa',
  egypt: 'Egypt',
  morocco: 'Morocco',
  rwanda: 'Rwanda',
  ethiopia: 'Ethiopia',
  tanzania: 'Tanzania',
  uganda: 'Uganda',
  cameroon: 'Cameroon',
  'ivory coast': "Côte d'Ivoire",
  senegal: 'Senegal',
  algeria: 'Algeria',
  tunisia: 'Tunisia',
  zambia: 'Zambia',
  zimbabwe: 'Zimbabwe'
};

const AFRICA_COUNTRIES = new Set(Object.keys(COUNTRY_ALIASES));

const CITY_TO_COUNTRY = {
  lagos: 'nigeria',
  abuja: 'nigeria',
  'port harcourt': 'nigeria',
  ibadan: 'nigeria',
  kano: 'nigeria',
  enugu: 'nigeria',
  nairobi: 'kenya',
  accra: 'ghana',
  'cape town': 'south africa',
  johannesburg: 'south africa',
  cairo: 'egypt',
  kampala: 'uganda',
  kigali: 'rwanda',
  'dar es salaam': 'tanzania'
};

const WORLDWIDE_PATTERN =
  /\b(worldwide|anywhere(?:\s+in\s+the\s+world)?|any\s+location|all\s+locations|globally|global|location[-\s]independent|work\s+from\s+anywhere)\b/;
const AFRICA_PATTERN = /\bafrica\b/;
const EMEA_PATTERN =
  /\bemea\b|europe[,\s]+middle\s+east[,\s]+(?:and\s+)?africa|middle\s+east[,\s]+(?:and\s+)?africa/;
const BARE_REMOTE_PATTERN =
  /^(remote(?:\s*(?:only|work|job|position|role|first))?|100%\s*remote|fully\s*remote|work\s*from\s*home|wfh|anywhere)$/;

const ELIGIBILITY_RANK = {
  worldwide: 0,
  country: 1,
  region: 2,
  maybe: 3,
  unknown: 4,
  restricted: 5
};

// Words that describe the arrangement, not the role.
const ROLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'at', 'to', 'with',
  'job', 'jobs', 'role', 'roles', 'position', 'positions', 'opening', 'openings',
  'vacancy', 'vacancies', 'remote', 'work', 'from', 'home', 'hiring', 'hire',
  'wanted', 'needed', 'urgent', 'full-time', 'fulltime', 'part-time', 'parttime',
  'contract', 'freelance', 'company', 'companies', 'opportunity', 'opportunities'
]);

// Seniority words are dropped from a multi-word query so "senior nurse"
// still matches a plain "Registered Nurse" title.
const SENIORITY_WORDS = new Set([
  'senior', 'junior', 'lead', 'principal', 'staff', 'head', 'chief', 'entry',
  'mid', 'level', 'associate', 'trainee', 'intern', 'internship', 'experienced',
  'registered', 'certified', 'licensed', 'sr', 'jr', 'i', 'ii', 'iii'
]);

const SYNONYM_GROUPS = [
  ['developer', 'engineer', 'programmer', 'dev'],
  ['frontend', 'front-end', 'front end'],
  ['backend', 'back-end', 'back end'],
  ['fullstack', 'full-stack', 'full stack'],
  ['devops', 'dev ops', 'site reliability', 'sre'],
  ['qa', 'quality assurance', 'tester', 'testing'],
  ['uiux', 'ui ux', 'ui/ux', 'product design', 'product designer'],
  ['designer', 'design'],
  ['analyst', 'analytics', 'analysis'],
  ['manager', 'management'],
  ['support', 'customer service', 'customer success', 'help desk'],
  ['writer', 'copywriter', 'content writer', 'editorial'],
  ['accountant', 'accounting', 'finance'],
  ['nurse', 'nursing', 'registered nurse', 'rn'],
  ['sales', 'business development', 'account executive'],
  ['marketing', 'growth', 'seo'],
  ['data scientist', 'machine learning', 'ml', 'ai'],
  ['admin', 'administrative', 'virtual assistant', 'executive assistant'],
  ['teacher', 'tutor', 'education', 'instructor'],
  ['driver', 'driving', 'logistics'],
  ['security', 'cybersecurity', 'infosec']
];

const PLACE_TERMS = [
  'worldwide', 'anywhere', 'global', 'africa', 'nigeria', 'emea', 'europe', 'eu',
  'eea', 'usa', 'u.s.', 'u.s', 'united states', 'america', 'canada', 'uk',
  'united kingdom', 'ireland', 'germany', 'france', 'spain', 'portugal',
  'netherlands', 'poland', 'sweden', 'switzerland', 'latam', 'latin america',
  'south america', 'brazil', 'argentina', 'mexico', 'colombia', 'chile', 'apac',
  'asia', 'india', 'philippines', 'singapore', 'japan', 'korea', 'australia',
  'new zealand', 'middle east', 'mena', 'uae', 'saudi', 'israel', 'turkey',
  'pakistan', 'bangladesh', 'indonesia', 'vietnam', 'malaysia', 'south africa',
  'kenya', 'ghana', 'egypt', 'time zone', 'time zones', 'timezone', 'timezones',
  'business hours', 'overlap', 'est', 'edt', 'pst', 'pdt', 'cst', 'cdt', 'mst',
  'mdt', 'cet', 'cest', 'gmt', 'utc', 'bst'
];

const DESCRIPTION_HINT_PATTERNS = [
  /\bremote\s*(?:\(|:|-|–|—)\s*([^.\n]{3,110})/i,
  /\b(?:open|available|eligible)\s+(?:to|for)\s+([^.\n]{3,110})/i,
  /\b(?:location|locations|eligibility|work authorization|right to work)\s*[:\-]\s*([^.\n]{3,110})/i,
  /\b(?:candidates?|applicants?)\s+(?:from|in)\s+([^.\n]{3,110})/i,
  /\b(?:must|need to|required to|only)\b[^.\n]{0,80}\b(?:located|based|reside|residing|live|authorized|authorised|eligible|work)\b[^.\n]{0,80}/i
];

const RESPONSE_CACHE = new Map();
const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 14_000;

// Test hook: provider payloads are cached for ten minutes in production.
export function clearJobSearchCache() {
  RESPONSE_CACHE.clear();
}

// ---------------------------------------------------------------- helpers

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[–—]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return normalizeText(value).replace(/[^a-z0-9+#]/g, '');
}

function containsWord(haystack, word) {
  return new RegExp('(^|[^a-z])' + escapeRegExp(word) + '([^a-z]|$)').test(haystack);
}

function cleanLabel(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > 72 ? text.slice(0, 69) + '…' : text;
}

function eligibleResult(eligibility, label) {
  return { eligibility, label, eligible: true, maybe: false };
}

function ineligibleResult(eligibility, label, maybe = false) {
  return { eligibility, label, eligible: false, maybe };
}

// ---------------------------------------------------------------- target + eligibility

export function resolveTarget(target = DEFAULT_TARGET) {
  const text = normalizeText(target) || normalizeText(DEFAULT_TARGET);

  const city = Object.keys(CITY_TO_COUNTRY)
    .filter((name) => containsWord(text, name))
    .sort((a, b) => b.length - a.length)[0];
  if (city) {
    const country = CITY_TO_COUNTRY[city];
    return { country, label: COUNTRY_LABELS[country], africa: true };
  }

  const match = Object.keys(COUNTRY_ALIASES).find((country) =>
    COUNTRY_ALIASES[country].some((alias) => containsWord(text, alias))
  );
  if (match) {
    return { country: match, label: COUNTRY_LABELS[match], africa: AFRICA_COUNTRIES.has(match) };
  }

  return { country: text, label: String(target || DEFAULT_TARGET).trim(), africa: false };
}

function mentionsTarget(text, targetInfo) {
  const aliases = COUNTRY_ALIASES[targetInfo.country] || [targetInfo.country];
  return aliases.some((alias) => containsWord(text, alias));
}

/**
 * Decide whether a posting's stated location is open to the target country.
 * Returns { eligibility, label, eligible, maybe }.
 */
export function classifyEligibility(rawLocation, target = DEFAULT_TARGET) {
  const targetInfo = resolveTarget(target);
  const location = Array.isArray(rawLocation) ? rawLocation.join(', ') : rawLocation;
  const text = normalizeText(location);

  if (!text) return ineligibleResult('unknown', 'Location not stated');

  if (mentionsTarget(text, targetInfo)) {
    return eligibleResult('country', targetInfo.label);
  }

  if (WORLDWIDE_PATTERN.test(text)) {
    return eligibleResult('worldwide', 'Worldwide');
  }

  // "South Africa" is a country; every other mention of Africa is a region
  // that includes Nigeria.
  const withoutSouthAfrica = text.replace(/\bsouth\s+africa\b/g, ' ');
  if (AFRICA_PATTERN.test(withoutSouthAfrica)) {
    return eligibleResult('region', 'Africa');
  }

  if (EMEA_PATTERN.test(text)) {
    return ineligibleResult('maybe', cleanLabel(location) || 'EMEA', true);
  }

  if (BARE_REMOTE_PATTERN.test(text)) {
    return ineligibleResult('unknown', 'Remote — region not stated');
  }

  return ineligibleResult('restricted', cleanLabel(location));
}

/**
 * Pull an explicit remote/location restriction out of a posting body. Used
 * only for boards that sometimes leave the location field blank.
 */
export function descriptionLocationHint(description) {
  const text = String(description || '')
    .replace(/\r/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .slice(0, 2200);

  for (const pattern of DESCRIPTION_HINT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const snippet = String(match[0] || '').replace(/\s+/g, ' ').trim();
    if (snippet.length < 3) continue;
    const lower = normalizeText(snippet);
    if (!PLACE_TERMS.some((term) => containsWord(lower, term))) continue;
    return snippet.slice(0, 110);
  }

  return '';
}

// ---------------------------------------------------------------- role matching

export function roleTokens(query) {
  const all = normalizeText(query)
    .split(/[^a-z0-9+#]+/)
    .filter((token) => token.length > 1 && !ROLE_STOPWORDS.has(token));
  const core = all.filter((token) => !SENIORITY_WORDS.has(token));
  return core.length ? core : all;
}

function tokenAlternatives(token) {
  const key = compact(token);
  const group = SYNONYM_GROUPS.find((words) => words.some((word) => compact(word) === key));
  return group ? group.map(compact) : [key];
}

export function roleMatchScore(job, tokens) {
  if (!tokens || !tokens.length) return 0;
  const haystack = compact([
    job.title,
    job.category,
    job.level,
    ...(Array.isArray(job.tags) ? job.tags : [])
  ].join(' '));

  let hits = 0;
  tokens.forEach((token) => {
    if (tokenAlternatives(token).some((alternative) => alternative && haystack.includes(alternative))) {
      hits += 1;
    }
  });
  return hits / tokens.length;
}

export function roleMatchThreshold(tokens) {
  return tokens.length <= 2 ? 0.6 : 0.5;
}

export function matchJobs(jobs, query) {
  const tokens = roleTokens(query);
  if (!tokens.length) return jobs.map((job) => ({ ...job, matchScore: 0 }));

  const threshold = roleMatchThreshold(tokens);
  return jobs
    .map((job) => ({ ...job, matchScore: roleMatchScore(job, tokens) }))
    .filter((job) => job.matchScore >= threshold);
}

export function sortJobs(jobs) {
  return jobs.slice().sort((a, b) => {
    const rankA = ELIGIBILITY_RANK[a.eligibility && a.eligibility.eligibility] ?? 6;
    const rankB = ELIGIBILITY_RANK[b.eligibility && b.eligibility.eligibility] ?? 6;
    if (rankA !== rankB) return rankA - rankB;

    const matchA = Number(a.matchScore) || 0;
    const matchB = Number(b.matchScore) || 0;
    if (matchA !== matchB) return matchB - matchA;

    const dateA = Date.parse(a.postedAt) || 0;
    const dateB = Date.parse(b.postedAt) || 0;
    return dateB - dateA;
  });
}

// ---------------------------------------------------------------- providers

export const PROVIDER_LINKS = [
  { name: 'Jobicy', home: 'https://jobicy.com/jobs' },
  { name: 'Remote OK', home: 'https://remoteok.com' },
  { name: 'Remotive', home: 'https://remotive.com/remote-jobs' }
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&hellip;/gi, '…')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function humanizeType(value) {
  const raw = Array.isArray(value) ? value.join(', ') : value;
  return String(raw || '')
    .replace(/_/g, '-')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function salaryText({ min, max, currency, period }) {
  const low = Number(min) > 0 ? Number(min) : 0;
  const high = Number(max) > 0 ? Number(max) : 0;
  if (!low && !high) return '';

  const format = (value) => value.toLocaleString('en-US');
  const range = low && high ? format(low) + '–' + format(high) : format(low || high);
  const unit = period ? ' / ' + String(period).toLowerCase() : '';
  return (currency || 'USD') + ' ' + range + unit;
}

function jobDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

// Some boards publish a blank or bare "Remote" location even when the body
// states who can apply. Only fill the gap when the location says nothing.
function locationWithHint(location, description) {
  const stated = String(location || '').trim();
  if (stated && !BARE_REMOTE_PATTERN.test(normalizeText(stated))) return stated;
  return descriptionLocationHint(description) || stated;
}

export function normalizeProviderJobs(providerId, data) {
  if (providerId === 'remotive') {
    const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
    return jobs
      .filter((job) => job && job.title && job.url)
      .map((job) => {
        const description = stripHtml(job.description).slice(0, 24000);
        return {
          id: 'remotive-' + job.id,
          providerId: 'remotive',
          provider: 'Remotive',
          providerHome: 'https://remotive.com/remote-jobs',
          title: String(job.title).trim(),
          company: String(job.company_name || 'Unknown company').trim(),
          location: locationWithHint(job.candidate_required_location, description),
          url: job.url,
          postedAt: jobDate(job.publication_date),
          type: humanizeType(job.job_type),
          level: '',
          salary: String(job.salary || '').trim(),
          category: String(job.category || '').trim(),
          tags: Array.isArray(job.tags) ? job.tags.map(String) : [],
          description
        };
      });
  }

  if (providerId === 'jobicy') {
    const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
    const industry = (job) => (Array.isArray(job.jobIndustry) ? job.jobIndustry.map(String) : []);
    return jobs
      .filter((job) => job && job.jobTitle && job.url)
      .map((job) => {
        const description = stripHtml(job.jobDescription || job.jobExcerpt).slice(0, 24000);
        return {
          id: 'jobicy-' + job.id,
          providerId: 'jobicy',
          provider: 'Jobicy',
          providerHome: 'https://jobicy.com/jobs',
          title: String(job.jobTitle).trim(),
          company: String(job.companyName || 'Unknown company').trim(),
          location: locationWithHint(job.jobGeo, description),
          url: job.url,
          postedAt: jobDate(job.pubDate),
          type: humanizeType(job.jobType),
          level: String(job.jobLevel || '').trim(),
          salary: salaryText({
            min: job.salaryMin,
            max: job.salaryMax,
            currency: job.salaryCurrency,
            period: job.salaryPeriod
          }),
          category: industry(job)[0] || '',
          tags: industry(job),
          description
        };
      });
  }

  if (providerId === 'remoteok') {
    // The first array item is Remote OK's API terms notice, not a job.
    const jobs = Array.isArray(data) ? data.filter((job) => job && job.id && job.position && job.url) : [];
    return jobs.map((job) => {
      const description = stripHtml(job.description)
        .replace(/\s*(?:please\s+)?mention the word[\s\S]*$/i, '')
        .slice(0, 24000);
      const stated = String(job.location || '').trim();
      return {
        id: 'remoteok-' + job.id,
        providerId: 'remoteok',
        provider: 'Remote OK',
        providerHome: 'https://remoteok.com',
        title: String(job.position).trim(),
        company: String(job.company || 'Unknown company').trim(),
        location: stated || descriptionLocationHint(description),
        url: job.url,
        postedAt: jobDate(job.date),
        type: '',
        level: '',
        salary: salaryText({
          min: job.salary_min,
          max: job.salary_max,
          currency: 'USD',
          period: 'year'
        }),
        category: '',
        tags: Array.isArray(job.tags) ? job.tags.map(String) : [],
        description
      };
    });
  }

  return [];
}

async function fetchJson(url, fetchImpl) {
  const cached = RESPONSE_CACHE.get(url);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    RESPONSE_CACHE.set(url, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('timed out');
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mergeJobsById(jobs) {
  const byId = new Map();
  jobs.forEach((job) => {
    if (!byId.has(job.id)) byId.set(job.id, job);
  });
  return Array.from(byId.values());
}

async function loadJobicy(query, fetchImpl) {
  const terms = [String(query).trim()];
  const firstToken = roleTokens(query)[0];
  if (firstToken && firstToken !== normalizeText(query)) terms.push(firstToken);

  let lastJobs = [];
  let lastError = null;
  let attempted = 0;
  let failed = 0;

  for (const term of Array.from(new Set(terms.filter(Boolean))).slice(0, 2)) {
    const base = 'https://jobicy.com/api/jobs?count=100&tag=' + encodeURIComponent(term);
    // The tagged feed mixes regions. A second request pulls Jobicy's small
    // worldwide-only feed, which is the most reliable source of roles that
    // anyone can apply to regardless of country.
    const urls = [base, 'https://jobicy.com/api/jobs?count=100&geo=anywhere'];
    const settled = await Promise.allSettled(urls.map((url) => fetchJson(url, fetchImpl)));

    attempted += settled.length;
    const loaded = [];
    // Iterate the geo-filtered request first so its "Anywhere" copy of a
    // duplicate posting wins over the same posting from the mixed feed.
    [settled[1], settled[0]].forEach((result) => {
      if (!result) return;
      if (result.status === 'fulfilled') {
        loaded.push(...normalizeProviderJobs('jobicy', result.value));
      } else {
        failed += 1;
        lastError = result.reason;
      }
    });

    lastJobs = mergeJobsById(loaded);
    if (lastJobs.length) return lastJobs;
  }

  if (attempted && failed === attempted) {
    throw lastError || new Error('unavailable');
  }
  return lastJobs;
}

async function loadRemotive(query, fetchImpl) {
  // Remotive's public feed currently ignores search params and returns its
  // latest batch, so the role match happens locally.
  const data = await fetchJson('https://remotive.com/api/remote-jobs?limit=100', fetchImpl);
  return normalizeProviderJobs('remotive', data);
}

async function loadRemoteOk(query, fetchImpl) {
  const data = await fetchJson('https://remoteok.com/api', fetchImpl);
  return normalizeProviderJobs('remoteok', data);
}

const PROVIDERS = [
  { id: 'jobicy', name: 'Jobicy', home: 'https://jobicy.com/jobs', load: loadJobicy },
  { id: 'remoteok', name: 'Remote OK', home: 'https://remoteok.com', load: loadRemoteOk },
  { id: 'remotive', name: 'Remotive', home: 'https://remotive.com/remote-jobs', load: loadRemotive }
];

function dedupeJobs(jobs) {
  const kept = new Map();
  const weight = (job) =>
    (job.eligibility && job.eligibility.eligible ? 2 : 0) +
    (Number(job.matchScore) || 0) +
    (job.description ? 0.05 : 0);

  jobs.forEach((job) => {
    const key = compact(job.company) + '|' + compact(job.title);
    const current = kept.get(key);
    if (!current || weight(job) > weight(current)) kept.set(key, job);
  });

  return Array.from(kept.values());
}

/**
 * Fetch every provider in parallel, normalize, match by role, dedupe, and
 * attach an eligibility verdict. A provider failure never hides the others.
 */
export async function searchJobs(query, options = {}) {
  const trimmed = String(query || '').trim();
  const target = String(options.target || DEFAULT_TARGET).trim() || DEFAULT_TARGET;
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('Network access is not available.');

  const empty = { query: trimmed, target, jobs: [], providers: [], fetchedAt: new Date().toISOString() };
  if (!trimmed) return empty;

  const settled = await Promise.allSettled(PROVIDERS.map((provider) => provider.load(trimmed, fetchImpl)));

  const providers = [];
  let jobs = [];

  settled.forEach((result, index) => {
    const provider = PROVIDERS[index];
    if (result.status === 'fulfilled') {
      const loaded = result.value || [];
      jobs = jobs.concat(loaded);
      providers.push({
        id: provider.id,
        name: provider.name,
        home: provider.home,
        status: loaded.length ? 'ok' : 'empty',
        loaded: loaded.length,
        count: 0,
        error: ''
      });
    } else {
      const message = result.reason && result.reason.message ? result.reason.message : 'unavailable';
      providers.push({
        id: provider.id,
        name: provider.name,
        home: provider.home,
        status: 'error',
        loaded: 0,
        count: 0,
        error: message
      });
    }
  });

  jobs = matchJobs(jobs, trimmed).map((job) => ({
    ...job,
    eligibility: classifyEligibility(job.location, target)
  }));

  jobs = dedupeJobs(jobs);

  const counts = new Map();
  jobs.forEach((job) => counts.set(job.providerId, (counts.get(job.providerId) || 0) + 1));
  providers.forEach((provider) => {
    provider.count = counts.get(provider.id) || 0;
  });

  return {
    query: trimmed,
    target,
    jobs,
    providers,
    fetchedAt: new Date().toISOString()
  };
}
