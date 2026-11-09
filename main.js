/* knomad — local-first job search workspace */

// ---------------------------------------------------------------- Storage

const STORE = {
  profile: 'knomad_profile',
  applications: 'knomad_applications',
  key: 'knomad_gemini_key'
};

const STATUS = ['applied', 'interviewing', 'offer', 'rejected'];
const STATUS_LABEL = {
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected'
};

const REMINDER_LABELS = {
  0: 'At the time',
  15: '15 minutes before',
  60: '1 hour before',
  1440: '1 day before',
  10080: '1 week before'
};

const NOTIFIED_KEY = 'knomad_notified';

const PDF_LIB_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';

const PRACTICE_FILLERS = [
  'um', 'uh', 'like', 'just', 'really', 'basically', 'actually',
  'kind of', 'sort of', 'you know', 'i guess'
];

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
let workingModel = null;

const DAY_MS = 24 * 60 * 60 * 1000;

const SKILL_WORDS = [
  'javascript', 'typescript', 'react', 'next.js', 'vue', 'angular', 'svelte', 'node.js',
  'python', 'java', 'c#', 'c++', 'go', 'rust', 'php', 'ruby', 'swift', 'kotlin',
  'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'graphql', 'rest', 'api',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'git', 'linux',
  'html', 'css', 'sass', 'tailwind', 'figma', 'design systems', 'accessibility',
  'ux', 'ui', 'prototyping', 'user research', 'agile', 'scrum', 'jira', 'kanban',
  'machine learning', 'data analysis', 'data visualization', 'excel', 'tableau',
  'power bi', 'salesforce', 'seo', 'content marketing', 'product management',
  'project management', 'customer success', 'communication', 'leadership',
  'stakeholder management', 'a/b testing', 'analytics', 'photoshop', 'illustrator',
  'copywriting', 'email marketing', 'paid media', 'crm'
];

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function makeId() {
  return 'app_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeEventId() {
  return 'evt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeEvents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && entry.at && !Number.isNaN(new Date(entry.at).getTime()))
    .map((entry) => {
      const reminder = Number(entry.reminder);
      return {
        id: entry.id || makeEventId(),
        kind: entry.kind === 'reminder' ? 'reminder' : 'interview',
        title: entry.title || '',
        at: new Date(entry.at).toISOString(),
        reminder: REMINDER_LABELS[reminder] != null ? reminder : 60
      };
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function emptyPractice() {
  return {
    started: false,
    answers: [],
    index: 0,
    completed: false,
    score: null,
    results: [],
    gradedAt: null
  };
}

function normalizePractice(raw) {
  const base = emptyPractice();
  if (!raw || typeof raw !== 'object') return base;

  const answers = Array.isArray(raw.answers)
    ? raw.answers.map((answer) => (typeof answer === 'string' ? answer : ''))
    : [];
  const index = Number(raw.index);

  return {
    started: Boolean(raw.started),
    answers,
    index: Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0,
    completed: Boolean(raw.completed),
    score: Number.isFinite(Number(raw.score)) && raw.score != null ? Math.round(Number(raw.score)) : null,
    results: Array.isArray(raw.results)
      ? raw.results.map((result) => ({
          score: Number.isFinite(Number(result && result.score)) ? Math.round(Number(result.score)) : 0,
          feedback: Array.isArray(result && result.feedback) ? result.feedback.map(String) : []
        }))
      : [],
    gradedAt: raw.gradedAt || null
  };
}

function defaultProfile() {
  return {
    name: '',
    headline: '',
    email: '',
    phone: '',
    location: '',
    links: { linkedin: '', github: '', website: '' },
    summary: '',
    skills: [],
    resumeText: '',
    resumeFileName: ''
  };
}

function normalizeProfile(raw) {
  const base = defaultProfile();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    links: { ...base.links, ...(raw.links || {}) },
    skills: Array.isArray(raw.skills) ? raw.skills.filter(Boolean) : []
  };
}

function normalizeApplications(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((app) => {
    const status = STATUS.includes(app.status) ? app.status : 'applied';
    const dateApplied = app.dateApplied || new Date().toISOString();
    const statusHistory = Array.isArray(app.statusHistory) && app.statusHistory.length
      ? app.statusHistory
          .filter((entry) => entry && STATUS.includes(entry.status) && entry.at)
          .map((entry) => ({ status: entry.status, at: entry.at }))
      : [{ status, at: dateApplied }];

    if (!statusHistory.some((entry) => entry.status === status)) {
      statusHistory.push({ status, at: dateApplied });
    }
    statusHistory.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return {
      id: app.id != null ? app.id : makeId(),
      company: app.company || 'Unknown company',
      position: app.position || 'Untitled role',
      status,
      url: app.url || '',
      notes: app.notes || '',
      dateApplied,
      statusHistory,
      events: normalizeEvents(app.events),
      interviewSession: normalizePractice(app.interviewSession),
      resume: app.resume || '',
      interviewPrep: app.interviewPrep || '',
      jobDescription: app.jobDescription || ''
    };
  });
}

const state = {
  profile: normalizeProfile(loadJSON(STORE.profile, null)),
  applications: normalizeApplications(loadJSON(STORE.applications, [])),
  geminiKey: localStorage.getItem(STORE.key) || ''
};

function saveProfile() {
  localStorage.setItem(STORE.profile, JSON.stringify(state.profile));
}

function saveApplications() {
  localStorage.setItem(STORE.applications, JSON.stringify(state.applications));
}

// ---------------------------------------------------------------- Helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'k';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function toast(message, type = 'success') {
  const host = $('#toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3400);
  setTimeout(() => el.remove(), 3800);
}

async function copyText(text) {
  const value = String(text || '');
  try {
    await navigator.clipboard.writeText(value);
  } catch (err) {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* no-op */ }
    area.remove();
  }
  toast('Copied to clipboard');
}

function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- Calendar helpers

function pad2(value) {
  return String(value).padStart(2, '0');
}

function startOfDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth(value) {
  const date = new Date(value);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function localInputValue(value) {
  const date = new Date(value);
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatEventDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' + formatTime(date);
}

function relativeDay(value) {
  const target = startOfDay(value);
  const today = startOfDay(new Date());
  if (!target) return '';
  const diff = Math.round((target.getTime() - today.getTime()) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return new Date(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function eventKindLabel(event) {
  return event.kind === 'reminder' ? 'Reminder' : 'Interview';
}

function eventReminderLabel(event) {
  const minutes = Number(event.reminder);
  return REMINDER_LABELS[minutes] || (minutes ? minutes + ' min before' : 'At the time');
}

function eventTitle(event) {
  return event.title || eventKindLabel(event);
}

function allEvents() {
  return state.applications
    .reduce((list, app) => {
      (app.events || []).forEach((event) => {
        if (event && event.at && !Number.isNaN(new Date(event.at).getTime())) {
          list.push({ app, event });
        }
      });
      return list;
    }, [])
    .sort((a, b) => new Date(a.event.at).getTime() - new Date(b.event.at).getTime());
}

const calendarState = {
  month: startOfMonth(new Date()),
  selected: dayKey(new Date())
};

// ---------------------------------------------------------------- Navigation

const PAGE_TITLES = {
  dashboard: 'Dashboard',
  tracker: 'Applications',
  calendar: 'Calendar',
  application: 'Application',
  profile: 'Profile',
  settings: 'Settings'
};

let currentPage = 'dashboard';
let applicationReturnPage = 'dashboard';

function showPage(page) {
  const target = PAGE_TITLES[page] ? page : 'dashboard';
  currentPage = target;

  $$('.page').forEach((section) => {
    section.classList.toggle('active', section.id === target + 'Page');
  });
  $$('.rail-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === target);
  });
  const title = $('#pageTitle');
  if (title) title.textContent = PAGE_TITLES[target];

  const backBtn = $('#backBtn');
  if (backBtn) {
    const backTarget = target === 'application' ? applicationReturnPage : 'dashboard';
    backBtn.hidden = target === 'dashboard';
    backBtn.dataset.pageTarget = backTarget;
    const label = 'Back to ' + (PAGE_TITLES[backTarget] || 'Dashboard');
    backBtn.setAttribute('aria-label', label);
    backBtn.setAttribute('title', label);
  }

  if (target === 'dashboard') renderDashboard();
  if (target === 'tracker') renderTracker();
  if (target === 'calendar') renderCalendar();
  if (target === 'application') renderApplication();
  if (target === 'settings') renderSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- Dashboard

function renderDashboard() {
  const profile = state.profile;
  const applications = state.applications;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = firstName(profile.name);
  const greetingEl = $('#greeting');
  if (greetingEl) {
    greetingEl.innerHTML = first
      ? greeting + ', <em>' + escapeHtml(first) + '</em>.'
      : greeting + '.';
  }

  const sub = $('#heroSub');
  if (sub) {
    sub.textContent = profile.resumeText
      ? 'Add a job posting and knomad tailors your resume, drafts interview prep, and files it in your tracker.'
      : 'Start with your profile. Add a resume once, then every job you add gets a tailored version.';
  }

  const avatar = $('#dashAvatar');
  if (avatar) avatar.textContent = initials(profile.name);
  const nameEl = $('#dashName');
  if (nameEl) nameEl.textContent = profile.name || 'Add your name';
  const headlineEl = $('#dashHeadline');
  if (headlineEl) {
    headlineEl.textContent = profile.headline || 'Your headline appears on every tailored resume.';
  }

  const topAvatar = $('#avatarBtn');
  if (topAvatar) topAvatar.textContent = initials(profile.name);

  renderChips(profile);
  renderStats(applications);
  renderActivity(applications);
  renderStatusChart(applications);
  renderUpcoming();
  renderRecent(applications);
  renderResumeSheet(profile);
}

function renderChips(profile) {
  const host = $('#dashChips');
  if (!host) return;
  const chips = [];
  if (profile.email) chips.push({ text: profile.email });
  if (profile.location) chips.push({ text: profile.location });
  if (profile.phone) chips.push({ text: profile.phone });
  if (profile.links.linkedin) chips.push({ text: 'LinkedIn', accent: true });
  if (profile.links.github) chips.push({ text: 'GitHub', accent: true });
  if (profile.links.website) chips.push({ text: 'Portfolio', accent: true });
  (profile.skills || []).slice(0, 3).forEach((skill) => chips.push({ text: skill }));

  host.innerHTML = chips.length
    ? chips.map((chip) => '<span class="chip' + (chip.accent ? ' accent' : '') + '">' +
        escapeHtml(chip.text) + '</span>').join('')
    : '<span class="chip empty">No contact details yet</span>';
}

function statusHistoryOf(app) {
  return Array.isArray(app.statusHistory) && app.statusHistory.length
    ? app.statusHistory
    : [{ status: app.status, at: app.dateApplied }];
}

function dashboardMetrics(applications) {
  const weekAgo = Date.now() - 7 * DAY_MS;
  const counts = { applied: 0, interviewing: 0, offer: 0, rejected: 0 };
  let addedThisWeek = 0;
  let interviewsThisWeek = 0;
  let replied = 0;

  applications.forEach((app) => {
    if (counts[app.status] != null) counts[app.status] += 1;
    if (app.status !== 'applied') replied += 1;

    const appliedAt = new Date(app.dateApplied).getTime();
    if (Number.isFinite(appliedAt) && appliedAt >= weekAgo) addedThisWeek += 1;

    const interviewed = statusHistoryOf(app).some((entry) => {
      if (entry.status !== 'interviewing') return false;
      const at = new Date(entry.at).getTime();
      return Number.isFinite(at) && at >= weekAgo;
    });
    if (interviewed) interviewsThisWeek += 1;
  });

  const total = applications.length;
  return {
    total,
    counts,
    addedThisWeek,
    interviewsThisWeek,
    active: counts.applied + counts.interviewing,
    offers: counts.offer,
    replied,
    responseRate: total ? Math.round((replied / total) * 100) : 0
  };
}

function renderStats(applications) {
  const host = $('#statsGrid');
  if (!host) return;
  const metrics = dashboardMetrics(applications);

  const cards = [
    {
      label: 'Applications',
      value: metrics.total,
      note: metrics.addedThisWeek
        ? '+' + metrics.addedThisWeek + ' in the last 7 days'
        : 'None added in the last 7 days'
    },
    {
      label: 'Interviews · 7d',
      value: metrics.interviewsThisWeek,
      note: metrics.interviewsThisWeek ? 'Reached interviewing this week' : 'No interview moves this week',
      tone: 'amber'
    },
    {
      label: 'Active pipeline',
      value: metrics.active,
      note: metrics.counts.interviewing + ' interviewing now',
      tone: 'accent'
    },
    {
      label: 'Response rate',
      value: metrics.total ? metrics.responseRate + '%' : '—',
      note: metrics.total
        ? metrics.replied + ' of ' + metrics.total + ' moved past applied'
        : 'Add a job to start tracking'
    }
  ];

  host.innerHTML = cards.map((card) => (
    '<article class="stat-card' + (card.tone ? ' ' + card.tone : '') + '">' +
    '<span class="stat-label">' + card.label + '</span>' +
    '<span class="stat-value">' + card.value + '</span>' +
    '<span class="stat-note">' + escapeHtml(card.note) + '</span>' +
    '</article>'
  )).join('');
}

function renderActivity(applications) {
  const host = $('#activityChart');
  if (!host) return;

  if (!applications.length) {
    host.innerHTML = '<div class="chart-empty">No applications yet.<span>Add a job and it appears on this timeline.</span></div>';
    return;
  }

  const days = 14;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - (days - 1) * DAY_MS;
  const buckets = Array.from({ length: days }, (_, index) => ({
    date: new Date(start + index * DAY_MS),
    count: 0
  }));

  applications.forEach((app) => {
    const applied = new Date(app.dateApplied);
    if (Number.isNaN(applied.getTime())) return;
    applied.setHours(0, 0, 0, 0);
    const index = Math.round((applied.getTime() - start) / DAY_MS);
    if (index >= 0 && index < days) buckets[index].count += 1;
  });

  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));

  const bars = buckets.map((bucket) => {
    const height = bucket.count ? Math.max(8, Math.round((bucket.count / max) * 100)) : 2;
    const label = formatDate(bucket.date);
    const description = label + ' — ' + bucket.count + (bucket.count === 1 ? ' application' : ' applications');
    return '<div class="bar-col" title="' + escapeHtml(description) + '">' +
      '<span class="bar-value">' + (bucket.count || '') + '</span>' +
      '<span class="bar' + (bucket.count ? '' : ' empty') + '" style="height:' + height + '%"></span>' +
      '</div>';
  }).join('');

  const axis = [buckets[0], buckets[Math.floor(days / 2)], buckets[days - 1]]
    .map((bucket) => '<span>' + escapeHtml(formatDate(bucket.date)) + '</span>')
    .join('');

  host.innerHTML = '<div class="activity-bars" aria-hidden="true">' + bars + '</div>' +
    '<div class="activity-axis">' + axis + '</div>';
}

function renderStatusChart(applications) {
  const host = $('#statusChart');
  const totalEl = $('#statusTotal');
  const foot = $('#statusFoot');
  if (!host) return;

  const total = applications.length;
  if (totalEl) totalEl.textContent = total + (total === 1 ? ' application' : ' applications');

  const counts = STATUS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});
  applications.forEach((app) => {
    if (counts[app.status] != null) counts[app.status] += 1;
  });

  host.innerHTML = STATUS.map((key) => {
    const count = counts[key];
    const pct = total ? Math.round((count / total) * 100) : 0;
    return '<div class="status-row' + (count ? '' : ' is-empty') + '">' +
      '<div class="status-row-head">' +
      '<span class="status-name"><span class="status-dot ' + key + '"></span>' + STATUS_LABEL[key] + '</span>' +
      '<span class="status-count">' + count + ' · ' + pct + '%</span>' +
      '</div>' +
      '<div class="status-track"><span class="status-fill ' + key + '" style="width:' + pct + '%"></span></div>' +
      '</div>';
  }).join('');

  if (foot) {
    const replied = total - counts.applied;
    const rate = total ? Math.round((replied / total) * 100) : 0;
    foot.textContent = total
      ? replied + ' of ' + total + ' moved past applied · ' + rate + '% response rate.'
      : 'Add your first job to see how the pipeline fills in.';
  }
}

function renderRecent(applications) {
  const host = $('#recentList');
  if (!host) return;

  if (!applications.length) {
    host.innerHTML =
      '<div class="empty-state">' +
      '<p>No applications yet. Add your first posting and knomad fills in the rest.</p>' +
      '<button class="btn subtle small" data-action="add-job">+ Add your first job</button>' +
      '</div>';
    return;
  }

  const recent = applications.slice(0, 5);
  host.innerHTML = recent.map((app) => {
    return '<button class="recent-row" data-view="' + escapeHtml(app.id) + '">' +
      '<span class="recent-main">' +
      '<strong>' + escapeHtml(app.company) + '</strong>' +
      '<span>' + escapeHtml(app.position) + '</span>' +
      '</span>' +
      statusBadge(app.status) +
      '<span class="recent-date">' + escapeHtml(formatDate(app.dateApplied)) + '</span>' +
      '</button>';
  }).join('');
}

function renderUpcoming() {
  const host = $('#upcomingList');
  if (!host) return;

  const now = Date.now();
  const upcoming = allEvents().filter(({ event }) => new Date(event.at).getTime() >= now);

  if (!upcoming.length) {
    host.innerHTML = '<div class="event-empty">Nothing scheduled. Add an interview from any application.</div>';
    return;
  }

  host.innerHTML = upcoming.slice(0, 5).map(({ app, event }) => {
    return '<button class="upcoming-row" type="button" data-view="' + escapeHtml(app.id) + '">' +
      '<span class="upcoming-when">' + escapeHtml(relativeDay(event.at)) + ' <br>' + escapeHtml(formatTime(event.at)) + '</span>' +
      '<span class="event-kind' + (event.kind === 'reminder' ? ' reminder' : '') + '"></span>' +
      '<span class="upcoming-main">' +
      '<strong>' + escapeHtml(eventTitle(event)) + '</strong>' +
      '<span>' + escapeHtml((app.company || 'Unknown company') + ' · ' + (app.position || 'Untitled role')) + '</span>' +
      '</span>' +
      '</button>';
  }).join('');
}

function statusBadge(status) {
  return '<span class="badge ' + escapeHtml(status) + '">' + STATUS_LABEL[status] + '</span>';
}

function renderResumeSheet(profile) {
  const sheet = $('#resumeSheet');
  const meta = $('#resumeMeta');
  const words = $('#resumeWords');
  if (meta) meta.textContent = profile.resumeText ? (profile.resumeFileName || 'Pasted resume') : 'Not uploaded';
  if (words) words.textContent = profile.resumeText ? wordCount(profile.resumeText) + ' words' : '';
  if (!sheet) return;

  if (!profile.resumeText) {
    sheet.innerHTML = '<p class="sheet-empty">No resume yet.<br>Add one in your profile.</p>';
    return;
  }

  const snippet = profile.resumeText.slice(0, 900);
  sheet.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'sheet-text';
  pre.textContent = snippet;
  sheet.appendChild(pre);
}

// ---------------------------------------------------------------- Tracker

function renderTracker() {
  const body = $('#appTableBody');
  if (!body) return;

  const term = ($('#searchInput') ? $('#searchInput').value : '').toLowerCase().trim();
  const status = $('#statusFilter') ? $('#statusFilter').value : 'all';

  const filtered = state.applications.filter((app) => {
    if (status !== 'all' && app.status !== status) return false;
    if (!term) return true;
    return (app.company + ' ' + app.position + ' ' + app.notes).toLowerCase().includes(term);
  });

  const countEl = $('#trackerCount');
  if (countEl) {
    const total = state.applications.length;
    countEl.textContent = filtered.length === total
      ? total + (total === 1 ? ' tracked' : ' tracked')
      : filtered.length + ' of ' + total + ' shown';
  }

  if (!filtered.length) {
    const message = state.applications.length
      ? 'No applications match these filters.'
      : 'Nothing tracked yet. Add a job to start.';
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">' +
      escapeHtml(message) +
      (state.applications.length ? '' : ' <br><br><button class="btn subtle small" data-action="add-job">+ Add a job</button>') +
      '</div></td></tr>';
    return;
  }

  body.innerHTML = filtered.map((app) => {
    return '<tr>' +
      '<td><span class="cell-main">' + escapeHtml(app.company) + '</span>' +
      (app.url ? '<span class="cell-sub">' + escapeHtml(hostnameOf(app.url)) + '</span>' : '') + '</td>' +
      '<td><span class="cell-main">' + escapeHtml(app.position) + '</span>' +
      (app.notes ? '<span class="cell-sub">' + escapeHtml(app.notes) + '</span>' : '') + '</td>' +
      '<td>' + statusBadge(app.status) + '</td>' +
      '<td><span class="cell-sub">' + escapeHtml(formatDate(app.dateApplied)) + '</span></td>' +
      '<td><div class="row-actions">' +
      '<button class="btn ghost small" data-view="' + escapeHtml(app.id) + '">View</button>' +
      '<button class="btn danger small" data-delete="' + escapeHtml(app.id) + '">Delete</button>' +
      '</div></td>' +
      '</tr>';
  }).join('');
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    return url;
  }
}

// ---------------------------------------------------------------- Calendar

function eventRowHtml(app, event, options = {}) {
  const past = new Date(event.at).getTime() < Date.now() ? ' is-past' : '';
  let when = formatTime(event.at);
  if (options.withDay) when = relativeDay(event.at) + ' · ' + when;
  if (options.full) when = formatEventDateTime(event.at);
  const sub = options.detail
    ? when + ' · ' + eventReminderLabel(event)
    : when + ' · ' + (app.company || 'Unknown company');

  return '<div class="event-row' + past + '">' +
    '<span class="event-kind' + (event.kind === 'reminder' ? ' reminder' : '') + '"></span>' +
    '<span class="event-row-main">' +
    '<strong>' + escapeHtml(eventTitle(event)) + '</strong>' +
    '<span>' + escapeHtml(sub) + '</span>' +
    '</span>' +
    '<button class="event-del" type="button" data-event-del="' + escapeHtml(event.id) + '" title="Remove event" aria-label="Remove event">×</button>' +
    '</div>';
}

function renderCalendar() {
  const grid = $('#calDays');
  if (!grid) return;

  const month = calendarState.month;
  const events = allEvents();
  const byDay = new Map();
  events.forEach(({ app, event }) => {
    const key = dayKey(event.at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ app, event });
  });

  const monthEvents = events.filter(({ event }) => {
    const date = new Date(event.at);
    return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth();
  });

  const monthEl = $('#calMonth');
  if (monthEl) monthEl.textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const countEl = $('#calEventCount');
  if (countEl) {
    countEl.textContent = monthEvents.length
      ? monthEvents.length + (monthEvents.length === 1 ? ' event' : ' events')
      : 'No events';
  }

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const todayKey = dayKey(new Date());

  let cells = '';
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dayKey(date);
    const dayEvents = byDay.get(key) || [];
    const classes = ['cal-day'];
    if (date.getMonth() !== month.getMonth()) classes.push('out');
    if (key === todayKey) classes.push('today');
    if (key === calendarState.selected) classes.push('selected');

    const dots = dayEvents.slice(0, 3)
      .map(({ event }) => '<span class="cal-dot' + (event.kind === 'reminder' ? ' reminder' : '') + '"></span>')
      .join('');
    const more = dayEvents.length > 3
      ? '<span class="cal-more">+' + (dayEvents.length - 3) + '</span>'
      : '';
    const label = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    cells += '<button type="button" class="' + classes.join(' ') + '" data-cal-day="' + key + '" ' +
      'aria-label="' + escapeHtml(label + (dayEvents.length ? ', ' + dayEvents.length + ' events' : '')) + '">' +
      '<span class="cal-day-num">' + date.getDate() + '</span>' +
      (dayEvents.length ? '<span class="cal-dots">' + dots + more + '</span>' : '') +
      '</button>';
  }
  grid.innerHTML = cells;

  const selectedDate = new Date(calendarState.selected + 'T00:00:00');
  const selectedLabel = $('#calSelectedLabel');
  if (selectedLabel) {
    selectedLabel.textContent = Number.isNaN(selectedDate.getTime())
      ? 'Selected day'
      : selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  const dayEvents = byDay.get(calendarState.selected) || [];
  const selectedCount = $('#calSelectedCount');
  if (selectedCount) {
    selectedCount.textContent = dayEvents.length
      ? dayEvents.length + (dayEvents.length === 1 ? ' event' : ' events')
      : '';
  }

  const dayList = $('#calDayList');
  if (dayList) {
    dayList.innerHTML = dayEvents.length
      ? dayEvents.map(({ app, event }) => eventRowHtml(app, event)).join('')
      : '<div class="event-empty">Nothing scheduled this day.</div>';
  }

  const now = Date.now();
  const horizon = startOfDay(new Date()).getTime() + 30 * DAY_MS;
  const upcoming = events.filter(({ event }) => {
    const at = new Date(event.at).getTime();
    return at >= now && at <= horizon;
  });

  const upcomingHost = $('#calUpcoming');
  if (upcomingHost) {
    upcomingHost.innerHTML = upcoming.length
      ? upcoming.slice(0, 6).map(({ app, event }) => eventRowHtml(app, event, { withDay: true })).join('')
      : '<div class="event-empty">No interviews or reminders in the next 30 days.</div>';
  }

  const foot = $('#calFoot');
  if (foot) {
    foot.textContent = upcoming.length
      ? upcoming.length + (upcoming.length === 1 ? ' event' : ' events') + ' in the next 30 days.'
      : 'Open any application to add an interview or reminder.';
  }
}

function shiftMonth(delta) {
  calendarState.month = new Date(calendarState.month.getFullYear(), calendarState.month.getMonth() + delta, 1);
  const selected = new Date(calendarState.selected + 'T00:00:00');
  if (selected.getFullYear() !== calendarState.month.getFullYear() || selected.getMonth() !== calendarState.month.getMonth()) {
    calendarState.selected = dayKey(calendarState.month);
  }
  renderCalendar();
}

function goToday() {
  calendarState.month = startOfMonth(new Date());
  calendarState.selected = dayKey(new Date());
  renderCalendar();
}

function selectCalendarDay(key) {
  const date = new Date(key + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return;
  calendarState.selected = key;
  calendarState.month = startOfMonth(date);
  renderCalendar();
}

function defaultEventValue() {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return localInputValue(date);
}

function renderDetailEvents() {
  const host = $('#detailEvents');
  if (!host) return;

  const application = state.applications.find((app) => String(app.id) === String(currentDetailId));
  const events = application ? (application.events || []).slice()
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()) : [];

  const count = $('#detailEventCount');
  if (count) {
    count.textContent = events.length ? events.length + (events.length === 1 ? ' event' : ' events') : '';
  }

  host.innerHTML = application && events.length
    ? events.map((event) => eventRowHtml(application, event, { full: true, detail: true })).join('')
    : '<div class="event-empty">No interviews or reminders yet. Add one below.</div>';
}

function handleEventSubmit(event) {
  event.preventDefault();
  const application = state.applications.find((app) => String(app.id) === String(currentDetailId));
  if (!application) return;

  const value = $('#eventAt') ? $('#eventAt').value : '';
  const at = new Date(value);
  if (!value || Number.isNaN(at.getTime())) {
    toast('Pick a date and time first', 'error');
    return;
  }

  const reminderValue = Number($('#eventReminder') ? $('#eventReminder').value : 60);
  const entry = {
    id: makeEventId(),
    kind: $('#eventKind') && $('#eventKind').value === 'reminder' ? 'reminder' : 'interview',
    title: $('#eventTitle') ? $('#eventTitle').value.trim() : '',
    at: at.toISOString(),
    reminder: REMINDER_LABELS[reminderValue] != null ? reminderValue : 60
  };

  application.events = normalizeEvents((application.events || []).concat(entry));
  saveApplications();

  const titleInput = $('#eventTitle');
  if (titleInput) titleInput.value = '';
  const atInput = $('#eventAt');
  if (atInput) atInput.value = defaultEventValue();

  renderDetailEvents();
  renderDashboard();
  renderCalendar();
  toast(entry.kind === 'interview' ? 'Interview added to calendar' : 'Reminder added to calendar');
}

function removeEvent(eventId) {
  let removed = false;
  state.applications.forEach((application) => {
    const before = (application.events || []).length;
    application.events = (application.events || []).filter((event) => String(event.id) !== String(eventId));
    if (application.events.length !== before) removed = true;
  });
  if (!removed) return;

  saveApplications();
  renderDashboard();
  renderCalendar();
  renderDetailEvents();
  toast('Event removed');
}

// ---------------------------------------------------------------- Profile form

function applyProfileToForm() {
  const profile = state.profile;
  const set = (id, value) => {
    const el = $('#' + id);
    if (el) el.value = value || '';
  };
  set('profileName', profile.name);
  set('profileHeadline', profile.headline);
  set('profileEmail', profile.email);
  set('profilePhone', profile.phone);
  set('profileLocation', profile.location);
  set('profileLinkedin', profile.links.linkedin);
  set('profileGithub', profile.links.github);
  set('profileWebsite', profile.links.website);
  set('profileSummary', profile.summary);
  set('profileSkills', (profile.skills || []).join(', '));
  set('profileResumeText', profile.resumeText);
  renderProfileResumeMeta();
}

function renderProfileResumeMeta() {
  const meta = $('#profileResumeMeta');
  const count = $('#resumeCharCount');
  const text = $('#profileResumeText') ? $('#profileResumeText').value : '';
  if (meta) {
    meta.textContent = state.profile.resumeText
      ? (state.profile.resumeFileName || 'Pasted resume') + ' · ' + wordCount(state.profile.resumeText) + ' words'
      : 'No resume on file';
  }
  if (count) count.textContent = wordCount(text) + ' words · ' + text.length + ' characters';
}

function handleProfileSubmit(event) {
  event.preventDefault();
  const profile = state.profile;

  profile.name = $('#profileName').value.trim();
  profile.headline = $('#profileHeadline').value.trim();
  profile.email = $('#profileEmail').value.trim();
  profile.phone = $('#profilePhone').value.trim();
  profile.location = $('#profileLocation').value.trim();
  profile.links.linkedin = $('#profileLinkedin').value.trim();
  profile.links.github = $('#profileGithub').value.trim();
  profile.links.website = $('#profileWebsite').value.trim();
  profile.summary = $('#profileSummary').value.trim();
  profile.skills = $('#profileSkills').value
    .split(',')
    .map((skill) => skill.trim())
    .filter(Boolean);
  profile.resumeText = $('#profileResumeText').value.trim();

  saveProfile();
  renderProfileResumeMeta();
  toast('Profile saved');
}

async function handleResumeFile(file) {
  if (!file) return;
  try {
    toast('Reading ' + file.name + '…');
    const text = await extractResumeText(file);
    if (!text || text.trim().length < 20) {
      throw new Error('That file had almost no readable text. Paste the resume text instead.');
    }
    state.profile.resumeText = text.trim();
    state.profile.resumeFileName = file.name;

    const field = $('#profileResumeText');
    if (field) field.value = state.profile.resumeText;

    const { parsed, changed } = importProfileFromResume(state.profile.resumeText);
    syncParsedFieldsToForm(parsed);
    renderProfileResumeMeta();

    toast(
      changed.length
        ? 'Resume loaded from ' + file.name + ' — filled ' + changed.join(', ')
        : 'Resume loaded from ' + file.name + '. No profile details detected; fill them in manually.'
    );
  } catch (err) {
    toast(err.message || 'Could not read that file', 'error');
  }
}

function fillProfileFromResume() {
  const field = $('#profileResumeText');
  const text = (field ? field.value : '').trim() || state.profile.resumeText;
  if (!text) {
    toast('Add or paste resume text first', 'error');
    return;
  }

  const { parsed, changed } = importProfileFromResume(text);
  syncParsedFieldsToForm(parsed);
  renderProfileResumeMeta();

  if (text !== state.profile.resumeText) {
    state.profile.resumeText = text;
    saveProfile();
  }

  toast(
    changed.length
      ? 'Filled ' + changed.join(', ') + ' from your resume. Review, then save.'
      : 'No profile details found. Fill the fields manually.',
    changed.length ? 'success' : 'error'
  );
}

function clearResume() {
  state.profile.resumeText = '';
  state.profile.resumeFileName = '';
  saveProfile();
  const field = $('#profileResumeText');
  if (field) field.value = '';
  renderProfileResumeMeta();
  toast('Resume cleared');
}

// ---------------------------------------------------------------- Resume → profile

const RESUME_HEADINGS = new Set([
  'summary', 'professional summary', 'career summary', 'executive summary',
  'profile', 'professional profile', 'about', 'about me', 'objective', 'career objective',
  'experience', 'work experience', 'professional experience', 'relevant experience',
  'selected experience', 'employment', 'employment history', 'history',
  'education', 'skills', 'skill', 'core skills', 'key skills', 'technical skills',
  'competencies', 'core competencies', 'areas of expertise', 'expertise',
  'technologies', 'tools', 'tech stack', 'tools & technologies', 'tools and technologies',
  'projects', 'personal projects', 'certifications', 'certificates', 'awards',
  'publications', 'languages', 'interests', 'volunteer', 'references', 'contact',
  'contact information', 'additional information', 'information',
  'resume', 'curriculum vitae'
]);

const RESUME_SECTION_ALIASES = {
  summary: [
    'summary', 'professional summary', 'career summary', 'executive summary',
    'profile', 'professional profile', 'about', 'about me', 'objective', 'career objective'
  ],
  skills: [
    'skills', 'core skills', 'key skills', 'technical skills', 'core competencies',
    'competencies', 'areas of expertise', 'expertise', 'technologies', 'tools', 'tech stack',
    'tools & technologies', 'tools and technologies'
  ]
};

const SKILL_CASE = {
  javascript: 'JavaScript', typescript: 'TypeScript', react: 'React', 'next.js': 'Next.js',
  vue: 'Vue', angular: 'Angular', svelte: 'Svelte', 'node.js': 'Node.js', python: 'Python',
  java: 'Java', 'c#': 'C#', 'c++': 'C++', go: 'Go', rust: 'Rust', php: 'PHP', ruby: 'Ruby',
  swift: 'Swift', kotlin: 'Kotlin', sql: 'SQL', postgresql: 'PostgreSQL', mysql: 'MySQL',
  mongodb: 'MongoDB', redis: 'Redis', graphql: 'GraphQL', rest: 'REST', api: 'API',
  aws: 'AWS', azure: 'Azure', gcp: 'GCP', docker: 'Docker', kubernetes: 'Kubernetes',
  terraform: 'Terraform', 'ci/cd': 'CI/CD', git: 'Git', linux: 'Linux', html: 'HTML',
  css: 'CSS', sass: 'Sass', tailwind: 'Tailwind', figma: 'Figma', ux: 'UX', ui: 'UI',
  agile: 'Agile', scrum: 'Scrum', jira: 'Jira', kanban: 'Kanban',
  'machine learning': 'Machine Learning', 'data analysis': 'Data Analysis',
  'data visualization': 'Data Visualization', excel: 'Excel', tableau: 'Tableau',
  'power bi': 'Power BI', salesforce: 'Salesforce', seo: 'SEO',
  'content marketing': 'Content Marketing', 'product management': 'Product Management',
  'project management': 'Project Management', 'customer success': 'Customer Success',
  communication: 'Communication', leadership: 'Leadership',
  'stakeholder management': 'Stakeholder Management', 'a/b testing': 'A/B Testing',
  analytics: 'Analytics', photoshop: 'Photoshop', illustrator: 'Illustrator',
  copywriting: 'Copywriting', 'email marketing': 'Email Marketing', 'paid media': 'Paid Media',
  crm: 'CRM', 'design systems': 'Design Systems', accessibility: 'Accessibility',
  prototyping: 'Prototyping', 'user research': 'User Research'
};

function headingKey(line) {
  return String(line || '')
    .toLowerCase()
    .replace(/[^a-z&/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSectionHeading(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.length > 42) return false;
  const key = headingKey(raw);
  if (!key) return false;
  if (RESUME_HEADINGS.has(key)) return true;

  const words = key.split(' ');
  if (words.length > 4) return false;
  const hasKeyword = words.some((word) => RESUME_HEADINGS.has(word));
  const allCaps = !/[a-z]/.test(raw);
  return hasKeyword && allCaps;
}

function looksLikeContact(line) {
  return /@|https?:\/\/|www\./i.test(line) || /\|\s*\S/.test(line);
}

function hasJobWord(line) {
  return /\b(resume|curriculum vitae|vitae|cv|linkedin|github|portfolio|email|e-mail|phone|mobile|address|website)\b/i.test(line);
}

function smartNameCase(line) {
  const value = String(line || '').replace(/\s+/g, ' ').trim();
  if (/[a-z]/.test(value)) return value;
  return value.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function smartTitleCase(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  if (SKILL_CASE[key]) return SKILL_CASE[key];
  return key.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function findResumeName(lines) {
  const limit = Math.min(lines.length, 12);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (isSectionHeading(line) || hasJobWord(line) || looksLikeContact(line)) continue;
    if (/[0-9@/\\|]/.test(line)) continue;

    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((word) => /^[A-Za-z][A-Za-z.'’-]*$/.test(word))) continue;

    const letters = line.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) continue;

    const allCaps = !/[a-z]/.test(line);
    if (!allCaps && !/^[A-Z]/.test(words[0])) continue;

    return { name: smartNameCase(line), index: i };
  }
  return { name: '', index: -1 };
}

function findResumeHeadline(lines, nameIndex) {
  const limit = Math.min(lines.length, nameIndex + 6);
  for (let i = nameIndex + 1; i < limit; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (isSectionHeading(line)) break;
    if (looksLikeContact(line) || hasJobWord(line)) continue;
    if (line.length < 3 || line.length > 90) continue;
    if (!/[A-Za-z]/.test(line)) continue;
    return line.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function findEmail(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].replace(/[.,;]+$/, '') : '';
}

function findPhone(headerLines) {
  for (const line of headerLines) {
    if (/^\s*(?:19|20)\d{2}\b/.test(line)) continue;
    if (/\b(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}\b/.test(line)) continue;

    const matches = line.match(/\+?\(?\d[\d\s().-]{6,}\d/g) || [];
    for (const raw of matches) {
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) continue;
      return raw.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function normalizeLink(value) {
  let url = String(value || '').trim().replace(/[.,;)\]]+$/, '');
  if (!url) return '';
  url = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return url.replace(/\/+$/, '');
}

function findLinks(headerText) {
  const links = { linkedin: '', github: '', website: '' };
  const text = String(headerText || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ');

  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_%.-]+/i);
  if (linkedin) links.linkedin = normalizeLink(linkedin[0]);

  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_.-]+/i);
  if (github) links.github = normalizeLink(github[0]);

  const urls = text.match(/(?:https?:\/\/|www\.)[^\s|,;]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?[^\s|,;]*/gi) || [];
  for (const url of urls) {
    const normalized = normalizeLink(url);
    if (!normalized) continue;
    if (/linkedin\.com|github\.com/i.test(normalized)) continue;
    if (!links.website) links.website = normalized;
  }

  return links;
}

function findLocation(headerLines) {
  for (const line of headerLines) {
    const match = line.match(/\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}),\s*([A-Z][A-Za-z.'-]+(?:\s[A-Z][A-Za-z.'-]+)?)\b/);
    if (!match) continue;
    if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(match[1])) continue;
    const remote = /\bremote\b/i.test(line) ? ' · open to remote' : '';
    return match[1] + ', ' + match[2] + remote;
  }
  if (/\bremote\b/i.test(headerLines.join(' '))) return 'Remote';
  return '';
}

function findResumeSection(lines, aliases) {
  const start = lines.findIndex((line) => aliases.includes(headingKey(line)));
  if (start === -1) return '';

  const collected = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isSectionHeading(line)) break;
    if (line) collected.push(line);
    if (collected.length >= 12) break;
  }
  return collected.join('\n');
}

function findSummary(lines) {
  const raw = findResumeSection(lines, RESUME_SECTION_ALIASES.summary);
  if (!raw) return '';

  const cleaned = raw
    .split('\n')
    .map((line) => line.replace(/^[-•·*]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 40) return '';
  return cleaned.slice(0, 700).trim();
}

function findSkills(text, lines) {
  const skills = [];
  const add = (value) => {
    const skill = String(value || '').replace(/^[-•·*]\s*/, '').trim();
    if (!skill || skill.length > 40) return;
    if (skill.split(/\s+/).length > 4) return;
    if (skills.some((item) => item.toLowerCase() === skill.toLowerCase())) return;
    skills.push(skill);
  };

  findResumeSection(lines, RESUME_SECTION_ALIASES.skills)
    .split(/[,\n;|•·]+/)
    .forEach(add);

  if (skills.length >= 3) return skills.slice(0, 30);

  const haystack = String(text || '').toLowerCase();
  SKILL_WORDS
    .filter((word) => haystack.includes(word))
    .map(smartTitleCase)
    .forEach(add);

  return skills.slice(0, 20);
}

function parseResumeProfile(text) {
  const lines = normalizeWhitespace(text).split('\n').map((line) => line.trim());
  const headerLines = lines.filter(Boolean).slice(0, 14);
  const headerText = headerLines.join('\n');
  const { name, index } = findResumeName(lines);

  return {
    name,
    headline: index === -1 ? '' : findResumeHeadline(lines, index),
    email: findEmail(headerText),
    phone: findPhone(headerLines),
    location: findLocation(headerLines),
    links: findLinks(headerText),
    summary: findSummary(lines),
    skills: findSkills(text, lines)
  };
}

function importProfileFromResume(text) {
  const parsed = parseResumeProfile(text);
  const profile = state.profile;
  const changed = [];

  const apply = (label, value, setter) => {
    if (!value) return;
    setter(value);
    changed.push(label);
  };

  apply('name', parsed.name, (value) => { profile.name = value; });
  apply('headline', parsed.headline, (value) => { profile.headline = value; });
  apply('email', parsed.email, (value) => { profile.email = value; });
  apply('phone', parsed.phone, (value) => { profile.phone = value; });
  apply('location', parsed.location, (value) => { profile.location = value; });
  apply('summary', parsed.summary, (value) => { profile.summary = value; });

  if (parsed.skills.length) {
    profile.skills = parsed.skills;
    changed.push('skills');
  }

  ['linkedin', 'github', 'website'].forEach((key) => {
    apply(key, parsed.links[key], (value) => { profile.links[key] = value; });
  });

  if (changed.length) saveProfile();
  return { parsed, changed };
}

function syncParsedFieldsToForm(parsed) {
  const set = (id, value) => {
    if (!value) return;
    const el = $('#' + id);
    if (el) el.value = value;
  };
  set('profileName', parsed.name);
  set('profileHeadline', parsed.headline);
  set('profileEmail', parsed.email);
  set('profilePhone', parsed.phone);
  set('profileLocation', parsed.location);
  set('profileLinkedin', parsed.links.linkedin);
  set('profileGithub', parsed.links.github);
  set('profileWebsite', parsed.links.website);
  set('profileSummary', parsed.summary);
  if (parsed.skills.length) set('profileSkills', parsed.skills.join(', '));
}

// ---------------------------------------------------------------- Resume file parsing

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (window[globalName]) resolve(window[globalName]);
      else reject(new Error('Library failed to load'));
    };
    script.onerror = () => reject(new Error('Could not load the file reader'));
    document.head.appendChild(script);
  });
}

async function extractResumeText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return await file.text();
  }
  if (name.endsWith('.docx')) {
    return await extractDocx(file);
  }
  if (name.endsWith('.pdf')) {
    return await extractPdf(file);
  }
  if (name.endsWith('.doc')) {
    throw new Error('Legacy .doc files are not supported. Save as .docx or paste the text.');
  }
  throw new Error('Unsupported file type. Use PDF, DOCX, TXT, or MD.');
}

async function extractDocx(file) {
  const JSZip = await loadScript(
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'JSZip'
  );
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('That DOCX has no readable document body.');
  const xml = await doc.async('string');

  const paragraphs = xml.split(/<\/w:p>/).map((block) => {
    const chunks = Array.from(block.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g))
      .map((match) => decodeXmlEntities(match[1]));
    return chunks.join('');
  }).filter((line) => line.trim());

  return paragraphs.join('\n');
}

async function extractPdf(file) {
  const pdfjsLib = await loadScript(
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    'pdfjsLib'
  );
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  const data = new Uint8Array(await file.arrayBuffer());
  const documentProxy = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let i = 1; i <= documentProxy.numPages; i += 1) {
    const page = await documentProxy.getPage(i);
    const content = await page.getTextContent();
    pages.push(pdfItemsToLines(content.items));
  }

  return pages.join('\n\n');
}

// pdf.js returns loose text items. Group them into visual lines so headings,
// names, and contact rows stay on their own lines for parsing.
function pdfItemsToLines(items) {
  const rows = [];

  items.forEach((item) => {
    if (!item.str || !item.str.trim() || !item.transform) return;
    const y = item.transform[5];
    const x = item.transform[4];
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2.5);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, text: item.str });
  });

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => row.parts
      .sort((a, b) => a.x - b.x)
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------- Modals

let lastFocused = null;

function openModal(modal) {
  if (!modal) return;
  lastFocused = document.activeElement;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  const focusable = modal.querySelector('input, textarea, select, button');
  if (focusable) setTimeout(() => focusable.focus(), 60);
}

function closeModal(modal) {
  if (!modal) return;
  modal.hidden = true;
  if (!$$('.modal').some((item) => !item.hidden)) {
    document.body.classList.remove('modal-open');
  }
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
}

function closeTopModal() {
  const open = $$('.modal').filter((modal) => !modal.hidden);
  if (open.length) closeModal(open[open.length - 1]);
}

// ---------------------------------------------------------------- Add job

let currentDetailId = null;

function openAddJob() {
  if (!state.profile.resumeText) {
    toast('Add your resume first, then knomad can tailor it.', 'error');
    showPage('profile');
    const field = $('#profileResumeText');
    if (field) setTimeout(() => field.focus(), 200);
    return;
  }
  resetAddJob();
  openModal($('#addJobModal'));
}

function resetAddJob() {
  const form = $('#addJobForm');
  if (form) form.reset();
  const wrap = $('#addJobFormWrap');
  if (wrap) wrap.hidden = false;
  const progress = $('#jobProgress');
  if (progress) progress.hidden = true;
  const error = $('#jobError');
  if (error) error.hidden = true;

  $$('#addJobModal details').forEach((details) => {
    details.open = false;
  });

  $$('#stepList li').forEach((item) => {
    item.classList.remove('running', 'done', 'error');
    const note = item.querySelector('.step-note');
    if (note) note.textContent = '';
  });
}

function setStep(key, status, note) {
  const item = $('#stepList [data-step="' + key + '"]');
  if (!item) return;
  item.classList.remove('running', 'done', 'error');
  item.classList.add(status);
  if (note != null) {
    const node = item.querySelector('.step-note');
    if (node) node.textContent = note;
  }
}

function failRunningStep() {
  const running = $('#stepList li.running');
  if (!running) return;
  const key = running.dataset.step;
  setStep(key, 'error', 'failed');
}

async function handleAddJobSubmit(event) {
  event.preventDefault();

  const urlInput = $('#jobUrl');
  const pasteInput = $('#jobPaste');
  const rawUrl = urlInput.value.trim();
  const pasted = pasteInput.value.trim();

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    toast('Enter a full job link, including https://', 'error');
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    toast('Only http and https links are supported', 'error');
    return;
  }

  if (!state.profile.resumeText) {
    toast('Add your resume first', 'error');
    return;
  }

  $('#addJobFormWrap').hidden = true;
  $('#jobProgress').hidden = false;
  $('#jobError').hidden = true;
  $('#progressUrl').textContent = rawUrl;

  try {
    setStep('read', 'running');
    let page = null;

    if (pasted) {
      page = { text: pasted, html: '', via: 'paste' };
      setStep('read', 'done', 'pasted text');
    } else {
      page = await fetchJobPage(rawUrl);
      setStep('read', 'done', page.via);
    }

    const job = extractJobInfo(page, rawUrl);

    setStep('tailor', 'running');
    const pack = await buildJobPack({
      company: job.company,
      position: job.position,
      description: job.description,
      url: rawUrl
    });
    setStep('tailor', 'done', pack.source === 'ai' ? 'Gemini' : 'basic mode');

    setStep('save', 'running');
    const now = new Date().toISOString();
    const application = {
      id: makeId(),
      company: pack.company || job.company || 'Unknown company',
      position: pack.position || job.position || 'Untitled role',
      status: 'applied',
      url: rawUrl,
      notes: '',
      dateApplied: now,
      statusHistory: [{ status: 'applied', at: now }],
      events: [],
      interviewSession: emptyPractice(),
      resume: pack.resume || '',
      interviewPrep: pack.interviewPrep || '',
      jobDescription: job.description || ''
    };

    state.applications.unshift(application);
    saveApplications();
    setStep('save', 'done', 'saved');
    renderDashboard();
    renderTracker();

    setTimeout(() => {
      closeModal($('#addJobModal'));
      openDetail(application.id);
      resetAddJob();
    }, 550);

    if (pack.source === 'ai') {
      toast('Application tailored and filed');
    } else if (pack.aiError) {
      toast('Gemini failed, so knomad saved a basic draft. Check your key in Settings.', 'error');
    } else {
      toast('Saved in basic mode. Add a Gemini key for full rewrites.');
    }
  } catch (err) {
    failRunningStep();
    const errorBox = $('#jobError');
    const errorText = $('#jobErrorText');
    if (errorText) {
      errorText.textContent = err && err.message
        ? err.message
        : 'Something went wrong while reading that page.';
    }
    if (errorBox) errorBox.hidden = false;
  }
}

// ---------------------------------------------------------------- Page fetching

async function fetchJobPage(url) {
  const attempts = [
    {
      via: 'direct',
      run: async () => {
        const response = await fetchWithTimeout(url, { redirect: 'follow' }, 9000);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const html = await response.text();
        return { html, text: htmlToText(html) };
      }
    },
    {
      via: 'reader proxy',
      run: async () => {
        const response = await fetchWithTimeout(
          'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
          {},
          15000
        );
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const html = await response.text();
        return { html, text: htmlToText(html) };
      }
    },
    {
      via: 'reader proxy',
      run: async () => {
        const response = await fetchWithTimeout('https://r.jina.ai/' + url, {}, 20000);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const text = await response.text();
        return { html: '', text: normalizeWhitespace(text) };
      }
    }
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      if (result.text && result.text.length > 180) {
        return { ...result, via: attempt.via };
      }
      console.warn('Page reader returned too little text:', attempt.via);
    } catch (err) {
      console.warn('Page reader failed:', attempt.via, err);
    }
  }

  throw new Error(
    'Could not read that page. It may block automated readers — paste the description instead and try again.'
  );
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, svg, iframe, nav, footer').forEach((node) => node.remove());
  const main = doc.querySelector('main, article, [role="main"]') || doc.body;
  return normalizeWhitespace(main ? main.textContent : '');
}

function extractJobInfo(page, url) {
  let company = '';
  let position = '';
  let description = page.text || '';

  if (page.html) {
    const doc = new DOMParser().parseFromString(page.html, 'text/html');

    const posting = readJsonLd(doc).find((entry) => hasType(entry, 'JobPosting'));
    if (posting) {
      position = typeof posting.title === 'string' ? posting.title : '';
      const org = posting.hiringOrganization;
      if (org && typeof org === 'object') company = org.name || '';
      else if (typeof org === 'string') company = org;
      if (posting.description) {
        const rich = stripHtml(posting.description);
        if (rich.length > 80) description = rich;
      }
    }

    if (!company) company = metaContent(doc, 'og:site_name');
    if (!position) {
      position = metaContent(doc, 'og:title') || (doc.title || '');
    }
  }

  if (!company || !position) {
    const fromText = parseTitleLines(page.text || '');
    if (!company) company = fromText.company;
    if (!position) position = fromText.position;
  }

  const derived = deriveFromTitle(position);
  if (!company && derived.company) company = derived.company;
  if (derived.position) position = derived.position;

  company = cleanCompany(company) || companyFromDomain(url);
  position = cleanPosition(position) || 'Unknown role';

  return { company, position, description: description.slice(0, 24000) };
}

function readJsonLd(doc) {
  const entries = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      collectJsonLd(JSON.parse(script.textContent), entries);
    } catch (err) { /* ignore malformed blocks */ }
  });
  return entries;
}

function collectJsonLd(data, out) {
  if (!data) return;
  if (Array.isArray(data)) {
    data.forEach((item) => collectJsonLd(item, out));
    return;
  }
  if (typeof data !== 'object') return;
  out.push(data);
  if (data['@graph']) collectJsonLd(data['@graph'], out);
}

function hasType(entry, type) {
  const value = entry && entry['@type'];
  if (!value) return false;
  return Array.isArray(value) ? value.includes(type) : value === type;
}

function metaContent(doc, property) {
  const node = doc.querySelector('meta[property="' + property + '"]') ||
    doc.querySelector('meta[name="' + property + '"]');
  return node ? (node.getAttribute('content') || '').trim() : '';
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
  return normalizeWhitespace(doc.body ? doc.body.textContent : '');
}

function parseTitleLines(text) {
  const companyMatch = text.match(/^\s*Company:\s*(.+)$/mi);
  const titleMatch = text.match(/^\s*Title:\s*(.+)$/mi);
  return {
    company: companyMatch ? companyMatch[1].trim() : '',
    position: titleMatch ? titleMatch[1].trim() : ''
  };
}

function deriveFromTitle(raw) {
  let title = String(raw || '').replace(/\s+/g, ' ').trim();
  title = title.split(/\s+[|•]\s+/)[0].trim();
  title = title.replace(/\s*\((?:remote|hybrid|on[- ]site)[^)]*\)\s*$/i, '').trim();

  let company = '';
  let position = title;

  const atMatch = title.match(/^(.{3,90})\s+(?:at|@)\s+(.{2,60})$/i);
  if (atMatch) {
    position = atMatch[1].trim();
    company = atMatch[2].trim();
  }

  return { company, position };
}

function cleanCompany(value) {
  return String(value || '')
    .replace(/\s*[|–—-]\s*(careers?|jobs?|hiring|job board)\s*$/i, '')
    .replace(/\s+(careers?|jobs?)\s*$/i, '')
    .trim()
    .slice(0, 80);
}

function cleanPosition(value) {
  return String(value || '')
    .replace(/^(job application for|apply for|apply to|careers? at|jobs? at)\s+/i, '')
    .replace(/\s*[|–—]\s*.+$/, '')
    .trim()
    .slice(0, 120);
}

function companyFromDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const base = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    const generic = ['linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'monster', 'lever', 'greenhouse', 'workday'];
    if (generic.includes(base)) return 'Unknown company';
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch (err) {
    return 'Unknown company';
  }
}

// ---------------------------------------------------------------- Gemini

async function buildJobPack(job) {
  const key = state.geminiKey.trim();
  if (!key) {
    return { ...fallbackPack(job), source: 'basic' };
  }
  try {
    const pack = await generateWithGemini(job, key);
    return { ...pack, source: 'ai' };
  } catch (err) {
    console.warn('Gemini request failed', err);
    return { ...fallbackPack(job), source: 'basic', aiError: err.message };
  }
}

function profileHeader(profile) {
  const lines = [];
  if (profile.name) lines.push(profile.name);
  if (profile.headline) lines.push(profile.headline);

  const contact = [
    profile.email,
    profile.phone,
    profile.location,
    profile.links ? profile.links.linkedin : '',
    profile.links ? profile.links.github : '',
    profile.links ? profile.links.website : ''
  ].filter(Boolean);

  if (contact.length) lines.push(contact.join(' · '));
  return lines.join('\n');
}

function buildPrompt(job) {
  const profile = state.profile;
  const links = profile.links || {};
  const header = profileHeader(profile);
  const profileBlock = [
    'Full name: ' + (profile.name || '—'),
    'Headline: ' + (profile.headline || '—'),
    'Email: ' + (profile.email || '—'),
    'Phone: ' + (profile.phone || '—'),
    'Location: ' + (profile.location || '—'),
    'LinkedIn: ' + (links.linkedin || '—'),
    'GitHub: ' + (links.github || '—'),
    'Portfolio: ' + (links.website || '—'),
    'Summary: ' + (profile.summary || '—'),
    'Skills: ' + ((profile.skills || []).join(', ') || '—')
  ].join('\n');

  return [
    'You are an expert resume writer and interview coach. Tailor the candidate’s resume to the job posting and prepare interview material.',
    '',
    'Rules:',
    '- Never invent employers, job titles, dates, degrees, certifications, or metrics.',
    '- Rephrase, reorder, and emphasize real experience. Only include a keyword if the candidate’s resume already supports it.',
    '- Keep the resume factual and plain text. Use ALL-CAPS section headings. No markdown symbols such as ** or #.',
    '- Open the resume with this exact header block, copied verbatim as the first lines. Never alter spelling, email, phone, or links:',
    header || '(no profile header available)',
    '- Draw all facts from the candidate profile and base resume together. If a detail is not in either, leave it out.',
    '- Interview prep must be plain text with three sections in this order: LIKELY QUESTIONS, QUESTIONS TO ASK, TOPICS TO REVIEW.',
    '- Under LIKELY QUESTIONS, write exactly 6 numbered questions in the form "1. Question?" and put a "Talking point: ..." line under each one.',
    '- Under QUESTIONS TO ASK, write 3 numbered questions. Under TOPICS TO REVIEW, write 5 bullet points starting with "- ".',
    '',
    'CANDIDATE PROFILE',
    profileBlock,
    '',
    'BASE RESUME',
    (profile.resumeText || '').slice(0, 20000),
    '',
    'JOB POSTING',
    'URL: ' + job.url,
    'Company (detected): ' + (job.company || 'unknown'),
    'Role (detected): ' + (job.position || 'unknown'),
    'Description:',
    (job.description || '').slice(0, 20000),
    '',
    'Return ONLY valid JSON in this exact shape:',
    '{"company":"","position":"","resume":"","interviewPrep":""}',
    'If the company or role is unclear, infer the most likely answer from the posting.'
  ].join('\n');
}

async function generateWithGemini(job, key) {
  const prompt = buildPrompt(job);
  const text = await geminiRequest(prompt, key);
  const parsed = parseJsonBlock(text);

  if (!parsed || (!parsed.resume && !parsed.interviewPrep)) {
    throw new Error('Gemini returned an empty result');
  }

  return {
    company: String(parsed.company || job.company || 'Unknown company').trim(),
    position: String(parsed.position || job.position || 'Unknown role').trim(),
    resume: ensureResumeHeader(String(parsed.resume || '').trim(), state.profile),
    interviewPrep: String(parsed.interviewPrep || '').trim()
  };
}

function ensureResumeHeader(resume, profile) {
  const header = profileHeader(profile);
  if (!header || !resume) return resume;

  const lower = resume.toLowerCase();
  const hasName = profile.name && lower.includes(profile.name.toLowerCase());
  const hasEmail = profile.email && lower.includes(profile.email.toLowerCase());
  if (hasName || hasEmail) return resume;

  return header + '\n\n' + resume;
}

async function geminiRequest(prompt, key) {
  const models = workingModel
    ? [workingModel, ...GEMINI_MODELS.filter((model) => model !== workingModel)]
    : GEMINI_MODELS;

  let lastError = null;

  for (const model of models) {
    try {
      const response = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.4,
              responseMimeType: 'application/json'
            }
          })
        },
        60000
      );

      if (!response.ok) {
        lastError = new Error(model + ' returned HTTP ' + response.status);
        continue;
      }

      const data = await response.json();
      const candidate = data && data.candidates && data.candidates[0];
      const parts = candidate && candidate.content && candidate.content.parts;
      const text = Array.isArray(parts) ? parts.map((part) => part.text || '').join('') : '';

      if (!text.trim()) {
        lastError = new Error(model + ' returned no text');
        continue;
      }

      workingModel = model;
      return text;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Gemini request failed');
}

function parseJsonBlock(text) {
  let value = String(text || '').trim();
  value = value.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Gemini did not return JSON');
  return JSON.parse(value.slice(start, end + 1));
}

// ---------------------------------------------------------------- Basic mode

function findKeywords(text) {
  const haystack = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9+#./\s-]/g, ' ').replace(/\s+/g, ' ') + ' ';
  return SKILL_WORDS.filter((word) => haystack.includes(word));
}

function fallbackPack(job) {
  const profile = state.profile;
  const keywords = findKeywords((job.description || '') + ' ' + (job.position || ''));
  const source = profile.resumeText || '';
  const lowerSource = source.toLowerCase();
  const matched = keywords.filter((word) => lowerSource.includes(word));
  const missing = keywords.filter((word) => !matched.includes(word));

  return {
    company: job.company || 'Unknown company',
    position: job.position || 'Unknown role',
    resume: fallbackResume(profile, source, job, keywords, matched, missing),
    interviewPrep: fallbackInterviewPrep(job, keywords, profile)
  };
}

function fallbackResume(profile, source, job, keywords, matched, missing) {
  const header = profileHeader(profile);
  const target = (job.position || 'this role') + (job.company ? ' at ' + job.company : '');

  return [
    header ? header + '\n\n' + source : source,
    '',
    '---',
    'BASIC MODE NOTES',
    'Target: ' + target,
    'Posting keywords: ' + (keywords.length ? keywords.join(', ') : 'none detected'),
    'Already on your resume: ' + (matched.length ? matched.join(', ') : 'none of the detected keywords'),
    'Worth adding only if true: ' + (missing.length ? missing.join(', ') : 'nothing obvious'),
    'Add a Gemini key in Settings for a full rewrite.'
  ].join('\n');
}

function fallbackInterviewPrep(job, keywords, profile) {
  const company = job.company || 'the company';
  const role = job.position || 'this role';
  const name = firstName(profile.name) || 'your background';

  const questions = [
    'Walk me through ' + name + ' and why ' + role + ' is the right next move.',
    'Which parts of this posting map most directly to work you have already done?',
    'Describe a project you owned end to end. What did you decide, and what changed because of it?',
    'Tell me about a time you had to learn something quickly. How did you approach it?',
    'Where have you disagreed with a teammate or stakeholder? How did you resolve it?',
    'Why ' + company + ', and what would you want to accomplish in your first 90 days?'
  ];

  const lines = [
    'LIKELY QUESTIONS',
    ...questions.map((question, index) => (index + 1) + '. ' + question + '\n   Talking point: connect it to a concrete example from your resume and end with the result.'),
    '',
    'QUESTIONS TO ASK',
    '1. What does success look like for this role in the first six months?',
    '2. How does the team decide what to prioritize when trade-offs come up?',
    '3. What is the biggest constraint the team is working against right now?',
    '',
    'TOPICS TO REVIEW',
    keywords.length
      ? keywords.slice(0, 10).map((word) => '- ' + word).join('\n')
      : '- Re-read the posting and note every tool, process, and outcome it names.',
    '',
    'Generated in basic mode. Add a Gemini key in Settings for a tailored version.'
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------- Application page

let applicationTab = 'overview';
let renderedApplicationId = null;
let practiceSaveTimer = null;

function openDetail(id) {
  const application = state.applications.find((app) => String(app.id) === String(id));
  if (!application) return;

  if (currentPage !== 'application') {
    applicationReturnPage = currentPage;
  } else {
    applicationReturnPage = 'dashboard';
  }

  currentDetailId = application.id;
  applicationTab = 'overview';
  showPage('application');
}

function renderApplication() {
  const application = state.applications.find((app) => String(app.id) === String(currentDetailId));
  if (!application) {
    showPage(applicationReturnPage || 'dashboard');
    return;
  }

  $('#detailCompany').textContent = application.company || 'Unknown company';
  $('#detailPosition').textContent = application.position || 'Untitled role';
  $('#detailStatus').value = application.status;
  $('#detailDate').textContent = 'Applied ' + (formatDate(application.dateApplied) || '—');
  $('#detailNotes').value = application.notes || '';
  $('#detailJD').textContent = application.jobDescription || 'No job description saved.';
  $('#detailResume').textContent = application.resume || '';
  $('#detailPrep').textContent = application.interviewPrep || 'No interview brief saved.';

  const resumeMeta = $('#resumeMetaLine');
  if (resumeMeta) {
    resumeMeta.textContent = application.resume
      ? wordCount(application.resume) + ' words · tailored for ' + (application.position || 'this role') + (application.company ? ' at ' + application.company : '')
      : 'No tailored resume saved yet.';
  }

  const link = $('#detailLink');
  if (application.url) {
    link.href = application.url;
    link.hidden = false;
  } else {
    link.hidden = true;
  }

  if (String(renderedApplicationId) !== String(application.id)) {
    const eventForm = $('#eventForm');
    if (eventForm) {
      eventForm.reset();
      const atInput = $('#eventAt');
      if (atInput) atInput.value = defaultEventValue();
    }
    renderedApplicationId = application.id;
  }

  renderDetailEvents();
  renderResumePreview(application.resume);
  setApplicationTab(applicationTab);
}

function setApplicationTab(tab) {
  const valid = ['overview', 'resume', 'practice'];
  const target = valid.includes(tab) ? tab : 'overview';
  if (applicationTab !== target && target !== 'practice') savePracticeAnswer();
  applicationTab = target;

  $$('.app-tab').forEach((button) => {
    const active = button.dataset.appTab === target;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  $$('.app-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.appPanel === target);
  });

  if (target === 'practice') renderPractice();
}

function currentApplication() {
  return state.applications.find((app) => String(app.id) === String(currentDetailId)) || null;
}

// ---------------------------------------------------------------- Resume document

const RESUME_HEADING_WORDS = [
  'summary', 'profile', 'objective', 'about', 'about me', 'experience', 'work experience',
  'professional experience', 'relevant experience', 'employment', 'employment history',
  'education', 'skills', 'technical skills', 'core skills', 'core competencies',
  'projects', 'project experience', 'selected projects', 'certifications', 'certificates',
  'licenses', 'awards', 'honors', 'publications', 'volunteer', 'volunteering',
  'leadership', 'activities', 'interests', 'languages', 'additional information',
  'additional experience', 'professional development', 'training'
];

function cleanResumeHeading(line) {
  return String(line || '')
    .replace(/^[\s#]+/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function isKnownResumeHeading(line) {
  const text = cleanResumeHeading(line);
  return Boolean(text) && RESUME_HEADING_WORDS.includes(text.toLowerCase());
}

const RESUME_HEADING_HINTS = [
  'summary', 'profile', 'objective', 'experience', 'employment', 'education', 'skill',
  'project', 'certification', 'award', 'honor', 'publication', 'volunteer', 'leadership',
  'activit', 'interest', 'language', 'training', 'reference', 'highlight', 'achievement',
  'expertise', 'competenc', 'strength', 'coursework'
];

function resumeHeadingTitle(line) {
  const text = cleanResumeHeading(line);
  if (!text || text.length > 64) return '';
  if (/^[-•*–—]/.test(text)) return '';
  if (isKnownResumeHeading(text)) return text.toUpperCase();
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return '';
  if (/[@·]|https?:|\d{2,}/.test(text)) return '';
  if (letters !== letters.toUpperCase() || /[a-z]/.test(text)) return '';
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!words.length || words.length > 4) return '';
  const sectionLike = RESUME_HEADING_HINTS.some((hint) =>
    words.some((word) => word.length >= 4 && (word.startsWith(hint) || hint.startsWith(word)))
  );
  return sectionLike ? text : '';
}

function parseResumeDocument(text) {
  const result = { header: { name: '', headline: '', contact: [] }, sections: [], notes: [] };
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return result;

  const allLines = raw.split('\n');
  const divider = allLines.findIndex((line, index) =>
    /^\s*---+\s*$/.test(line) && /^basic mode/i.test((allLines[index + 1] || '').trim())
  );
  const mainLines = (divider >= 0 ? allLines.slice(0, divider) : allLines).map((line) => line.replace(/\s+$/, ''));
  const noteLines = divider >= 0 ? allLines.slice(divider + 1) : [];

  let headerLines = [];
  let bodyStart = 0;

  const firstKnownHeading = mainLines.slice(0, 8).findIndex((line) => isKnownResumeHeading(line.trim()));
  const blankIndex = mainLines.findIndex((line) => !line.trim());

  if (firstKnownHeading > 0) {
    headerLines = mainLines.slice(0, firstKnownHeading).map((line) => line.trim()).filter(Boolean);
    bodyStart = firstKnownHeading;
  } else if (firstKnownHeading < 0 && blankIndex >= 0) {
    headerLines = mainLines.slice(0, blankIndex).map((line) => line.trim()).filter(Boolean);
    bodyStart = blankIndex + 1;
  } else if (firstKnownHeading < 0) {
    headerLines = mainLines.map((line) => line.trim()).filter(Boolean);
    bodyStart = mainLines.length;
  }

  if (headerLines.length > 4) {
    headerLines = [];
    bodyStart = 0;
  }

  headerLines.forEach((line, index) => {
    if (index === 0) {
      result.header.name = line;
      return;
    }
    const contactLike = /@|https?:|www\.|linkedin|github|\d{5,}|·|\|/i.test(line);
    if (contactLike) {
      result.header.contact.push(
        ...line.split(/\s*[·|•]\s*/).map((part) => part.trim()).filter(Boolean)
      );
    } else if (!result.header.headline) {
      result.header.headline = line;
    } else {
      result.header.contact.push(line);
    }
  });

  let current = null;
  let paragraph = [];
  let bodyHasContent = false;
  const headerTokens = new Set(
    headerLines
      .concat([result.header.name, result.header.headline, ...result.header.contact])
      .filter(Boolean)
      .map((value) => value.toLowerCase())
  );

  const ensureSection = () => {
    if (!current) {
      current = { title: '', items: [] };
      result.sections.push(current);
    }
    return current;
  };

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const value = paragraph.join(' ').trim();
    paragraph = [];
    if (value) ensureSection().items.push({ type: 'p', text: value });
  };

  for (let i = bodyStart; i < mainLines.length; i += 1) {
    const line = mainLines[i].trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    if (!bodyHasContent) {
      if (!current && headerTokens.has(line.toLowerCase())) continue;
      bodyHasContent = true;
    }

    const title = resumeHeadingTitle(line);
    if (title) {
      flushParagraph();
      current = { title, items: [] };
      result.sections.push(current);
      continue;
    }

    if (/^[-•*–—]\s+/.test(line)) {
      flushParagraph();
      ensureSection().items.push({
        type: 'li',
        text: line.replace(/^[-•*–—]\s+/, '').trim()
      });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();

  result.sections = result.sections.filter((section) => section.title || section.items.length);
  result.notes = noteLines.map((line) => line.trim()).filter(Boolean);
  return result;
}

function resumeContactFallback() {
  const profile = state.profile;
  const links = profile.links || {};
  return [profile.email, profile.phone, profile.location, links.linkedin, links.github, links.website]
    .filter(Boolean);
}

function resumePreviewHtml(model) {
  const profile = state.profile;
  const name = model.header.name || profile.name || 'Your name';
  const headline = model.header.headline || profile.headline || '';
  const contact = model.header.contact.length ? model.header.contact : resumeContactFallback();

  const parts = ['<article class="resume-doc">', '<header class="resume-head">'];
  parts.push('<h1>' + escapeHtml(name) + '</h1>');
  if (headline) parts.push('<p class="resume-headline">' + escapeHtml(headline) + '</p>');
  if (contact.length) {
    parts.push('<div class="resume-contact">' +
      contact.map((item) => '<span>' + escapeHtml(item) + '</span>').join('') +
      '</div>');
  }
  parts.push('</header>', '<div class="resume-body">');

  model.sections.forEach((section) => {
    if (!section.title && !section.items.length) return;
    parts.push('<section>');
    if (section.title) parts.push('<h2>' + escapeHtml(section.title) + '</h2>');

    let inList = false;
    section.items.forEach((item) => {
      if (item.type === 'li') {
        if (!inList) {
          parts.push('<ul>');
          inList = true;
        }
        parts.push('<li>' + escapeHtml(item.text) + '</li>');
      } else {
        if (inList) {
          parts.push('</ul>');
          inList = false;
        }
        parts.push('<p>' + escapeHtml(item.text) + '</p>');
      }
    });
    if (inList) parts.push('</ul>');
    parts.push('</section>');
  });

  parts.push('</div></article>');
  return parts.join('');
}

function renderResumePreview(text) {
  const host = $('#resumePreview');
  if (!host) return;

  const model = parseResumeDocument(text);
  const hasContent = model.header.name || model.header.headline || model.header.contact.length ||
    model.sections.some((section) => section.items.length);

  host.innerHTML = hasContent
    ? resumePreviewHtml(model)
    : '<div class="resume-empty"><span>No tailored resume saved yet.</span><span>Add a job to generate one.</span></div>';
}

function slugifyFilename(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function resumeFileBase(application) {
  const parts = [
    state.profile.name || 'resume',
    application.company,
    application.position
  ].map(slugifyFilename).filter(Boolean);
  return parts.length ? parts.join('-') : 'knomad-resume';
}

async function buildResumePdf(application) {
  await loadScript(PDF_LIB_URL, 'jspdf');
  const lib = window.jspdf;
  const JsPDF = lib && (lib.jsPDF || lib);
  if (typeof JsPDF !== 'function') throw new Error('PDF library unavailable');

  const model = parseResumeDocument(application.resume);
  const doc = new JsPDF({ unit: 'pt', format: 'letter', compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 54;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const setText = (size, style, color) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
  };

  const ensureSpace = (height) => {
    if (y + height <= pageHeight - margin) return;
    doc.addPage();
    y = margin;
  };

  const drawText = (value, options = {}) => {
    const text = String(value || '').trim();
    if (!text) return;
    const size = options.size || 10;
    const style = options.style || 'normal';
    const color = options.color || [27, 42, 38];
    const indent = options.indent || 0;
    const leading = options.leading || 1.45;
    const gap = options.gap || 0;
    const bullet = Boolean(options.bullet);

    setText(size, style, color);
    const lineHeight = size * leading;
    const lines = doc.splitTextToSize(text, contentWidth - indent);
    lines.forEach((line, index) => {
      ensureSpace(lineHeight);
      if (bullet && index === 0) doc.text('•', margin + 2, y + size);
      doc.text(line, margin + indent, y + size);
      y += lineHeight;
    });
    y += gap;
  };

  const profile = state.profile;
  const name = model.header.name || profile.name || 'Your Name';
  const headline = model.header.headline || profile.headline || '';
  const contact = model.header.contact.length ? model.header.contact : resumeContactFallback();

  drawText(name, { size: 22, style: 'bold', color: [16, 35, 30], leading: 1.08, gap: 2 });
  if (headline) {
    drawText(headline, { size: 10.5, style: 'bold', color: [53, 104, 94], leading: 1.3, gap: 2 });
  }
  if (contact.length) {
    drawText(contact.join('   ·   '), { size: 8.5, color: [91, 111, 105], leading: 1.35, gap: 9 });
  }

  ensureSpace(18);
  doc.setDrawColor(215, 225, 220);
  doc.setLineWidth(0.8);
  doc.line(margin, y, pageWidth - margin, y);
  y += 18;

  model.sections.forEach((section) => {
    if (section.title) {
      ensureSpace(30);
      setText(9, 'bold', [15, 118, 110]);
      doc.text(section.title.toUpperCase(), margin, y + 9);
      y += 13;
      doc.setDrawColor(215, 225, 220);
      doc.setLineWidth(0.7);
      doc.line(margin, y, pageWidth - margin, y);
      y += 11;
    }

    section.items.forEach((item) => {
      if (item.type === 'li') {
        drawText(item.text, { size: 9.8, indent: 14, leading: 1.42, bullet: true, gap: 1.5 });
      } else {
        drawText(item.text, { size: 9.8, leading: 1.45, gap: 2 });
      }
    });

    if (section.items.length) y += 7;
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    setText(7.5, 'normal', [140, 150, 146]);
    doc.text('knomad · ' + page + ' / ' + pageCount, pageWidth - margin, pageHeight - 24, { align: 'right' });
  }

  doc.setProperties({
    title: [application.position, application.company].filter(Boolean).join(' · ') || 'Resume',
    subject: 'Resume tailored with knomad',
    creator: 'knomad'
  });

  return doc;
}

async function downloadResumePdf() {
  const application = currentApplication();
  if (!application || !application.resume.trim()) {
    toast('No tailored resume to download', 'error');
    return;
  }

  const button = $('#resumePdfBtn');
  const label = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Building…';
  }

  try {
    const doc = await buildResumePdf(application);
    doc.save(resumeFileBase(application) + '.pdf');
    toast('Resume PDF downloaded');
  } catch (err) {
    console.warn('PDF generation failed', err);
    toast('Could not build the PDF — opening print instead', 'error');
    printResume();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label || 'Download PDF';
    }
  }
}

function printResume() {
  const application = currentApplication();
  if (!application || !application.resume.trim()) {
    toast('No tailored resume to print', 'error');
    return;
  }
  setApplicationTab('resume');
  setTimeout(() => window.print(), 60);
}

// ---------------------------------------------------------------- Interview practice

function cleanPracticeQuestion(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/^(q|question)\s*\d*[:.)-]\s*/i, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[\s"'“”‘’#*_-]+/, '')
    .replace(/[\s"'“”‘’#*_-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function practiceHintFor(question) {
  const text = String(question || '').toLowerCase();
  if (/tell me about yourself|walk me through your|introduce yourself/.test(text)) {
    return 'Open with your current role, then two highlights that map to this job. End with why this role is the next step.';
  }
  if (/why (this|our|the) (company|role|team)|why .*company|why do you want/.test(text)) {
    return 'Name something specific about the company — product, mission, or recent work — and connect it to what you want to build next.';
  }
  if (/conflict|disagree|difficult (person|stakeholder)|pushback/.test(text)) {
    return 'Use STAR. Describe the disagreement without blame, explain how you listened, and land on the resolution and what changed.';
  }
  if (/learn|new (skill|tool|technology)|ramp/.test(text)) {
    return 'Name the skill, how you learned it, and the first real result you delivered with it. Show the pace.';
  }
  if (/fail|mistake|went wrong/.test(text)) {
    return 'Pick a real mistake, own it plainly, then spend most of the answer on the fix and what you changed afterward.';
  }
  if (/prioriti|trade-off|deadline|pressure/.test(text)) {
    return 'Explain the constraint, who you aligned, what you cut, and the outcome. Show the decision, not just the busyness.';
  }
  if (/90 days|first six months|success/.test(text)) {
    return 'Break it into 30/60/90-day outcomes: learn, contribute, then own something measurable.';
  }
  return 'Anchor this in a specific example from your resume. Set the situation, describe your action, and end with the result.';
}

function parsePracticeQuestions(brief) {
  const lines = String(brief || '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((line) => /likely questions|practice questions|interview questions/i.test(line));
  const stop = /^\s*(questions to ask|topics to review|questions for|key stories|notes|closing)\b/i;

  const block = [];
  if (start >= 0) {
    const inline = lines[start].match(/(?:likely questions|practice questions|interview questions)\s*[:\-–—]\s*(.+)$/i);
    if (inline) block.push(inline[1]);
    for (let i = start + 1; i < lines.length; i += 1) {
      if (stop.test(lines[i].trim().replace(/^#+\s*/, ''))) break;
      block.push(lines[i]);
    }
  } else {
    block.push(...lines);
  }

  const numbered = [];
  const asked = [];
  const bullets = [];
  let current = null;

  block.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const talking = line.match(/^(?:talking point|hint|notes?)\s*[:—-]\s*(.+)$/i);
    if (talking && current) {
      current.hint = talking[1].trim();
      return;
    }

    const numberedMatch = line.match(/^(?:\*\*)?\d+[.)](?:\*\*)?\s+(.+)$/);
    if (numberedMatch) {
      const text = cleanPracticeQuestion(numberedMatch[1]);
      if (text.length > 8) {
        current = { text, hint: '' };
        numbered.push(current);
      }
      return;
    }

    const bulletMatch = line.match(/^[-•*–—]\s+(.+)$/);
    if (bulletMatch) {
      const text = cleanPracticeQuestion(bulletMatch[1]);
      if (text.length > 10) {
        if (current && current.hint) {
          current.hint += ' ' + text;
        } else {
          current = { text, hint: '' };
          bullets.push(current);
        }
      }
      return;
    }

    if (/\?\s*$/.test(line)) {
      const text = cleanPracticeQuestion(line);
      if (text.length > 10 && text.length < 320) {
        current = { text, hint: '' };
        asked.push(current);
      }
    }
  });

  const questions = numbered.length ? numbered : asked.length ? asked : bullets;
  const seen = new Set();

  return questions
    .map((question) => ({
      text: question.text,
      hint: question.hint || practiceHintFor(question.text)
    }))
    .filter((question) => {
      const key = question.text.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function fallbackPracticeQuestions(application) {
  const company = application.company || 'the company';
  const role = application.position || 'this role';
  const name = firstName(state.profile.name) || 'your background';

  return [
    'Walk me through ' + name + ' and why ' + role + ' is the right next move.',
    'Which parts of this posting map most directly to work you have already done?',
    'Describe a project you owned end to end. What did you decide, and what changed because of it?',
    'Tell me about a time you had to learn something quickly. How did you approach it?',
    'Where have you disagreed with a teammate or stakeholder? How did you resolve it?',
    'Why ' + company + ', and what would you want to accomplish in your first 90 days?'
  ].map((text) => ({ text, hint: practiceHintFor(text) }));
}

function practiceQuestions(application) {
  const parsed = parsePracticeQuestions(application.interviewPrep || '');
  const fallback = fallbackPracticeQuestions(application);
  const merged = [];
  const seen = new Set();

  const add = (question) => {
    const key = question.text.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(question);
  };

  parsed.forEach(add);
  fallback.forEach((question) => {
    if (merged.length >= 6) return;
    add(question);
  });

  return merged;
}

function ensurePracticeAnswers(session, count) {
  while (session.answers.length < count) session.answers.push('');
  if (session.answers.length > count) session.answers.length = count;
}

function practiceTone(score) {
  if (score >= 75) return 'good';
  if (score >= 50) return 'mid';
  return 'low';
}

function scorePracticeAnswer(answer, question, application) {
  const text = String(answer || '').trim();
  if (!text) {
    return {
      score: 0,
      feedback: [
        'No answer recorded. Even a rough outline beats a blank — start with the situation and what you did.',
        'Use this question as a prompt for a two-minute story from your resume.'
      ]
    };
  }

  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  const feedback = [];
  let score = 0;

  if (words >= 120 && words <= 260) score += 30;
  else if (words >= 70) score += 27;
  else if (words >= 45) score += 21;
  else if (words >= 25) score += 14;
  else if (words >= 10) score += 7;
  else score += 2;

  if (words < 45) {
    feedback.push('Expand this to roughly 60–180 words so the answer has context, action, and a result.');
  } else if (words > 320) {
    feedback.push('Tighten this. A strong spoken answer usually lands in 60–180 words.');
  }

  const starPatterns = [
    /\b(situation|context|when i|while i|at (my|the|our) (company|team|project|last job))\b/i,
    /\b(task|goal|responsible for|needed to|asked to|had to)\b/i,
    /\b(i|we)\s+(built|led|ran|designed|wrote|shipped|created|launched|organized|analy[sz]ed|implemented|moved|coordinated|managed|drove|tested|rewrote|negotiated|partnered|owned)\b/i,
    /\b(result|outcome|impact|as a result|led to|which (helped|meant)|increased|decreased|improved|reduced|saved|grew|cut|raised|won)\b/i
  ];
  const starHits = starPatterns.filter((pattern) => pattern.test(text)).length;
  score += starHits * 5;

  if (starHits < 3) {
    feedback.push('Use STAR: one sentence for the situation, one for your task, one for the action, and one for the result.');
  } else {
    feedback.push('Clear STAR shape — situation, action, and result all came through. Keep that structure.');
  }

  const numbers = text.match(/(?:[$€£]\s*)?\b\d[\d,.]*(?:\s?(?:%|x|k|m|bn|b))?\b/gi) || [];
  if (numbers.length >= 3) {
    score += 20;
    feedback.push('Concrete numbers make the outcome believable. Keep them.');
  } else if (numbers.length >= 1) {
    score += 13;
    feedback.push('Good — add one more number if you have it: scale, timeframe, percentage, or hours saved.');
  } else {
    feedback.push('Add a number: team size, timeline, %, revenue, users, or hours saved.');
  }

  const impact = text.match(/\b(increased|decreased|improved|reduced|saved|grew|launched|shipped|delivered|accelerated|cut|doubled|tripled|won|secured|raised|converted|retained|streamlined|automated|unblocked)\b/gi) || [];
  if (impact.length >= 2) score += 12;
  else if (impact.length === 1) score += 8;
  else feedback.push('End with the outcome. Use a verb like increased, reduced, shipped, or saved.');

  const keywords = findKeywords((application.position || '') + ' ' + (application.jobDescription || '')).slice(0, 12);
  if (keywords.length) {
    const hits = keywords.filter((word) => lower.includes(word)).length;
    score += Math.round(Math.min(1, (hits / keywords.length) * 2.5) * 12);
    if (hits >= 2) {
      feedback.push('You connected the answer to the role’s language. Nice.');
    } else {
      feedback.push('Echo a few terms from the posting: ' + keywords.slice(0, 3).join(', ') + '.');
    }
  } else {
    score += 6;
  }

  const ownership = (text.match(/\b(i|my|me)\b/gi) || []).length;
  if (ownership >= 3) score += 6;
  else if (ownership >= 1) score += 3;
  else feedback.push('Make your role explicit — say what you decided or did, not only what the team did.');

  let fillers = 0;
  PRACTICE_FILLERS.forEach((filler) => {
    const pattern = new RegExp('\\b' + filler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    fillers += (text.match(pattern) || []).length;
  });
  if (fillers) {
    score -= Math.min(8, fillers * 2);
    feedback.push('Trim filler words like “um,” “like,” and “just” — about ' + fillers + ' showed up.');
  }

  const cleanFeedback = [];
  feedback.forEach((item) => {
    if (!cleanFeedback.includes(item)) cleanFeedback.push(item);
  });

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    feedback: cleanFeedback.slice(0, 4)
  };
}

function gradePractice(application, questions, answers) {
  const results = questions.map((question, index) => {
    const graded = scorePracticeAnswer(answers[index] || '', question, application);
    return { score: graded.score, feedback: graded.feedback };
  });

  const score = results.length
    ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length)
    : 0;

  return { results, score };
}

function practiceIntroHtml(questions) {
  return '<div class="practice-intro">' +
    '<h4>Practice the conversation, one question at a time.</h4>' +
    '<p>knomad pulls the likely questions from your interview brief. Answer in your own words, move at your own pace, and get a score when you finish. Answers stay on this device.</p>' +
    '<div class="practice-facts">' +
    '<span class="practice-fact">' + questions.length + ' questions</span>' +
    '<span class="practice-fact">Local scoring</span>' +
    '<span class="practice-fact">Answers saved</span>' +
    '</div>' +
    '<button class="btn primary" type="button" data-practice="start">Start practice</button>' +
    '</div>';
}

function practiceQuestionHtml(questions, session) {
  const index = session.index;
  const question = questions[index];
  const answer = session.answers[index] || '';
  const words = wordCount(answer);
  const percent = Math.round(((index + 1) / questions.length) * 100);
  const last = index === questions.length - 1;

  return '<div class="practice-progress-row">' +
    '<span>Question ' + (index + 1) + ' of ' + questions.length + '</span>' +
    '<span>' + percent + '% complete</span>' +
    '</div>' +
    '<div class="practice-progress"><span style="width:' + percent + '%"></span></div>' +
    '<h4 class="practice-question">' + escapeHtml(question.text) + '</h4>' +
    '<div class="practice-hint" id="practiceHint" hidden>' + escapeHtml(question.hint) + '</div>' +
    '<textarea class="practice-answer" id="practiceAnswer" placeholder="Write your answer the way you would say it out loud…">' + escapeHtml(answer) + '</textarea>' +
    '<div class="practice-answer-row">' +
    '<span id="practiceWordCount">' + words + (words === 1 ? ' word' : ' words') + '</span>' +
    '<button class="btn ghost small" type="button" data-practice="hint">Show a hint</button>' +
    '</div>' +
    '<div class="practice-actions">' +
    '<span class="field-help">Your answer is saved locally as you type.</span>' +
    '<div class="practice-actions-right">' +
    '<button class="btn ghost" type="button" data-practice="prev"' + (index === 0 ? ' disabled' : '') + '>Back</button>' +
    '<button class="btn primary" type="button" data-practice="next">' + (last ? 'Finish &amp; score' : 'Next question') + '</button>' +
    '</div>' +
    '</div>';
}

function practiceResultsHtml(questions, session) {
  const score = session.score != null ? session.score : 0;
  const tone = practiceTone(score);
  const headline = score >= 75
    ? 'Strong, specific answers.'
    : score >= 50
      ? 'Solid foundation. Tighten the details.'
      : 'Good start. Add specifics and structure.';
  const summary = score >= 75
    ? 'You sound ready. Do one more pass to keep each answer tight and conversational.'
    : score >= 50
      ? 'The shape is there. Add numbers, outcomes, and a little more STAR structure.'
      : 'You have the raw material. Focus on one clear example per answer and end with a result.';

  const totalWords = session.answers.reduce((sum, answer) => sum + wordCount(answer), 0);

  const rows = questions.map((question, index) => {
    const result = session.results[index] || { score: 0, feedback: [] };
    const answer = session.answers[index] || '';
    return '<div class="practice-result">' +
      '<div class="practice-result-head">' +
      '<h4>' + (index + 1) + '. ' + escapeHtml(question.text) + '</h4>' +
      '<span class="practice-score ' + practiceTone(result.score) + '">' + result.score + '/100</span>' +
      '</div>' +
      '<p class="practice-answer-text' + (answer ? '' : ' empty') + '">' +
      escapeHtml(answer || 'No answer recorded.') +
      '</p>' +
      '<ul class="practice-feedback">' +
      result.feedback.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') +
      '</ul>' +
      '</div>';
  }).join('');

  return '<div class="practice-result-hero">' +
    '<div class="score-ring ' + tone + '" style="--score:' + score + '"><span>' + score + '<small>/100</small></span></div>' +
    '<div class="practice-result-copy"><h4>' + headline + '</h4><p>' + summary + '</p></div>' +
    '</div>' +
    '<div class="practice-actions" style="border-top:0; padding-top:4px;">' +
    '<span class="field-help">' + questions.length + ' answers · ' + totalWords + ' words practiced</span>' +
    '<button class="btn primary" type="button" data-practice="retake">Practice again</button>' +
    '</div>' +
    '<div class="practice-results">' + rows + '</div>';
}

function renderPractice() {
  const host = $('#practiceApp');
  const application = currentApplication();
  if (!host || !application) return;

  const questions = practiceQuestions(application);
  const session = normalizePractice(application.interviewSession);
  application.interviewSession = session;
  ensurePracticeAnswers(session, questions.length);

  const meta = $('#practiceMeta');
  if (meta) {
    if (session.completed) meta.textContent = 'Scored ' + session.score + '/100';
    else if (session.started) {
      meta.textContent = 'Question ' + (Math.min(session.index, questions.length - 1) + 1) + ' of ' + questions.length;
    } else {
      meta.textContent = questions.length + ' questions';
    }
  }

  if (session.completed && session.results.length) {
    host.innerHTML = practiceResultsHtml(questions, session);
    return;
  }

  if (!session.started) {
    host.innerHTML = practiceIntroHtml(questions);
    return;
  }

  session.index = Math.max(0, Math.min(session.index, questions.length - 1));
  host.innerHTML = practiceQuestionHtml(questions, session);
}

function savePracticeAnswer() {
  const application = currentApplication();
  const input = $('#practiceAnswer');
  if (!application || !input) return;

  const session = application.interviewSession;
  if (!session || !session.started || session.completed) return;

  const questions = practiceQuestions(application);
  ensurePracticeAnswers(session, questions.length);
  session.answers[session.index] = input.value;
  saveApplications();
}

function handlePracticeInput(event) {
  const input = event.target.closest ? event.target.closest('#practiceAnswer') : null;
  if (!input) return;

  const count = wordCount(input.value);
  const label = $('#practiceWordCount');
  if (label) label.textContent = count + (count === 1 ? ' word' : ' words');

  clearTimeout(practiceSaveTimer);
  practiceSaveTimer = setTimeout(() => {
    const application = currentApplication();
    const session = application ? application.interviewSession : null;
    if (!application || !session || !session.started || session.completed) return;

    const questions = practiceQuestions(application);
    ensurePracticeAnswers(session, questions.length);
    session.answers[session.index] = input.value;
    saveApplications();
  }, 400);
}

function handlePracticeAction(action) {
  const application = currentApplication();
  if (!application) return;

  const session = normalizePractice(application.interviewSession);
  application.interviewSession = session;
  const questions = practiceQuestions(application);
  ensurePracticeAnswers(session, questions.length);

  if (action === 'start' || action === 'retake') {
    session.started = true;
    session.completed = false;
    session.index = 0;
    session.score = null;
    session.results = [];
    session.gradedAt = null;
    session.answers = questions.map(() => '');
    saveApplications();
    renderPractice();
    return;
  }

  if (action === 'prev') {
    savePracticeAnswer();
    session.index = Math.max(0, session.index - 1);
    saveApplications();
    renderPractice();
    return;
  }

  if (action === 'next') {
    savePracticeAnswer();
    if (session.index >= questions.length - 1) {
      const graded = gradePractice(application, questions, session.answers);
      session.results = graded.results;
      session.score = graded.score;
      session.completed = true;
      session.gradedAt = new Date().toISOString();
      saveApplications();
      renderPractice();
      toast('Practice scored: ' + graded.score + '/100');
    } else {
      session.index += 1;
      saveApplications();
      renderPractice();
    }
    return;
  }

  if (action === 'hint') {
    const hint = $('#practiceHint');
    if (!hint) return;
    hint.hidden = !hint.hidden;
    const button = $('[data-practice="hint"]');
    if (button) button.textContent = hint.hidden ? 'Show a hint' : 'Hide hint';
  }
}

function updateApplication(id, patch) {
  const application = state.applications.find((app) => String(app.id) === String(id));
  if (!application) return;

  if (patch.status && patch.status !== application.status) {
    application.statusHistory = (application.statusHistory || [])
      .concat({ status: patch.status, at: new Date().toISOString() });
  }

  Object.assign(application, patch);
  saveApplications();
  if (currentPage === 'application' && String(currentDetailId) === String(id)) {
    renderApplication();
  }
  renderDashboard();
  renderTracker();
  renderCalendar();
}

function updateCurrentStatus(value) {
  if (!currentDetailId) return;
  updateApplication(currentDetailId, { status: value });
  toast('Status updated to ' + STATUS_LABEL[value]);
}

function saveCurrentNotes() {
  if (!currentDetailId) return;
  updateApplication(currentDetailId, { notes: $('#detailNotes').value.trim() });
  toast('Notes saved');
}

function deleteApplication(id) {
  const application = state.applications.find((app) => String(app.id) === String(id));
  if (!application) return;
  const label = application.company + ' — ' + application.position;
  if (!confirm('Delete ' + label + '? This cannot be undone.')) return;

  const wasOpen = String(currentDetailId) === String(id);
  state.applications = state.applications.filter((app) => String(app.id) !== String(id));
  saveApplications();

  if (wasOpen) {
    currentDetailId = null;
    renderedApplicationId = null;
    if (currentPage === 'application') {
      const fallback = PAGE_TITLES[applicationReturnPage] && applicationReturnPage !== 'application'
        ? applicationReturnPage
        : 'dashboard';
      showPage(fallback);
    }
  }

  renderDashboard();
  renderTracker();
  renderCalendar();
  toast('Application deleted');
}

// ---------------------------------------------------------------- Reminders

function loadNotified() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch (err) {
    return new Set();
  }
}

let notifiedKeys = loadNotified();
let reminderTimer = null;

function saveNotified() {
  const list = Array.from(notifiedKeys).slice(-500);
  notifiedKeys = new Set(list);
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(list));
  } catch (err) {
    /* storage full or unavailable — reminders still fire in-app */
  }
}

function fireReminder(application, event) {
  const heading = event.kind === 'interview' ? 'Interview reminder' : 'Reminder';
  const context = (application.company || 'Unknown company') + ' · ' + (application.position || 'Untitled role');
  const body = (event.title ? event.title + ' — ' : '') + context + ' at ' + formatEventDateTime(event.at);

  toast(heading + ': ' + body);

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification('knomad · ' + heading, { body, tag: String(event.id) });
    } catch (err) {
      /* some browsers block notifications from local files — the toast still shows */
    }
  }
}

function checkReminders() {
  const now = Date.now();
  let changed = false;

  allEvents().forEach(({ app, event }) => {
    const at = new Date(event.at).getTime();
    if (!Number.isFinite(at)) return;

    const minutes = Number(event.reminder);
    const offset = Number.isFinite(minutes) ? minutes * 60000 : 0;
    const reminderAt = at - offset;

    if (now < reminderAt) return;
    if (now - at > 60 * 60000) return;

    const key = String(event.id) + ':' + reminderAt;
    if (notifiedKeys.has(key)) return;

    notifiedKeys.add(key);
    changed = true;
    fireReminder(app, event);
  });

  if (changed) saveNotified();
}

function startReminders() {
  checkReminders();
  if (reminderTimer) return;
  reminderTimer = setInterval(checkReminders, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkReminders();
  });
}

function enableNotifications() {
  if (typeof Notification === 'undefined') {
    toast('Browser notifications are not supported here', 'error');
    renderNotifyStatus();
    return;
  }
  if (Notification.permission === 'granted') {
    toast('Browser reminders are already on');
    renderNotifyStatus();
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Notifications are blocked in your browser settings', 'error');
    renderNotifyStatus();
    return;
  }

  try {
    Notification.requestPermission().then((result) => {
      renderNotifyStatus();
      toast(
        result === 'granted' ? 'Browser reminders enabled' : 'Browser reminders were not enabled',
        result === 'granted' ? 'success' : 'error'
      );
    }).catch(() => {
      renderNotifyStatus();
      toast('Could not request notification permission', 'error');
    });
  } catch (err) {
    renderNotifyStatus();
    toast('Browser notifications are not available here', 'error');
  }
}

function renderNotifyStatus() {
  const status = $('#notifyStatus');
  const text = $('#notifyStatusText');
  const button = $('#notifyBtn');

  const supported = typeof Notification !== 'undefined';
  const permission = supported ? Notification.permission : 'unsupported';

  if (status) status.classList.toggle('on', permission === 'granted');

  if (text) {
    if (permission === 'granted') text.textContent = 'Browser notifications on';
    else if (permission === 'denied') text.textContent = 'Browser notifications blocked';
    else if (!supported) text.textContent = 'Browser notifications unavailable · in-app reminders still work';
    else text.textContent = 'Browser notifications off · in-app reminders still work';
  }

  if (button) {
    button.disabled = permission === 'granted' || permission === 'denied' || !supported;
    button.textContent = permission === 'granted'
      ? 'Browser reminders enabled'
      : permission === 'denied'
        ? 'Notifications blocked'
        : !supported
          ? 'Notifications unavailable'
          : 'Enable browser reminders';
  }
}

// ---------------------------------------------------------------- Settings

function renderSettings() {
  const keyInput = $('#keyInput');
  if (keyInput) keyInput.value = state.geminiKey;

  const status = $('#keyStatus');
  const statusText = $('#keyStatusText');
  const hasKey = Boolean(state.geminiKey);
  if (status) status.classList.toggle('on', hasKey);
  if (statusText) {
    statusText.textContent = hasKey
      ? 'Key saved · AI mode enabled'
      : 'No key saved · basic mode';
  }

  const summary = $('#dataSummary');
  if (summary) {
    const count = state.applications.length;
    summary.textContent = count + (count === 1 ? ' application' : ' applications');
  }

  renderNotifyStatus();
}

function saveKey() {
  const value = $('#keyInput').value.trim();
  if (!value) {
    toast('Enter a Gemini key first', 'error');
    return;
  }
  state.geminiKey = value;
  localStorage.setItem(STORE.key, value);
  renderSettings();
  toast('Gemini key saved');
}

function clearKey() {
  if (!state.geminiKey) {
    toast('No key saved');
    return;
  }
  if (!confirm('Remove the saved Gemini key?')) return;
  state.geminiKey = '';
  localStorage.removeItem(STORE.key);
  workingModel = null;
  renderSettings();
  toast('Gemini key removed');
}

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    profile: state.profile,
    applications: state.applications
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = 'knomad-backup-' + stamp + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded');
}

function resetAll() {
  if (!confirm('Erase your profile, resume, applications, and key from this browser?')) return;
  if (!confirm('Last check: this cannot be undone. Erase everything?')) return;

  localStorage.removeItem(STORE.profile);
  localStorage.removeItem(STORE.applications);
  localStorage.removeItem(STORE.key);
  localStorage.removeItem(NOTIFIED_KEY);

  state.profile = defaultProfile();
  state.applications = [];
  state.geminiKey = '';
  notifiedKeys = new Set();
  currentDetailId = null;
  renderedApplicationId = null;
  applicationTab = 'overview';
  clearTimeout(practiceSaveTimer);
  workingModel = null;

  applyProfileToForm();
  showPage('dashboard');
  toast('All local data erased');
}

// ---------------------------------------------------------------- Events

function bindEvents() {
  const rail = $('#railNav');
  if (rail) {
    rail.addEventListener('click', (event) => {
      const button = event.target.closest('.rail-btn');
      if (button && button.dataset.page) showPage(button.dataset.page);
    });
  }

  document.addEventListener('click', (event) => {
    const addJob = event.target.closest('[data-action="add-job"]');
    if (addJob) {
      event.preventDefault();
      openAddJob();
      return;
    }

    const appTab = event.target.closest('[data-app-tab]');
    if (appTab) {
      event.preventDefault();
      setApplicationTab(appTab.dataset.appTab);
      return;
    }

    const practiceAction = event.target.closest('[data-practice]');
    if (practiceAction) {
      event.preventDefault();
      handlePracticeAction(practiceAction.dataset.practice);
      return;
    }

    const pageTarget = event.target.closest('[data-page-target]');
    if (pageTarget) {
      event.preventDefault();
      showPage(pageTarget.dataset.pageTarget);
      return;
    }

    const close = event.target.closest('[data-close]');
    if (close) {
      event.preventDefault();
      closeModal(close.closest('.modal'));
      return;
    }

    const view = event.target.closest('[data-view]');
    if (view) {
      event.preventDefault();
      openDetail(view.dataset.view);
      return;
    }

    const del = event.target.closest('[data-delete]');
    if (del) {
      event.preventDefault();
      deleteApplication(del.dataset.delete);
      return;
    }

    const eventDel = event.target.closest('[data-event-del]');
    if (eventDel) {
      event.preventDefault();
      removeEvent(eventDel.dataset.eventDel);
      return;
    }

    const copy = event.target.closest('[data-copy]');
    if (copy) {
      event.preventDefault();
      const target = $('#' + copy.dataset.copy);
      if (target) copyText(target.textContent);
      return;
    }

    if (event.target.classList && event.target.classList.contains('modal')) {
      closeModal(event.target);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTopModal();
  });

  const profileForm = $('#profileForm');
  if (profileForm) profileForm.addEventListener('submit', handleProfileSubmit);

  const resumeText = $('#profileResumeText');
  if (resumeText) {
    resumeText.addEventListener('input', renderProfileResumeMeta);
  }

  const drop = $('#profileDrop');
  const fileInput = $('#profileResumeFile');
  if (drop && fileInput) {
    drop.addEventListener('click', (event) => {
      if (event.target === fileInput) return;
      fileInput.click();
    });
    fileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) handleResumeFile(file);
      fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach((type) => {
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.remove('drag');
      });
    });
    drop.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleResumeFile(file);
    });
  }

  const fillBtn = $('#resumeFillBtn');
  if (fillBtn) fillBtn.addEventListener('click', fillProfileFromResume);

  const clearBtn = $('#resumeClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearResume);

  const search = $('#searchInput');
  if (search) search.addEventListener('input', renderTracker);
  const filter = $('#statusFilter');
  if (filter) filter.addEventListener('change', renderTracker);

  const addForm = $('#addJobForm');
  if (addForm) addForm.addEventListener('submit', handleAddJobSubmit);

  const retry = $('#retryAddBtn');
  if (retry) {
    retry.addEventListener('click', () => {
      resetAddJob();
      const input = $('#jobUrl');
      if (input) input.focus();
    });
  }

  const statusSelect = $('#detailStatus');
  if (statusSelect) statusSelect.addEventListener('change', (event) => updateCurrentStatus(event.target.value));

  const saveNotes = $('#saveNotesBtn');
  if (saveNotes) saveNotes.addEventListener('click', saveCurrentNotes);

  const eventForm = $('#eventForm');
  if (eventForm) eventForm.addEventListener('submit', handleEventSubmit);

  const practiceHost = $('#practiceApp');
  if (practiceHost) practiceHost.addEventListener('input', handlePracticeInput);

  const resumePdfBtn = $('#resumePdfBtn');
  if (resumePdfBtn) resumePdfBtn.addEventListener('click', downloadResumePdf);

  const resumePrintBtn = $('#resumePrintBtn');
  if (resumePrintBtn) resumePrintBtn.addEventListener('click', printResume);

  const calPrev = $('#calPrevBtn');
  if (calPrev) calPrev.addEventListener('click', () => shiftMonth(-1));
  const calNext = $('#calNextBtn');
  if (calNext) calNext.addEventListener('click', () => shiftMonth(1));
  const calToday = $('#calTodayBtn');
  if (calToday) calToday.addEventListener('click', goToday);

  const calDays = $('#calDays');
  if (calDays) {
    calDays.addEventListener('click', (event) => {
      const day = event.target.closest('[data-cal-day]');
      if (day) selectCalendarDay(day.dataset.calDay);
    });
  }

  const notifyBtn = $('#notifyBtn');
  if (notifyBtn) notifyBtn.addEventListener('click', enableNotifications);

  const deleteBtn = $('#deleteAppBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      if (currentDetailId) deleteApplication(currentDetailId);
    });
  }

  const saveKeyBtn = $('#saveKeyBtn');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveKey);

  const clearKeyBtn = $('#clearKeyBtn');
  if (clearKeyBtn) clearKeyBtn.addEventListener('click', clearKey);

  const keyToggle = $('#keyToggleBtn');
  if (keyToggle) {
    keyToggle.addEventListener('click', () => {
      const input = $('#keyInput');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      keyToggle.textContent = show ? 'Hide' : 'Show';
    });
  }

  const exportBtn = $('#exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportData);

  const resetBtn = $('#resetBtn');
  if (resetBtn) resetBtn.addEventListener('click', resetAll);
}

// ---------------------------------------------------------------- Init

function init() {
  applyProfileToForm();
  bindEvents();
  showPage('dashboard');
  startReminders();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
