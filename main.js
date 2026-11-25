/* knomad — local-first job search workspace */

import {
  cloudConfig,
  AuthRequiredError,
  signUpCloud,
  signInCloud,
  getCloudSession,
  signOutCloud,
  forgetCloudSession,
  api,
  subscribeToDocs,
  closeRealtime,
  uploadResumeFile,
  aiChat
} from './sync.js';

import {
  DEFAULT_TARGET,
  PROVIDER_LINKS,
  classifyEligibility,
  resolveTarget,
  searchAiTrainingPage,
  searchJobs,
  sortJobs
} from './job-search.js';

import { fetchDailyRead, DAILY_PORTALS, resolveDailyPortal } from './daily-read.js';

// The PDF reader's worker ships with the app. It used to be a CDN script with
// no integrity check, which put the Gemini key in this origin at that CDN's mercy.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

// ---------------------------------------------------------------- Storage

const STORE = {
  profile: 'knomad_profile',
  applications: 'knomad_applications',
  key: 'knomad_gemini_key',
  clocks: 'knomad_sync_clocks',
  cursor: 'knomad_sync_cursor',
  space: 'knomad_space',
  calScope: 'knomad_cal_scope',
  upcomingWindow: 'knomad_upcoming_window',
  dashInsights: 'knomad_dash_insights',
  dashActivity: 'knomad_dash_activity',
  dashStatus: 'knomad_dash_status'
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
  'copywriting', 'email marketing', 'paid media', 'crm', 'marketing', 'seo'
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

const PROFILE_PHOTO_PX = 320;
const PROFILE_PHOTO_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function defaultProfile() {
  return {
    name: '',
    headline: '',
    email: '',
    phone: '',
    location: '',
    photo: '',
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
    photo: isProfilePhoto(raw.photo) ? raw.photo : '',
    links: { ...base.links, ...(raw.links || {}) },
    dailyPortal: normalizePortalChoice(raw.dailyPortal)
  };
}

function normalizePortalChoice(value) {
  const id = String(value || 'auto');
  if (id === 'auto' || id === 'general') return id;
  return DAILY_PORTALS.some((portal) => portal.id === id) ? id : 'auto';
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
  geminiKey: localStorage.getItem(STORE.key) || '',
  cloud: {
    user: null,
    status: 'off',
    lastSync: null,
    error: '',
    realtime: false
  },
  social: {
    status: 'off',
    error: '',
    friends: [],
    incoming: [],
    outgoing: [],
    inbox: [],
    sent: [],
    unread: 0,
    unreadMessages: 0
  },
  space: {
    status: 'off',
    error: '',
    loaded: false,
    circles: [],
    members: [],
    taskLists: [],
    projects: [],
    tasks: [],
    books: [],
    shelfCategories: [],
    contacts: [],
    contactNotes: [],
    people: {}
  }
};

function saveProfile(options = {}) {
  localStorage.setItem(STORE.profile, JSON.stringify(state.profile));
  if (options.sync !== false) queueLocalChanges();
}

function saveApplications(options = {}) {
  localStorage.setItem(STORE.applications, JSON.stringify(state.applications));
  if (options.sync !== false) queueLocalChanges();
}

// ---------------------------------------------------------------- Cloud sync
//
// Local storage stays the source of truth for the running UI. Every save is
// diffed against the last known synced value and queued, then flushed to the
// Function. Remote rows win only when their client_updated_at is newer.
// The Gemini key is deliberately absent from every synced document.

const CLOUD_POLL_MS = 30_000;
const CLOUD_EPOCH = '1970-01-01T00:00:00.000Z';

let cloudQueue = new Map();
let cloudFlushTimer = null;
let cloudPullInFlight = false;
let cloudPullAgain = false;
let cloudPollTimer = null;
let cloudSubscription = null;
let cloudDiffProfile = null;
let cloudDiffApplications = new Map();

function cloudReady() {
  return cloudConfig.configured && Boolean(state.cloud.user);
}

function isAuthRequired(err) {
  return Boolean(err && (err instanceof AuthRequiredError || err.code === 'AUTH_REQUIRED'));
}

let clearingDeadSession = false;

/**
 * Better Auth can report a session after its cookie has stopped working
 * (blocked third-party cookies, revoked session, cleared site data). When a
 * token can no longer be minted, stop pretending this device is signed in,
 * keep every local document, and point the person at Settings once.
 */
function handleAuthRequired() {
  const message = 'Session expired. Sign in again.';
  if (clearingDeadSession) return message;
  clearingDeadSession = true;

  stopCloudSync();
  setAccountError(message);
  renderSettings();
  if (currentPage !== 'settings') showPage('settings');
  toast(message, 'error');

  forgetCloudSession()
    .catch(() => {})
    .finally(() => { clearingDeadSession = false; });
  return message;
}

function cloudStorageKey(name) {
  const id = state.cloud.user && state.cloud.user.id;
  return id ? name + '_' + id : name;
}

function loadClocks() {
  return loadJSON(cloudStorageKey(STORE.clocks), {});
}

function saveClocks(clocks) {
  localStorage.setItem(cloudStorageKey(STORE.clocks), JSON.stringify(clocks));
}

function readCursor() {
  return localStorage.getItem(cloudStorageKey(STORE.cursor)) || '';
}

function writeCursor(value) {
  if (value) localStorage.setItem(cloudStorageKey(STORE.cursor), value);
}

function nextClock(kind, docId) {
  const clocks = loadClocks();
  const key = kind + ':' + docId;
  const value = Math.max(Date.now(), (Number(clocks[key]) || 0) + 1);
  clocks[key] = value;
  saveClocks(clocks);
  return value;
}

function queueDoc(kind, docId, payload, deleted = false) {
  if (!cloudReady()) return;
  cloudQueue.set(kind + ':' + docId, {
    kind,
    docId,
    payload: deleted ? null : payload,
    deleted: Boolean(deleted),
    clientUpdatedAt: nextClock(kind, docId)
  });
  clearTimeout(cloudFlushTimer);
  cloudFlushTimer = setTimeout(flushCloudQueue, 700);
}

async function flushCloudQueue() {
  if (!cloudReady() || !cloudQueue.size) return;

  const docs = Array.from(cloudQueue.values());
  cloudQueue = new Map();

  try {
    const data = await api('/docs/batch', { method: 'POST', body: { docs } });
    const results = Array.isArray(data && data.results) ? data.results : [];
    const rejected = results.filter((result) => result && (result.error || result.applied === false));

    if (!rejected.length) {
      setCloudStatus('synced');
      return;
    }

    // The server dropped these writes. Saying "synced" here would be a lie:
    // pull the winning rows instead, and name the problem when it is the clock.
    rejected.forEach((result) => {
      if (result.kind && result.docId) resetClock(result.kind, result.docId);
    });

    const clockRejection = rejected.find((result) => /clock/i.test(result.error || ''));
    if (clockRejection) {
      setCloudStatus('error', clockRejection.error);
      notifySyncProblem(clockRejection.error + ' Your other changes are still on this device.');
      return;
    }

    notifySyncProblem(
      rejected.length +
      (rejected.length === 1 ? ' change was' : ' changes were') +
      ' not saved because another device has newer edits. Pulling the latest.'
    );
    // A full pull, because the winning row may already be behind this device's
    // cursor (Realtime applies rows without moving it).
    await pullCloudDocs(true);
  } catch (err) {
    if (isAuthRequired(err)) {
      docs.forEach((doc) => {
        const key = doc.kind + ':' + doc.docId;
        if (!cloudQueue.has(key)) cloudQueue.set(key, doc);
      });
      handleAuthRequired();
      return;
    }
    docs.forEach((doc) => {
      const key = doc.kind + ':' + doc.docId;
      if (!cloudQueue.has(key)) cloudQueue.set(key, doc);
    });
    setCloudStatus('error', err.message);
    clearTimeout(cloudFlushTimer);
    cloudFlushTimer = setTimeout(flushCloudQueue, 5000);
  }
}

function queueLocalChanges() {
  if (!cloudReady()) return;

  const profileJson = JSON.stringify(state.profile);
  if (cloudDiffProfile === null) {
    cloudDiffProfile = profileJson;
  } else if (profileJson !== cloudDiffProfile) {
    cloudDiffProfile = profileJson;
    queueDoc('profile', 'me', state.profile);
  }

  const present = new Set();
  state.applications.forEach((application) => {
    present.add(application.id);
    const json = JSON.stringify(application);
    const previous = cloudDiffApplications.get(application.id);
    if (previous === undefined) {
      cloudDiffApplications.set(application.id, json);
    } else if (previous !== json) {
      cloudDiffApplications.set(application.id, json);
      queueDoc('application', application.id, application);
    }
  });

  Array.from(cloudDiffApplications.keys()).forEach((id) => {
    if (!present.has(id)) {
      cloudDiffApplications.delete(id);
      queueDoc('application', id, null, true);
    }
  });
}

function decodeDocPayload(payload) {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function applyRemoteDocs(docs) {
  if (!Array.isArray(docs) || !docs.length) return false;

  const clocks = loadClocks();
  let changed = false;

  docs.forEach((doc) => {
    const kind = doc.kind;
    const docId = doc.doc_id || doc.docId;
    const clientUpdatedAt = Number(doc.client_updated_at == null ? doc.clientUpdatedAt : doc.client_updated_at);
    if (!kind || !docId || !Number.isFinite(clientUpdatedAt)) return;

    const key = kind + ':' + docId;
    if ((Number(clocks[key]) || 0) >= clientUpdatedAt) return; // local edit is newer
    clocks[key] = clientUpdatedAt;

    const deleted = Boolean(doc.deleted_at || doc.deletedAt);
    const payload = decodeDocPayload(doc.payload);

    if (kind === 'profile') {
      state.profile = normalizeProfile(deleted ? null : payload);
      cloudDiffProfile = JSON.stringify(state.profile);
    } else if (kind === 'application') {
      const index = state.applications.findIndex((application) => application.id === docId);
      if (deleted) {
        if (index >= 0) state.applications.splice(index, 1);
        cloudDiffApplications.delete(docId);
      } else {
        const normalized = normalizeApplications([payload])[0];
        if (normalized) {
          if (normalized.id !== docId) normalized.id = docId;
          if (index >= 0) state.applications[index] = normalized;
          else state.applications.push(normalized);
          cloudDiffApplications.set(docId, JSON.stringify(normalized));
        }
      }
    }

    changed = true;
  });

  saveClocks(clocks);

  if (changed) {
    localStorage.setItem(STORE.profile, JSON.stringify(state.profile));
    localStorage.setItem(STORE.applications, JSON.stringify(state.applications));
    if (currentDetailId && !state.applications.some((application) => application.id === currentDetailId)) {
      currentDetailId = null;
    }
    refreshCurrentPage();
  }

  return changed;
}

async function pullCloudDocs(full = false) {
  if (!cloudReady()) return;
  if (cloudPullInFlight) {
    cloudPullAgain = true;
    return;
  }

  cloudPullInFlight = true;
  try {
    const since = full ? CLOUD_EPOCH : (readCursor() || CLOUD_EPOCH);
    const data = await api('/docs?since=' + encodeURIComponent(since));
    applyRemoteDocs(data && data.docs);
    if (data && data.cursor) writeCursor(data.cursor);
    if (state.cloud.status !== 'error') setCloudStatus('synced');
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else setCloudStatus('error', err.message);
  } finally {
    cloudPullInFlight = false;
    if (cloudPullAgain) {
      cloudPullAgain = false;
      pullCloudDocs(false);
    }
  }
}

function stopRealtime() {
  if (cloudSubscription) {
    try {
      cloudSubscription.unsubscribe();
    } catch {
      // ignore
    }
    cloudSubscription = null;
  }
  closeRealtime();
  state.cloud.realtime = false;
}

async function startRealtime() {
  stopRealtime();
  if (!cloudReady() || !cloudConfig.realtimeUrl) return;

  try {
    cloudSubscription = await subscribeToDocs(
      (rows) => {
        applyRemoteDocs(rows);
        setCloudStatus('synced');
      },
      (rtState) => {
        if (rtState && rtState.status === 'error') {
          setCloudStatus('polling', 'Live updates paused — polling every 30s');
        }
      }
    );
    state.cloud.realtime = Boolean(cloudSubscription);
  } catch (err) {
    state.cloud.realtime = false;
    console.warn('Realtime unavailable; polling instead', err.message);
  }
  renderAccount();
}

function startPolling() {
  clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(() => {
    if (!cloudReady() || document.hidden) return;
    flushCloudQueue();
    pullCloudDocs(false);
    loadSocial({ silent: true });
    loadSpace({ silent: true });
  }, CLOUD_POLL_MS);
}

function stopCloudSync() {
  stopRealtime();
  clearInterval(cloudPollTimer);
  clearTimeout(cloudFlushTimer);
  cloudPollTimer = null;
  cloudFlushTimer = null;
  cloudQueue.clear();
  cloudDiffProfile = null;
  cloudDiffApplications.clear();
  state.cloud = { user: null, status: 'off', lastSync: null, error: '', realtime: false };
  resetSocial();
  resetSpace();
}

async function startCloudSync(session) {
  const user = session && (session.user || (session.session && session.session.user));
  if (!user) {
    stopCloudSync();
    return;
  }

  state.cloud.user = user;
  state.cloud.status = 'syncing';
  state.cloud.error = '';
  spaceGeneration += 1;
  spaceLoading = false;
  readSpaceCache();
  renderAccount();

  const hadCursor = Boolean(readCursor());
  const since = hadCursor ? readCursor() : CLOUD_EPOCH;
  const data = await api('/docs?since=' + encodeURIComponent(since));
  applyRemoteDocs(data && data.docs);
  if (data && data.cursor) writeCursor(data.cursor);

  if (!hadCursor) {
    const seen = new Set(
      ((data && data.docs) || []).map((doc) => doc.kind + ':' + (doc.doc_id || doc.docId))
    );
    if (state.profile.resumeText || state.profile.name || state.profile.email) {
      if (!seen.has('profile:me')) queueDoc('profile', 'me', state.profile);
    }
    state.applications.forEach((application) => {
      if (!seen.has('application:' + application.id)) {
        queueDoc('application', application.id, application);
      }
    });
  }

  cloudDiffProfile = JSON.stringify(state.profile);
  cloudDiffApplications = new Map(
    state.applications.map((application) => [application.id, JSON.stringify(application)])
  );

  await flushCloudQueue();
  await startRealtime();
  startPolling();
  setCloudStatus('synced');
  loadSocial({ silent: true });
  loadSpace({ silent: true });
}

async function restoreCloudSession() {
  if (!cloudConfig.configured) {
    renderSettings();
    return;
  }

  const session = await getCloudSession();
  if (session && session.user) {
    try {
      await startCloudSync(session);
    } catch (err) {
      if (isAuthRequired(err)) {
        handleAuthRequired();
      } else {
        state.cloud.user = session.user;
        setCloudStatus('error', err.message);
      }
    }
  }
  renderSettings();
}

function setCloudStatus(status, detail = '') {
  state.cloud.status = status;
  state.cloud.error = detail || '';
  if (status === 'synced') state.cloud.lastSync = new Date().toISOString();
  renderAccount();
}

let lastSyncNotice = '';

// One toast per distinct problem: a retrying sync should not spam the screen.
function notifySyncProblem(message) {
  if (!message || message === lastSyncNotice) return;
  lastSyncNotice = message;
  toast(message, 'error');
}

// A rejected write must not leave a timestamp behind that outranks every
// future remote row; dropping the clock entry lets the device recover as soon
// as its clock is fixed.
function resetClock(kind, docId) {
  const clocks = loadClocks();
  delete clocks[kind + ':' + docId];
  saveClocks(clocks);
}

function setAccountError(message) {
  const el = $('#accountError');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function setAccountBusy(busy) {
  ['#accountSignInBtn', '#accountSignUpBtn', '#accountSyncBtn', '#accountSignOutBtn'].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = busy;
  });
}

async function handleCloudSignIn() {
  const email = ($('#accountEmail') ? $('#accountEmail').value : '').trim();
  const password = $('#accountPassword') ? $('#accountPassword').value : '';
  if (!email || !password) {
    setAccountError('Enter your email and password.');
    return;
  }

  setAccountError('');
  setAccountBusy(true);
  try {
    const data = await signInCloud({ email, password });
    const session = data && data.user
      ? { user: data.user, session: data.session }
      : await getCloudSession();
    if (!session || !session.user) throw new Error('Sign-in did not return a session.');
    await startCloudSync(session);
    renderSettings();
    toast('Signed in — syncing this device');
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else if (state.cloud.user) setCloudStatus('error', err.message || 'Sync failed.');
    else setAccountError(err.message || 'Could not sign in.');
  } finally {
    setAccountBusy(false);
  }
}

async function handleCloudSignUp() {
  const email = ($('#accountEmail') ? $('#accountEmail').value : '').trim();
  const password = $('#accountPassword') ? $('#accountPassword').value : '';
  const name = ($('#accountName') ? $('#accountName').value : '').trim();

  if (!email || !password) {
    setAccountError('Enter an email and a password of at least 8 characters.');
    return;
  }
  if (password.length < 8) {
    setAccountError('Password must be at least 8 characters.');
    return;
  }

  setAccountError('');
  setAccountBusy(true);
  try {
    const data = await signUpCloud({ email, password, name: name || email.split('@')[0] });
    const session = data && data.user
      ? { user: data.user, session: data.session }
      : await getCloudSession();
    if (session && session.user) {
      await startCloudSync(session);
      toast('Account created — syncing this device');
    } else {
      setAccountError('Account created. Check your email to verify it, then sign in.');
    }
    renderSettings();
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else if (state.cloud.user) setCloudStatus('error', err.message || 'Sync failed.');
    else setAccountError(err.message || 'Could not create account.');
  } finally {
    setAccountBusy(false);
  }
}

async function handleCloudSignOut() {
  const ok = await confirmAction({
    tone: 'neutral',
    title: 'Sign out of cloud sync?',
    message: 'Your local data stays on this device.',
    confirmLabel: 'Sign out'
  });
  if (!ok) return;
  setAccountBusy(true);
  try {
    await signOutCloud();
  } catch (err) {
    console.warn('Sign out failed', err.message);
  }
  stopCloudSync();
  setAccountError('');
  renderSettings();
  toast('Signed out of cloud sync');
}

async function handleCloudSyncNow() {
  if (!cloudReady()) return;
  setAccountBusy(true);
  try {
    await flushCloudQueue();
    await pullCloudDocs(false);
    await loadSocial({ silent: true });
    toast('Workspace synced');
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else setAccountError(err.message);
  } finally {
    setAccountBusy(false);
  }
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

// ---------------------------------------------------------------- Profile photo

function isProfilePhoto(value) {
  return typeof value === 'string' && PROFILE_PHOTO_PATTERN.test(value);
}

function profilePhoto() {
  const photo = state.profile && state.profile.photo;
  return isProfilePhoto(photo) ? photo : '';
}

function renderAvatar(el, photo, name) {
  if (!el) return;
  if (photo) {
    el.classList.add('has-photo');
    el.innerHTML = '<img src="' + photo + '" alt="">';
  } else {
    el.classList.remove('has-photo');
    el.textContent = initials(name);
  }
}

function renderProfilePhoto() {
  const photo = profilePhoto();
  const name = state.profile.name;
  renderAvatar($('#dashAvatar'), photo, name);
  renderAvatar($('#avatarBtn'), photo, name);
  renderAvatar($('#profilePhotoPreview'), photo, name);
  const removeBtn = $('#profilePhotoRemove');
  if (removeBtn) removeBtn.disabled = !photo;
}

function readProfileImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That image could not be read. Try a PNG, JPEG, or WebP.'));
    };
    img.src = url;
  });
}

async function handleProfilePhotoFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    toast('Choose an image file: PNG, JPEG, WebP, or GIF.', 'error');
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    toast('That image is over 12 MB. Pick a smaller one.', 'error');
    return;
  }

  try {
    const img = await readProfileImage(file);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('That image has no readable pixels.');

    const edge = Math.min(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = PROFILE_PHOTO_PX;
    canvas.height = PROFILE_PHOTO_PX;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#0f1514';
    ctx.fillRect(0, 0, PROFILE_PHOTO_PX, PROFILE_PHOTO_PX);
    ctx.drawImage(
      img,
      (width - edge) / 2,
      (height - edge) / 2,
      edge,
      edge,
      0,
      0,
      PROFILE_PHOTO_PX,
      PROFILE_PHOTO_PX
    );

    state.profile.photo = canvas.toDataURL('image/jpeg', 0.86);
    saveProfile();
    renderProfilePhoto();
    toast('Profile photo updated');
  } catch (err) {
    toast(err.message || 'Could not process that image', 'error');
  }
}

function clearProfilePhoto() {
  if (!profilePhoto()) return;
  state.profile.photo = '';
  saveProfile();
  renderProfilePhoto();
  toast('Profile photo removed');
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

// Date-only values come back as "YYYY-MM-DD"; parse them as local dates so
// they do not slide to the previous day outside positive timezones.
function formatDay(value) {
  if (!value) return '';
  const text = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  }
  return formatDate(value);
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

// Date-only columns arrive from the API as full ISO timestamps; inputs and
// schedule math need just the calendar day.
function dayOnly(value) {
  return value ? String(value).slice(0, 10) : '';
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

// ---------------------------------------------------------------- Google Calendar

// Google's `render?action=TEMPLATE` endpoint needs no API key or OAuth. It is a
// one-way, per-click export: later edits or deletions in knomad do not update
// the copy already added to Google Calendar.
function googleCalendarStamp(date) {
  return date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) +
    'T' + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds());
}

function googleCalendarTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

function googleCalendarUrl(item) {
  const title = item.title || 'knomad event';
  const details = [item.details, 'Added from knomad'].filter(Boolean).join(' · ');
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title });

  if (item.allDay) {
    // All-day dates are plain YYYYMMDD, and Google treats the end date as
    // exclusive, so a one-day event ends on the following day.
    const start = dayKey(item.at);
    if (!start) return '';
    const next = new Date(start + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    params.set('dates', start.replace(/-/g, '') + '/' + dayKey(next).replace(/-/g, ''));
  } else {
    const start = new Date(item.at);
    if (Number.isNaN(start.getTime())) return '';
    // Events in knomad only store a start, so give Google a sensible block.
    const minutes = Number(item.durationMinutes) > 0 ? Number(item.durationMinutes) : 60;
    const end = new Date(start.getTime() + minutes * 60000);
    params.set('dates', googleCalendarStamp(start) + '/' + googleCalendarStamp(end));
    const timeZone = googleCalendarTimeZone();
    if (timeZone) params.set('ctz', timeZone);
  }

  if (details) params.set('details', details);
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

function googleCalendarIcon() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>' +
    '<path d="M12 13v4M10 15h4"/></svg>';
}

function googleCalendarLink(item) {
  const href = googleCalendarUrl(item);
  if (!href) return '';
  return '<a class="event-gcal" href="' + escapeHtml(href) + '" target="_blank" ' +
    'rel="noopener noreferrer" title="Add to Google Calendar" ' +
    'aria-label="Add to Google Calendar">' + googleCalendarIcon() + '</a>';
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
  search: 'Find jobs',
  together: 'Together',
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

  if (target !== 'profile' && profileEditing) cancelProfileEdit({ silent: true });

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

  if (target === 'dashboard') {
    renderDashboard();
    if (cloudReady() && !state.space.loaded) loadSpace({ silent: true });
  }
  if (target === 'search') renderJobSearch();
  if (target === 'together') {
    renderTogether();
    if (cloudReady()) {
      loadSpace({ silent: state.space.status === 'ready' });
      loadSocial({ silent: state.social.status === 'ready' });
    }
  }
  if (target === 'tracker') renderTracker();
  if (target === 'calendar') renderCalendar();
  if (target === 'application') renderApplication();
  if (target === 'profile') {
    applyProfileToForm();
    renderProfileResumeMeta();
    renderProfileMode();
  }
  if (target === 'settings') renderSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function refreshCurrentPage() {
  if (currentPage === 'dashboard') renderDashboard();
  else if (currentPage === 'tracker') renderTracker();
  else if (currentPage === 'calendar') renderCalendar();
  else if (currentPage === 'together') renderTogether();
  else if (currentPage === 'settings') renderSettings();
  else if (currentPage === 'application') {
    if (currentDetailId) renderApplication();
    else showPage('tracker');
  } else if (currentPage === 'profile') {
    applyProfileToForm();
    renderProfileResumeMeta();
    renderProfileMode();
  }
}

// ---------------------------------------------------------------- Dashboard

// Activity and Status breakdown are independent preferences, not data: each
// chart can be hidden without touching the applications or Together rows
// behind them. Older builds stored one shared `knomad_dash_insights` flag, so
// an existing "off" keeps both charts off until the person chooses again.
const legacyDashInsights = localStorage.getItem(STORE.dashInsights);

function readDashChartPref(key) {
  const stored = localStorage.getItem(key);
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return legacyDashInsights !== 'off';
}

let dashActivity = readDashChartPref(STORE.dashActivity);
let dashStatus = readDashChartPref(STORE.dashStatus);

function saveDashChartPref(key, enabled) {
  localStorage.setItem(key, enabled ? 'on' : 'off');
  // Retire the old shared flag once either chart has its own choice.
  localStorage.removeItem(STORE.dashInsights);
}

function refreshDashboardInsights() {
  if (currentPage !== 'dashboard') return;
  if (dashActivity) renderActivity(state.applications);
  if (dashStatus) renderStatusChart(state.applications);
}

function renderDashboard() {
  const profile = state.profile;
  const applications = state.applications;

  const metrics = dashboardMetrics(applications);
  const titleEl = $('#dashTitle');
  if (titleEl) {
    if (!metrics.total) {
      titleEl.textContent = 'No applications filed yet';
    } else if (metrics.active) {
      titleEl.textContent = metrics.total + (metrics.total === 1 ? ' application' : ' applications') +
        ', ' + metrics.active + ' still open';
    } else if (metrics.offers) {
      titleEl.textContent = metrics.offers + (metrics.offers === 1 ? ' offer' : ' offers') +
        ' from ' + metrics.total + (metrics.total === 1 ? ' application' : ' applications');
    } else {
      titleEl.textContent = metrics.total + (metrics.total === 1 ? ' application' : ' applications') + ' filed';
    }
  }

  const sub = $('#heroSub');
  if (sub) {
    sub.textContent = profile.resumeText
      ? 'Add a posting and knomad tailors your resume, drafts interview prep, and files it in your tracker'
      : 'Start with your profile. Add a resume once, then every job you add gets a tailored version';
  }

  const nameEl = $('#dashName');
  if (nameEl) nameEl.textContent = profile.name || 'Add your name';
  const headlineEl = $('#dashHeadline');
  if (headlineEl) {
    headlineEl.textContent = profile.headline || 'Your headline appears on every tailored resume';
  }

  renderProfilePhoto();

  renderChips(profile);
  renderStats(applications);
  const charts = $('#dashCharts');
  if (charts) {
    charts.hidden = !dashActivity && !dashStatus;
    charts.classList.toggle('single-chart', dashActivity !== dashStatus);
  }
  const activityCard = $('#activityCard');
  if (activityCard) activityCard.hidden = !dashActivity;
  const statusCard = $('#statusCard');
  if (statusCard) statusCard.hidden = !dashStatus;
  if (dashActivity) renderActivity(applications);
  if (dashStatus) renderStatusChart(applications);
  renderUpcoming();
  renderTogetherDash();
  renderRecent(applications);
  renderDailyRead();

  // Collapsible chart toggles
  $$('[data-toggle-chart]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.toggleChart;
      const chartCard = btn.closest('.chart-card');
      if (!chartCard) return;
      chartCard.classList.toggle('collapsed');
    });
  });
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
  };  }

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
      label: 'Interviews, last 7 days',
      value: metrics.interviewsThisWeek,
      note: metrics.interviewsThisWeek ? 'Moved to interviewing this week' : 'No interview moves this week'
    },
    {
      label: 'Active pipeline',
      value: metrics.active,
      note: metrics.counts.interviewing + ' interviewing now'
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
    '<article class="stat-card">' +
    '<span class="stat-label">' + card.label + '</span>' +
    '<span class="stat-value">' + card.value + '</span>' +
    '<span class="stat-note">' + escapeHtml(card.note) + '</span>' +
    '</article>'
  )).join('');
}

function activityDayTime(value) {
  if (!value) return null;
  const text = String(value);
  // A book's finished_on is a date with no timezone. Parsing it as UTC would
  // move it to the previous day west of Greenwich, so build it as local time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return new Date(year, month - 1, day).getTime();
  }
  const date = startOfDay(value);
  return date ? date.getTime() : null;
}

// Together activity is what got finished: completed tasks and finished books.
// Adding an empty task is not an accomplishment, so it stays out of the chart.
function togetherActivityDays() {
  const days = [];
  (state.space.tasks || []).forEach((task) => {
    if (!task.completedAt) return;
    const day = activityDayTime(task.completedAt);
    if (day != null) days.push(day);
  });
  (state.space.books || []).forEach((book) => {
    if (book.shelf !== 'finished' || !book.finishedOn) return;
    const day = activityDayTime(book.finishedOn);
    if (day != null) days.push(day);
  });
  (state.space.contactNotes || []).forEach((note) => {
    if (!note.happenedOn) return;
    const day = activityDayTime(note.happenedOn);
    if (day != null) days.push(day);
  });
  return days;
}

function renderActivity(applications) {
  const host = $('#activityChart');
  if (!host) return;

  const togetherDays = togetherActivityDays();
  if (!applications.length && !togetherDays.length) {
    host.innerHTML = '<div class="chart-empty">No activity yet<span>Add a job or finish a Together task or book</span></div>';
    return;
  }

  const days = 14;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - (days - 1) * DAY_MS;
  const buckets = Array.from({ length: days }, (_, index) => ({
    date: new Date(start + index * DAY_MS),
    jobs: 0,
    together: 0
  }));

  applications.forEach((app) => {
    const day = activityDayTime(app.dateApplied);
    if (day == null) return;
    const index = Math.round((day - start) / DAY_MS);
    if (index >= 0 && index < days) buckets[index].jobs += 1;
  });

  togetherDays.forEach((day) => {
    const index = Math.round((day - start) / DAY_MS);
    if (index >= 0 && index < days) buckets[index].together += 1;
  });

  const max = Math.max(1, ...buckets.map((bucket) => bucket.jobs + bucket.together));
  const totalJobs = buckets.reduce((sum, bucket) => sum + bucket.jobs, 0);
  const totalTogether = buckets.reduce((sum, bucket) => sum + bucket.together, 0);

  const bars = buckets.map((bucket) => {
    const total = bucket.jobs + bucket.together;
    const height = total ? Math.max(8, Math.round((total / max) * 100)) : 2;
    const label = formatDate(bucket.date);
    const pieces = [];
    if (bucket.jobs) pieces.push(bucket.jobs + (bucket.jobs === 1 ? ' application' : ' applications'));
    if (bucket.together) {
      pieces.push(bucket.together + (bucket.together === 1 ? ' Together action' : ' Together actions'));
    }
    const description = label + ' — ' + (pieces.length ? pieces.join(', ') : 'no activity');
    const segments =
      (bucket.jobs
        ? '<span class="bar-seg jobs" style="flex-grow:' + bucket.jobs + '"></span>'
        : '') +
      (bucket.together
        ? '<span class="bar-seg together" style="flex-grow:' + bucket.together + '"></span>'
        : '');
    return '<div class="bar-col" title="' + escapeHtml(description) + '">' +
      '<span class="bar-value">' + (total || '') + '</span>' +
      '<span class="bar' + (total ? '' : ' empty') + '" style="height:' + height + '%">' +
        segments +
      '</span>' +
      '</div>';
  }).join('');

  const axis = [buckets[0], buckets[Math.floor(days / 2)], buckets[days - 1]]
    .map((bucket) => '<span>' + escapeHtml(formatDate(bucket.date)) + '</span>')
    .join('');

  host.innerHTML =
    '<div class="activity-bars" role="img" aria-label="Last 14 days: ' + totalJobs +
      (totalJobs === 1 ? ' application' : ' applications') + ', ' + totalTogether +
      (totalTogether === 1 ? ' Together action' : ' Together actions') + '">' + bars + '</div>' +
    '<div class="activity-axis">' + axis + '</div>' +
    '<div class="activity-legend">' +
      '<span><span class="legend-dot"></span>Jobs ' + totalJobs + '</span>' +
      '<span><span class="legend-dot together"></span>Together ' + totalTogether + '</span>' +
    '</div>';
}

function statusRow(key, name, count, total) {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return '<div class="status-row' + (count ? '' : ' is-empty') + '">' +
    '<div class="status-row-head">' +
    '<span class="status-name"><span class="status-dot ' + key + '"></span>' + escapeHtml(name) + '</span>' +
    '<span class="status-count">' + count + ' · ' + pct + '%</span>' +
    '</div>' +
    '<div class="status-track"><span class="status-fill ' + key + '" style="width:' + pct + '%"></span></div>' +
    '</div>';
}

function renderStatusChart(applications) {
  const host = $('#statusChart');
  const totalEl = $('#statusTotal');
  const foot = $('#statusFoot');
  if (!host) return;

  const total = applications.length;
  const counts = STATUS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});
  applications.forEach((app) => {
    if (counts[app.status] != null) counts[app.status] += 1;
  });

  const tasks = state.space.tasks || [];
  const books = state.space.books || [];
  const openTasks = tasks.filter((task) => task.status !== 'done').length;
  const doneTasks = tasks.length - openTasks;
  const reading = books.filter((book) => book.shelf === 'reading').length;
  const finished = books.filter((book) => book.shelf === 'finished').length;
  const togetherTotal = tasks.length + books.length;

  if (totalEl) {
    totalEl.textContent = total + (total === 1 ? ' application' : ' applications') +
      (togetherTotal ? ' · ' + togetherTotal + ' together' : '');
  }

  const groups = [
    '<div class="status-group">' +
      '<p class="status-group-title">Jobs</p>' +
      STATUS.map((key) => statusRow(key, STATUS_LABEL[key], counts[key], total)).join('') +
    '</div>'
  ];

  if (togetherTotal) {
    const taskRows = tasks.length
      ? statusRow('open', 'Open tasks', openTasks, tasks.length) +
        statusRow('done', 'Done tasks', doneTasks, tasks.length)
      : '';
    const bookRows = books.length
      ? statusRow('reading', 'Books reading', reading, books.length) +
        statusRow('finished', 'Books finished', finished, books.length)
      : '';
    groups.push(
      '<div class="status-group">' +
        '<p class="status-group-title">Together</p>' +
        taskRows + bookRows +
      '</div>'
    );
  }

  host.innerHTML = groups.join('');

  if (foot) {
    const parts = [];
    if (total) {
      const replied = total - counts.applied;
      const rate = Math.round((replied / total) * 100);
      parts.push(replied + ' of ' + total + ' moved past applied');
      parts.push(rate + '% response rate');
    }
    if (tasks.length) parts.push(openTasks + ' open of ' + tasks.length + ' tasks');
    if (books.length) parts.push(finished + ' of ' + books.length + ' books finished');
    foot.textContent = parts.length
      ? parts.join(' · ')
      : 'Add a job or a Together item to see how this fills in';
  }
}

function renderRecent(applications) {
  const host = $('#recentList');
  if (!host) return;

  if (!applications.length) {
    host.innerHTML =
      '<div class="empty-state">' +
      '<p>No applications yet. Add your first posting and knomad fills in the rest</p>' +
      '<button class="btn subtle small" data-action="add-job">+ Add your first job</button>' +
      '</div>';
    return;
  }

  const recent = applications.slice(0, 5);
  host.innerHTML = recent.map((app, index) => {
    return '<button class="recent-row" data-view="' + escapeHtml(app.id) + '">' +
      '<span class="recent-no">' + String(index + 1).padStart(2, '0') + '</span>' +
      '<span class="recent-main">' +
      '<strong>' + escapeHtml(app.company) + '</strong>' +
      '<span>' + escapeHtml(app.position) + '</span>' +
      '</span>' +
      statusBadge(app.status) +
      '<span class="recent-date">' + escapeHtml(formatDate(app.dateApplied)) + '</span>' +
      '</button>';
  }).join('');
}

// ---------------------------------------------------------------- Daily read

const dailyReadState = {
  key: '',
  status: 'idle', // idle | loading | done | error
  data: null,
  error: ''
};

function shortHash(value) {
  let hash = 5381;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function dailyReadFingerprint() {
  const profile = state.profile || {};
  return [
    profile.headline,
    profile.summary,
    profile.resumeText,
    profile.dailyPortal || 'auto',
    ...(Array.isArray(profile.skills) ? profile.skills : [])
  ].join('|');
}

function dailyReadKey() {
  const today = new Date();
  return today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate() +
    ':' + shortHash(dailyReadFingerprint());
}

function dailyReadKeywords() {
  const profile = state.profile || {};
  const detected = findKeywords([profile.headline, profile.summary, profile.resumeText].join(' '));
  const merged = [];
  [...(Array.isArray(profile.skills) ? profile.skills : []), ...detected].forEach((skill) => {
    const text = String(skill || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (merged.some((item) => item.toLowerCase() === key)) return;
    merged.push(text);
  });
  return merged.slice(0, 12);
}

function clipDailyText(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut)
    .replace(/[.,;:\s]+$/, '') + '…';
}

function safeDailyImage(url) {
  const value = String(url || '');
  // Keep to Commons-hosted images. Some Wikipedia articles use locally hosted
  // fair-use files that should not be republished in this dashboard.
  return /^https:\/\/(upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//.test(value) ? value : '';
}

function dailyWordHtml(word) {
  if (!word) {
    return '<article class="daily-read-pane">' +
      '<div class="daily-read-head"><span class="daily-kicker">Word of the day</span>' +
      '<span class="daily-source-tag">Wiktionary</span></div>' +
      '<p class="daily-unavailable">Today’s word could not be loaded.</p>' +
      '</article>';
  }

  const tie = word.matched && word.matched.length
    ? '<p class="daily-context">On your resume: ' + escapeHtml(word.matched.slice(0, 3).join(', ')) + '</p>'
    : '';

  return '<article class="daily-read-pane">' +
    '<div class="daily-read-head"><span class="daily-kicker">Word of the day</span>' +
    '<span class="daily-source-tag">Wiktionary</span></div>' +
    '<p class="daily-word-line">' +
      '<span class="daily-word">' + escapeHtml(word.word) + '</span>' +
      (word.partOfSpeech ? '<span class="daily-pos">' + escapeHtml(word.partOfSpeech) + '</span>' : '') +
    '</p>' +
    '<p class="daily-def">' + escapeHtml(clipDailyText(word.definition, 270) || 'No definition returned.') + '</p>' +
    tie +
    '<a class="btn ghost small daily-link" href="' + escapeHtml(word.url) + '" target="_blank" ' +
      'rel="noopener noreferrer">Open entry ↗</a>' +
    '</article>';
}

function dailyArticleHtml(article) {
  if (!article) {
    return '<article class="daily-read-pane">' +
      '<div class="daily-read-head"><span class="daily-kicker">Article of the day</span>' +
      '<span class="daily-source-tag">Wikipedia</span></div>' +
      '<p class="daily-unavailable">Today’s article could not be loaded.</p>' +
      '</article>';
  }

  const portal = article.portal;
  const thumb = article.thumbnail || '';
  const portalLink = portal
    ? '<a class="daily-context-link" href="' + escapeHtml(portal.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(portal.label) + '</a>'
    : '';
  const tie = article.matched && article.matched.length
    ? '<p class="daily-context">' +
        (article.pickedForResume ? 'Picked for your resume: ' : 'On your resume: ') +
        escapeHtml(article.matched.slice(0, 3).join(', ')) +
        (portal ? ' · from the ' + portalLink + ' portal.' : '') +
        '</p>'
    : (portal
        ? '<p class="daily-context">From the ' + portalLink + ' portal.</p>'
        : '<p class="daily-context muted">A general read from today’s Wikipedia feed.</p>');

  return '<article class="daily-read-pane">' +
    '<div class="daily-read-head"><span class="daily-kicker">Article of the day</span>' +
    '<span class="daily-source-tag">' + escapeHtml(article.sourceLabel || 'Wikipedia') + '</span></div>' +
    '<div class="daily-article' + (thumb ? '' : ' no-thumb') + '">' +
      (thumb
        ? '<img class="daily-thumb" src="' + escapeHtml(thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
        : '') +
      '<div class="daily-article-copy">' +
        '<h4 class="daily-article-title"><a href="' + escapeHtml(article.url) + '" target="_blank" ' +
          'rel="noopener noreferrer">' + escapeHtml(article.title) + '</a></h4>' +
        '<p class="daily-extract">' + escapeHtml(clipDailyText(article.extract, 300) || 'No summary returned.') + '</p>' +
      '</div>' +
    '</div>' +
    tie +
    '<a class="btn ghost small daily-link" href="' + escapeHtml(article.url) + '" target="_blank" ' +
      'rel="noopener noreferrer">Read on Wikipedia ↗</a>' +
    '</article>';
}

function renderDailyRead() {
  const host = $('#dailyRead');
  if (!host || currentPage !== 'dashboard') return;

  const key = dailyReadKey();
  if (dailyReadState.key !== key) {
    dailyReadState.key = key;
    dailyReadState.status = 'idle';
    dailyReadState.data = null;
    dailyReadState.error = '';
  }

  if (dailyReadState.status === 'idle') {
    loadDailyRead();
    return;
  }

  const dateEl = $('#dailyReadDate');
  if (dateEl) {
    dateEl.textContent = dailyReadState.data
      ? dailyReadState.data.dateLabel
      : formatDate(new Date());
  }

  if (dailyReadState.status === 'loading') {
    host.innerHTML =
      '<div class="daily-read-pane"><span class="daily-skeleton short"></span>' +
      '<span class="daily-skeleton"></span><span class="daily-skeleton"></span></div>' +
      '<div class="daily-read-pane"><span class="daily-skeleton short"></span>' +
      '<span class="daily-skeleton"></span><span class="daily-skeleton"></span></div>';
    return;
  }

  if (dailyReadState.status === 'error') {
    host.innerHTML = '<div class="daily-read-empty">' +
      '<p>' + escapeHtml(dailyReadState.error || 'Today’s word and article could not be loaded.') + '</p>' +
      '<button class="btn ghost small" type="button" data-retry-daily>Try again</button>' +
      '</div>';
    return;
  }

  if (!dailyReadState.data) return;
  const data = dailyReadState.data;
  const hint = !dailyReadKeywords().length
    ? '<p class="daily-read-hint">Add skills or a resume to connect these reads to your work.</p>'
    : '';
  host.innerHTML = dailyWordHtml(data.word) + dailyArticleHtml(data.article) + hint;
}

async function loadDailyRead() {
  const key = dailyReadState.key;
  dailyReadState.status = 'loading';
  dailyReadState.error = '';
  renderDailyRead();

  try {
    const data = await fetchDailyRead({
      keywords: dailyReadKeywords(),
      portal: state.profile.dailyPortal || 'auto',
      profile: state.profile
    });
    if (dailyReadState.key !== key) return;
    dailyReadState.data = data;
    if (!data.word && !data.article) {
      dailyReadState.status = 'error';
      dailyReadState.error = [data.errors && data.errors.wikipedia, data.errors && data.errors.wiktionary]
        .filter(Boolean).join(' ') || 'Today’s word and article could not be loaded.';
    } else {
      dailyReadState.status = 'done';
    }
  } catch (err) {
    if (dailyReadState.key !== key) return;
    dailyReadState.status = 'error';
    dailyReadState.error = err && err.message ? err.message : 'Today’s word and article could not be loaded.';
  }

  renderDailyRead();
}

function dashboardUpcomingItems(limit = 5) {
  const now = Date.now();
  const todayStart = startOfDay(new Date(now)).getTime();
  const days = UPCOMING_WINDOWS[upcomingWindow] || 7;
  const horizon = todayStart + days * DAY_MS;
  return scheduleItems()
    .filter((item) => !item.done)
    .filter((item) => {
      const at = new Date(item.at).getTime();
      if (!Number.isFinite(at)) return false;
      // An all-day item stays "upcoming" for its whole day, even after 09:00.
      if (item.allDay) {
        const day = startOfDay(item.at).getTime();
        return day >= todayStart && day < horizon;
      }
      return at >= now && at <= horizon;
    })
    .slice(0, limit);
}

function upcomingPill(item) {
  let label = 'Project';
  let tone = 'project';
  if (item.source === 'application') {
    label = eventKindLabel(item.event);
    tone = item.kind === 'reminder' ? 'reminder' : 'interview';
  } else if (item.source === 'task') {
    label = 'To-do';
    tone = 'task';
  } else if (item.source === 'crm') {
    label = 'Follow-up';
    tone = 'crm';
  }
  return '<span class="upcoming-pill ' + tone + '">' + escapeHtml(label) + '</span>';
}

// Returns HTML so an assignee's presence dot can sit beside their name.
function upcomingSubtitle(item) {
  if (item.source === 'application') {
    const app = item.app || {};
    return escapeHtml((app.company || 'Unknown company') + ' · ' + (app.position || 'Untitled role'));
  }
  if (item.source === 'task') {
    const task = item.task || {};
    const list = task.listId ? findSpaceList(task.listId) : null;
    const where = list ? list.name : (item.circleId ? circleName(item.circleId) : 'Personal to-do');
    return escapeHtml(where) + (task.assigneeId ? ' · ' + personNameHtml(task.assigneeId) : '');
  }
  if (item.source === 'crm') {
    const contact = item.contact || {};
    const where = item.circleId ? circleName(item.circleId) : 'Personal contact';
    return escapeHtml((contact.company ? contact.company + ' · ' : '') + where);
  }
  const project = item.project || {};
  const status = PROJECT_STATUS_LABEL[project.status] || 'Active';
  return escapeHtml((item.circleId ? circleName(item.circleId) : 'Personal project') + ' · ' + status);
}

function upcomingRowHtml(item) {
  const whenTop = relativeDay(item.at);
  const whenBottom = item.allDay ? 'All day' : formatTime(item.at);
  let action = '';
  if (item.source === 'application' && item.app) {
    action = 'data-view="' + escapeHtml(item.app.id) + '"';
  } else if (item.source === 'task') {
    action = 'data-cal-task-open="' + escapeHtml(item.sourceId) + '"';
  } else if (item.source === 'crm') {
    action = 'data-cal-contact-open="' + escapeHtml(item.sourceId) + '"';
  } else {
    action = 'data-cal-project-open="' + escapeHtml(item.sourceId) + '"';
  }

  return '<button class="upcoming-row" type="button" ' + action + '>' +
    '<span class="upcoming-when">' + escapeHtml(whenTop) + '<br>' + escapeHtml(whenBottom) + '</span>' +
    '<span class="upcoming-main">' +
      '<span class="upcoming-head">' +
        '<strong>' + escapeHtml(item.title) + '</strong>' +
        upcomingPill(item) +
      '</span>' +
      '<span class="upcoming-sub">' + upcomingSubtitle(item) + '</span>' +
    '</span>' +
  '</button>';
}

function renderUpcoming() {
  const windowSelect = $('#upcomingWindow');
  if (windowSelect) windowSelect.value = upcomingWindow;

  const host = $('#upcomingList');
  if (!host) return;

  const upcoming = dashboardUpcomingItems();
  if (!upcoming.length) {
    const days = UPCOMING_WINDOWS[upcomingWindow] || 7;
    const label = days === 1 ? 'today' : 'the next ' + days + ' days';
    host.innerHTML = '<div class="event-empty">Nothing scheduled for ' + label +
      '. Add an interview, a to-do due date, or a follow-up</div>';
    return;
  }

  host.innerHTML = upcoming.map(upcomingRowHtml).join('');
}

// Together is a peer of Jobs on the Dashboard, not a tab buried inside it.
function togetherDashDueTasks() {
  const tomorrow = startOfDay(new Date()).getTime() + DAY_MS;
  return state.space.tasks
    .filter((task) => task.status !== 'done' && task.dueAt)
    .filter((task) => {
      const at = new Date(task.dueAt).getTime();
      return Number.isFinite(at) && at < tomorrow;
    })
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}

function togetherDashProjectTargets() {
  const tomorrow = startOfDay(new Date()).getTime() + DAY_MS;
  return (state.space.projects || [])
    .filter((project) => project.status !== 'done' && project.targetOn)
    .filter((project) => {
      const at = new Date(dayOnly(project.targetOn) + 'T00:00:00').getTime();
      return Number.isFinite(at) && at < tomorrow;
    })
    .sort((a, b) => dayOnly(a.targetOn).localeCompare(dayOnly(b.targetOn)));
}

function togetherDashFollowUps() {
  const windowStart = startOfDay(new Date()).getTime();
  const windowEnd = windowStart + 3 * DAY_MS;
  return state.space.contacts
    .filter((contact) => contact.nextFollowUpOn)
    .filter((contact) => {
      const day = dayOnly(contact.nextFollowUpOn);
      const at = day ? new Date(day + 'T00:00:00').getTime() : NaN;
      return Number.isFinite(at) && at <= windowEnd && at >= windowStart;
    })
    .sort((a, b) => dayOnly(a.nextFollowUpOn).localeCompare(dayOnly(b.nextFollowUpOn)));
}

function renderTogetherDash() {
  const host = $('#togetherDash');
  if (!host) return;
  const note = $('#togetherDashNote');

  if (!cloudReady()) {
    if (note) note.textContent = 'Sign in to coordinate with your kniggurs';
    host.innerHTML =
      '<article class="together-dash-card">' +
        '<div class="together-dash-card-head"><strong>Together</strong></div>' +
        '<p class="together-dash-copy">Sign in to share tasks, projects, learning, and follow-ups with a circle.</p>' +
        '<button class="btn primary small" type="button" data-page-target="settings">Sign in or create an account</button>' +
      '</article>';
    return;
  }

  const due = togetherDashDueTasks();
  const projectTargets = togetherDashProjectTargets();
  const followUps = togetherDashFollowUps();
  const open = state.space.tasks.filter((task) => task.status !== 'done').length;
  const contacts = state.space.contacts.length;
  const circles = state.space.circles;

  if (note) {
    note.textContent = state.space.loaded
      ? open + (open === 1 ? ' open task' : ' open tasks') + ' · ' +
        (contacts ? contacts + (contacts === 1 ? ' contact' : ' contacts') + ' · ' : '') +
        (followUps.length ? followUps.length + (followUps.length === 1 ? ' follow-up' : ' follow-ups') + ' · ' : '') +
        (circles.length ? circles.length + (circles.length === 1 ? ' circle' : ' circles') : 'Just me')
      : 'Loading your shared space…';
  }

  const dueRows = due.slice(0, 3)
    .map((task) =>
      '<button class="together-dash-row" type="button" data-cal-task-open="' + escapeHtml(task.id) + '">' +
        '<span class="together-dash-when">' + escapeHtml(relativeDay(task.dueAt)) + '</span>' +
        '<span class="together-dash-main">' +
          '<strong>' + escapeHtml(task.title) + '</strong>' +
          '<span>' + escapeHtml(task.circleId ? circleName(task.circleId) : 'Just me') +
            (task.assigneeId ? ' · ' + personNameHtml(task.assigneeId) : '') +
          '</span>' +
        '</span>' +
      '</button>'
    )
    .concat(projectTargets.slice(0, 3).map((project) =>
      '<button class="together-dash-row" type="button" data-project-open="' + escapeHtml(project.id) + '">' +
        '<span class="together-dash-when">' + escapeHtml(relativeDay(dayOnly(project.targetOn) + 'T00:00:00')) + '</span>' +
        '<span class="together-dash-main">' +
          '<strong>' + escapeHtml(project.name) + '</strong>' +
          '<span>Project target · ' + escapeHtml(project.circleId ? circleName(project.circleId) : 'Just me') + '</span>' +
        '</span>' +
      '</button>'
    ))
    .concat(followUps.slice(0, 3).map((contact) =>
      '<button class="together-dash-row" type="button" data-together-open-contact="' + escapeHtml(contact.id) + '">' +
        '<span class="together-dash-when">' + escapeHtml(relativeDay(dayOnly(contact.nextFollowUpOn) + 'T00:00:00')) + '</span>' +
        '<span class="together-dash-main">' +
          '<strong>Follow up: ' + escapeHtml(contact.name) + '</strong>' +
          '<span>' + escapeHtml(contactScopeLabel(contact)) +
            (contact.company ? ' · ' + escapeHtml(contact.company) : '') + '</span>' +
          '</span>' +
        '</button>'
    ))
    .join('') || '<div class="event-empty">Nothing due today or overdue</div>';

  const circleRows = circles.length
    ? circles.slice(0, 3).map((circle) => {
        const members = circleMembers(circle.id).length;
        return '<button class="together-dash-row" type="button" data-together-open-circle="' + escapeHtml(circle.id) + '">' +
          '<span class="together-dash-main">' +
            '<strong>' + escapeHtml(circle.name) + '</strong>' +
            '<span>' + members + (members === 1 ? ' member' : ' members') + '</span>' +
          '</span>' +
        '</button>';
      }).join('')
    : '<div class="event-empty">No circles yet — create one in Together</div>';

  const tabButtons = TOGETHER_TABS.map((tab) =>
    '<button class="btn ghost small" type="button" data-together-open-tab="' + tab + '">' +
      escapeHtml(tab === 'crm' ? 'CRM' : tab[0].toUpperCase() + tab.slice(1)) +
    '</button>'
  ).join('');

  host.innerHTML =
    '<article class="together-dash-card">' +
      '<div class="together-dash-card-head"><strong>Today</strong><span class="chart-note">' +
        (due.length + projectTargets.length + followUps.length) + '</span></div>' +
      dueRows +
    '</article>' +
    '<article class="together-dash-card">' +
      '<div class="together-dash-card-head"><strong>Circles</strong><span class="chart-note">' + circles.length + '</span></div>' +
      circleRows +
    '</article>' +
    '<article class="together-dash-card">' +
      '<div class="together-dash-card-head"><strong>Plan together</strong></div>' +
      '<div class="together-dash-tabs">' + tabButtons + '</div>' +
    '</article>';
}

function refreshDashboardSpace() {
  if (currentPage !== 'dashboard') return;
  renderUpcoming();
  renderTogetherDash();
  refreshDashboardInsights();
}

function statusBadge(status) {
  return '<span class="badge ' + escapeHtml(status) + '">' + STATUS_LABEL[status] + '</span>';
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
      ? total + ' tracked'
      : filtered.length + ' of ' + total + ' shown';
  }

  if (!filtered.length) {
    const message = state.applications.length
      ? 'No applications match these filters'
      : 'Nothing tracked yet — add a job to start';
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
      '<button class="btn ghost small quiet-danger" data-delete="' + escapeHtml(app.id) + '">Delete</button>' +
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

// ---------------------------------------------------------------- Job search

const SEARCH_EXAMPLES = [
  'Frontend developer',
  'Product manager',
  'Data analyst',
  'Customer support',
  'Designer'
];

const jobSearch = {
  query: '',
  target: DEFAULT_TARGET,
  strict: true,
  status: 'idle', // idle | loading | done | error
  jobs: [],
  providers: [],
  error: '',
  fetchedAt: null,
  aiOffset: null,
  aiTotal: 0,
  aiLoaded: 0,
  aiLoading: false,
  aiNote: '',
  aiRequest: 0
};

function renderJobSearch() {
  const roleInput = $('#jobSearchRole');
  if (roleInput && jobSearch.query && !roleInput.value) roleInput.value = jobSearch.query;

  const targetInput = $('#jobSearchLocation');
  if (targetInput && !targetInput.value) targetInput.value = jobSearch.target;

  const strict = $('#jobSearchStrict');
  if (strict) strict.checked = jobSearch.strict;

  updateSearchTargetLabel();
  renderSearchProviders();
  renderSearchResults();
  renderSearchPager();
}

function updateSearchTargetLabel() {
  const info = resolveTarget(jobSearch.target || DEFAULT_TARGET);
  const label = $('#jobSearchTargetLabel');
  if (label) label.textContent = info.label;
}

function renderSearchProviders() {
  const host = $('#jobSearchProviders');
  if (!host) return;

  const providers = jobSearch.providers.length
    ? jobSearch.providers
    : PROVIDER_LINKS.map((provider) => ({ ...provider, status: 'idle', count: 0 }));

  host.innerHTML = providers.map((provider) => {
    const status = provider.status || 'idle';
    let count = 'not searched';
    if (status === 'ok') count = provider.count + (provider.count === 1 ? ' role' : ' roles');
    else if (status === 'empty') count = 'no matches';
    else if (status === 'error') count = 'unavailable';
    else if (jobSearch.status === 'loading') count = 'searching…';

    const title = status === 'error' && provider.error ? provider.error : provider.name;
    return '<a class="provider-chip ' + status + '" href="' + escapeHtml(provider.home) + '" ' +
      'target="_blank" rel="noopener" title="' + escapeHtml(title) + '">' +
      '<span class="provider-dot" aria-hidden="true"></span>' +
      escapeHtml(provider.name) +
      '<span class="provider-count">' + escapeHtml(count) + '</span>' +
      '</a>';
  }).join('');
}

function postedLabel(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const days = Math.floor((Date.now() - time) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return days + 'd ago';
  return formatDate(value);
}

function decoratedSearchJobs() {
  const target = jobSearch.target || DEFAULT_TARGET;
  const jobs = jobSearch.jobs.map((job) => ({
    ...job,
    eligibility: classifyEligibility(job.location, target)
  }));
  return sortJobs(jobs);
}

function jobResultHtml(job) {
  const eligibility = job.eligibility || classifyEligibility(job.location, jobSearch.target);
  const eligibilityClass = eligibility.eligible
    ? (eligibility.eligibility === 'region' ? 'region' : 'open')
    : 'closed';
  const rawLocation = job.location || 'not stated';
  const posted = postedLabel(job.postedAt);

  const meta = [
    job.company ? '<span>' + escapeHtml(job.company) + '</span>' : '',
    '<span class="job-elig ' + eligibilityClass + '" title="Stated location: ' +
      escapeHtml(rawLocation) + '">' + escapeHtml(eligibility.label) + '</span>',
    job.type ? '<span>' + escapeHtml(job.type) + '</span>' : '',
    job.level ? '<span>' + escapeHtml(job.level) + '</span>' : '',
    job.salary ? '<span class="job-salary">' + escapeHtml(job.salary) + '</span>' : '',
    posted ? '<span>' + escapeHtml(posted) + '</span>' : ''
  ].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');

  return '<article class="job-result">' +
    '<div class="job-main">' +
    '<div class="job-title-row">' +
    '<a class="job-title" href="' + escapeHtml(job.url) + '" target="_blank" rel="noopener noreferrer follow">' +
    escapeHtml(job.title) + '</a>' +
    '<a class="job-provider" href="' + escapeHtml(job.providerHome || '#') + '" target="_blank" rel="noopener">' +      'via ' + escapeHtml(job.provider) + '</a>' +
    '</div>' +
    '<div class="job-meta">' + meta + '</div>' +
    '</div>' +
    '<div class="job-actions">' +
    '<a class="btn ghost small" href="' + escapeHtml(job.url) + '" target="_blank" rel="noopener noreferrer follow">Open ↗</a>' +
    '<button class="btn ghost small" type="button" data-send-job="' + escapeHtml(job.id) + '">Send</button>' +
    '<button class="btn subtle small" type="button" data-track-job="' + escapeHtml(job.id) + '">Track</button>' +
    '</div>' +
    '</article>';
}

function searchExamplesHtml() {
  return '<div class="search-examples">' +
    SEARCH_EXAMPLES.map((role) =>
      '<button class="search-example" type="button" data-search-role="' + escapeHtml(role) + '">' +
      escapeHtml(role) + '</button>'
    ).join('') +
    '</div>';
}

function renderSearchResults() {
  const host = $('#jobSearchResults');
  if (!host) return;

  const count = $('#jobSearchCount');
  const info = resolveTarget(jobSearch.target || DEFAULT_TARGET);

  if (jobSearch.status === 'idle') {
    if (count) count.textContent = 'No search yet';
    host.innerHTML = '<div class="search-intro">' +
      '<h3>Start with a role</h3>' +
      '<p>Type a title above, or start from one of these.</p>' +
      searchExamplesHtml() +
      '</div>';
    return;
  }

  if (jobSearch.status === 'loading') {
    if (count) count.textContent = 'Searching ' + PROVIDER_LINKS.length + ' providers…';
    host.innerHTML = '<div class="job-skeleton"></div><div class="job-skeleton"></div><div class="job-skeleton"></div>';
    return;
  }

  if (jobSearch.status === 'error') {
    if (count) count.textContent = 'Providers unavailable';
    host.innerHTML = '<div class="search-error">' +
      '<h3>Could not reach the job providers</h3>' +
      '<p>' + escapeHtml(jobSearch.error || 'Check your connection and try again.') + '</p>' +
      '<button class="btn ghost small" type="button" data-retry-search>Try again</button>' +
      '</div>';
    return;
  }

  const all = decoratedSearchJobs();
  const eligible = all.filter((job) => job.eligibility.eligible);
  const visible = jobSearch.strict ? eligible : all;

  if (count) {
    if (jobSearch.strict) {
      count.textContent = eligible.length + ' open to ' + info.label + ' · ' + all.length + ' matched';
    } else {
      count.textContent = 'Showing all ' + all.length + ' matched · ' + eligible.length + ' open to ' + info.label;
    }
  }

  if (!visible.length) {
    if (all.length && jobSearch.strict) {
      host.innerHTML = '<div class="search-intro">' +
        '<h3>No verified matches for ' + escapeHtml(info.label) + ' this time</h3>' +
        '<p>' + all.length + ' role' + (all.length === 1 ? '' : 's') +
        ' matched "' + escapeHtml(jobSearch.query) + '", but each one lists a different region. ' +
        'Review them with the filter off and check each posting before you apply.</p>' +
        '<button class="btn ghost small" type="button" data-show-all-search>Show all ' + all.length + ' matched roles</button>' +
        searchExamplesHtml() +
        '</div>';
    } else {
      host.innerHTML = '<div class="search-intro">' +
        '<h3>Nothing matched "' + escapeHtml(jobSearch.query) + '"</h3>' +
        '<p>Try a shorter or more common title — "developer" instead of "senior React developer", or "support" instead of "customer experience associate". The providers refresh continuously.</p>' +
        searchExamplesHtml() +
        '</div>';
    }
    return;
  }

  const shown = visible.slice(0, 60);
  host.innerHTML = '<div class="job-ledger">' + shown.map(jobResultHtml).join('') + '</div>' +
    (visible.length > shown.length
      ? '<p class="search-foot">Showing the first ' + shown.length + ' of ' + visible.length + '. Narrow the role to see fewer, better matches.</p>'
      : '');
}

function renderSearchPager() {
  const host = $('#jobSearchPager');
  if (!host) return;

  if (jobSearch.status !== 'done' || !jobSearch.aiOffset) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  const loaded = Number(jobSearch.aiLoaded) || 0;
  const total = Number(jobSearch.aiTotal) || 0;
  const scanning = jobSearch.aiLoading;
  host.hidden = false;
  host.innerHTML =
    '<span class="search-pager-note">AI training · scanned ' + loaded.toLocaleString('en-US') +
      (total ? ' of ' + total.toLocaleString('en-US') : '') + ' roles' +
      (jobSearch.aiNote ? ' · ' + escapeHtml(jobSearch.aiNote) : '') + '</span>' +
    '<button class="btn ghost small" type="button" data-load-ai-more' +
      (scanning ? ' disabled' : '') + '>' +
      (scanning ? 'Loading older roles…' : 'Load 500 older roles') +
    '</button>';
}

async function loadMoreAiTraining() {
  if (jobSearch.aiLoading || !jobSearch.aiOffset || jobSearch.status !== 'done') return;

  const query = jobSearch.query;
  const target = jobSearch.target;
  const offset = jobSearch.aiOffset;
  const request = ++jobSearch.aiRequest;
  jobSearch.aiLoading = true;
  jobSearch.aiNote = '';
  renderSearchPager();

  try {
    const result = await searchAiTrainingPage(query, { target, offset });
    if (jobSearch.query !== query || jobSearch.target !== target || jobSearch.status !== 'done') return;

    const existing = new Set(jobSearch.jobs.map((job) => String(job.id)));
    const added = result.jobs.filter((job) => !existing.has(String(job.id)));
    jobSearch.jobs = jobSearch.jobs.concat(added);
    jobSearch.aiOffset = result.nextOffset && result.nextOffset !== offset ? result.nextOffset : null;
    jobSearch.aiTotal = Number(result.total) || jobSearch.aiTotal;
    jobSearch.aiLoaded = (Number(jobSearch.aiLoaded) || 0) + (Number(result.loaded) || 0);

    const ai = jobSearch.providers.find((provider) => provider.id === 'aitrainer');
    if (ai) {
      ai.status = 'ok';
      ai.count = (Number(ai.count) || 0) + added.length;
      ai.loaded = jobSearch.aiLoaded;
      ai.total = jobSearch.aiTotal;
      ai.nextOffset = jobSearch.aiOffset;
    }

    if (!added.length) jobSearch.aiNote = 'No new matches in that batch';
  } catch (err) {
    if (jobSearch.query !== query || jobSearch.status !== 'done' || jobSearch.aiRequest !== request) return;
    jobSearch.aiNote = 'That batch could not be loaded';
    toast(err && err.message ? err.message : 'Could not load older AI-training roles', 'error');
  } finally {
    if (jobSearch.aiRequest !== request) return;
    jobSearch.aiLoading = false;
    renderSearchProviders();
    renderSearchResults();
    renderSearchPager();
  }
}

async function handleJobSearchSubmit(event) {
  if (event) event.preventDefault();

  const roleInput = $('#jobSearchRole');
  const targetInput = $('#jobSearchLocation');
  const role = roleInput ? roleInput.value.trim() : '';
  if (!role) {
    toast('Type a role to search for', 'error');
    if (roleInput) roleInput.focus();
    return;
  }

  jobSearch.query = role;
  jobSearch.target = (targetInput && targetInput.value.trim()) || DEFAULT_TARGET;
  jobSearch.status = 'loading';
  jobSearch.error = '';
  jobSearch.aiRequest += 1;
  jobSearch.aiLoading = false;
  jobSearch.aiNote = '';
  jobSearch.aiOffset = null;
  updateSearchTargetLabel();
  renderSearchProviders();
  renderSearchResults();
  renderSearchPager();

  const button = $('#jobSearchBtn');
  const label = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Searching…';
  }

  try {
    const result = await searchJobs(role, { target: jobSearch.target });
    jobSearch.jobs = Array.isArray(result.jobs) ? result.jobs : [];
    jobSearch.providers = Array.isArray(result.providers) ? result.providers : [];
    jobSearch.fetchedAt = result.fetchedAt || null;

    const ai = jobSearch.providers.find((provider) => provider.id === 'aitrainer');
    jobSearch.aiOffset = ai && ai.status !== 'error' ? ai.nextOffset : null;
    jobSearch.aiTotal = ai ? Number(ai.total) || 0 : 0;
    jobSearch.aiLoaded = ai ? Number(ai.loaded) || 0 : 0;
    jobSearch.aiLoading = false;
    jobSearch.aiNote = '';

    const failed = jobSearch.providers.filter((provider) => provider.status === 'error');
    if (failed.length === jobSearch.providers.length && jobSearch.providers.length) {
      jobSearch.status = 'error';
      jobSearch.error = failed
        .map((provider) => provider.name + ' (' + provider.error + ')')
        .join(', ');
    } else {
      jobSearch.status = 'done';
    }
  } catch (err) {
    jobSearch.status = 'error';
    jobSearch.error = err && err.message ? err.message : 'The search failed.';
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label || 'Search jobs';
    }
    renderSearchProviders();
    renderSearchResults();
    renderSearchPager();
  }
}

function trackSearchJob(id) {
  const job = jobSearch.jobs.find((entry) => String(entry.id) === String(id));
  if (!job) return;
  openAddJob({
    url: job.url,
    company: job.company,
    position: job.title,
    description: job.description || ''
  });
}

function sendSearchJob(id) {
  const job = jobSearch.jobs.find((entry) => String(entry.id) === String(id));
  if (!job) return;
  openShareModal({
    company: job.company,
    position: job.title,
    url: job.url,
    jobDescription: job.description || ''
  });
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
  const gcal = googleCalendarLink({
    title: eventTitle(event),
    at: event.at,
    details: (app.company ? app.company + ' · ' : '') + eventKindLabel(event)
  });

  return '<div class="event-row' + past + '">' +
    '<span class="event-kind' + (event.kind === 'reminder' ? ' reminder' : '') + '"></span>' +
    '<span class="event-row-main">' +
    '<strong>' + escapeHtml(eventTitle(event)) + '</strong>' +
    '<span>' + escapeHtml(sub) + '</span>' +
    '</span>' +
    gcal +
    '<button class="event-del" type="button" data-event-del="' + escapeHtml(event.id) + '" title="Remove event" aria-label="Remove event">×</button>' +
    '</div>';
}

function renderCalScopeFilter() {
  const select = $('#calScopeFilter');
  if (!select) return;

  select.innerHTML = '<option value="all">All sources</option>' +
    '<option value="me">Just mine</option>' +
    state.space.circles.map((circle) => (
      '<option value="' + escapeHtml(circle.id) + '">' + escapeHtml(circle.name) + '</option>'
    )).join('');

  if (calendarScope !== 'all' && calendarScope !== 'me' &&
      !state.space.circles.some((circle) => circle.id === calendarScope)) {
    calendarScope = 'all';
  }
  select.value = calendarScope;
}

function renderCalendar() {
  const grid = $('#calDays');
  if (!grid) return;

  renderCalScopeFilter();

  const month = calendarState.month;
  const items = calendarVisibleItems();
  const byDay = new Map();
  items.forEach((item) => {
    const key = dayKey(item.at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  });

  const monthItems = items.filter((item) => {
    const date = new Date(item.at);
    return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth();
  });

  const monthEl = $('#calMonth');
  if (monthEl) monthEl.textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const countEl = $('#calEventCount');
  if (countEl) {
    countEl.textContent = monthItems.length
      ? monthItems.length + (monthItems.length === 1 ? ' item' : ' items')
      : 'No items';
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
    const dayItems = byDay.get(key) || [];
    const classes = ['cal-day'];
    if (date.getMonth() !== month.getMonth()) classes.push('out');
    if (key === todayKey) classes.push('today');
    if (key === calendarState.selected) classes.push('selected');

    const dots = dayItems.slice(0, 3)
      .map((item) => '<span class="cal-dot' +
        (item.source === 'task' ? ' task' : item.source === 'crm' ? ' crm' :
          item.source === 'project' ? ' project' : item.kind === 'reminder' ? ' reminder' : '') +
        (item.done ? ' done' : '') + '"></span>')
      .join('');
    const more = dayItems.length > 3
      ? '<span class="cal-more">+' + (dayItems.length - 3) + '</span>'
      : '';
    const label = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    cells += '<button type="button" class="' + classes.join(' ') + '" data-cal-day="' + key + '" ' +
      'aria-label="' + escapeHtml(label + (dayItems.length ? ', ' + dayItems.length + ' items' : '')) + '">' +
      '<span class="cal-day-num">' + date.getDate() + '</span>' +
      (dayItems.length ? '<span class="cal-dots">' + dots + more + '</span>' : '') +
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

  const dayItems = byDay.get(calendarState.selected) || [];
  const selectedCount = $('#calSelectedCount');
  if (selectedCount) {
    selectedCount.textContent = dayItems.length
      ? dayItems.length + (dayItems.length === 1 ? ' item' : ' items')
      : '';
  }

  const dayList = $('#calDayList');
  if (dayList) {
    dayList.innerHTML = dayItems.length
      ? dayItems.map((item) => scheduleRowHtml(item)).join('')
      : '<div class="event-empty">Nothing scheduled this day</div>';
  }

  // Anchor "Upcoming" to the day being viewed, not always to today. Selecting a
  // future date should not leave earlier events labelled as upcoming; selecting
  // a past date still starts from now so the list never begins in the past.
  const now = Date.now();
  const selectedStart = new Date(calendarState.selected + 'T00:00:00').getTime();
  const anchor = Number.isFinite(selectedStart) ? Math.max(now, selectedStart) : now;
  const horizon = startOfDay(new Date(anchor)).getTime() + 30 * DAY_MS;
  const upcoming = items.filter((item) => {
    const at = new Date(item.at).getTime();
    return at >= anchor && at <= horizon;
  });

  const upcomingHost = $('#calUpcoming');
  if (upcomingHost) {
    upcomingHost.innerHTML = upcoming.length
      ? upcoming.slice(0, 6).map((item) => scheduleRowHtml(item, { withDay: true })).join('')
      : '<div class="event-empty">No tasks, interviews, or reminders in the next 30 days</div>';
  }

  const foot = $('#calFoot');
  if (foot) {
    foot.textContent = upcoming.length
      ? upcoming.length + (upcoming.length === 1 ? ' item' : ' items') + ' in the next 30 days'
      : 'Add a task or an interview to see it here';
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
    : '<div class="event-empty">No interviews or reminders yet — add one below</div>';
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

async function removeEventConfirmed(eventId) {
  const ok = await confirmAction({
    title: 'Remove this event?',
    message: 'It can be re-added later.',
    confirmLabel: 'Remove'
  });
  if (!ok) return;
  removeEvent(eventId);
}

// ---------------------------------------------------------------- Profile form

let profileEditing = false;
let profileEditSnapshot = null;

const PROFILE_EDIT_TARGETS = {
  name: '#profileName',
  headline: '#profileHeadline',
  email: '#profileEmail',
  phone: '#profilePhone',
  location: '#profileLocation',
  linkedin: '#profileLinkedin',
  github: '#profileGithub',
  website: '#profileWebsite',
  summary: '#profileSummary',
  skills: '#profileSkills',
  resume: '#profileResumeText',
  photo: '#profilePhotoBtn'
};

function profileViewField(key, label, value, placeholder, extraClass = '') {
  const text = String(value || '').trim();
  return '<button type="button" class="profile-read-field' + (extraClass ? ' ' + extraClass : '') +
    '" data-profile-edit="' + key + '" aria-label="Edit ' + escapeHtml(label) + '">' +
    '<span class="profile-read-label">' + escapeHtml(label) + '</span>' +
    '<span class="profile-read-value' + (text ? '' : ' is-empty') + '">' +
      escapeHtml(text || placeholder) +
    '</span>' +
  '</button>';
}

function profileContactItem(key, label, value) {
  const text = String(value || '').trim();
  return '<button type="button" class="profile-contact-item' + (text ? '' : ' is-empty') +
    '" data-profile-edit="' + key + '" aria-label="Edit ' + escapeHtml(label) + '">' +
    escapeHtml(text || 'Add ' + label.toLowerCase()) +
  '</button>';
}

function renderProfileView() {
  const host = $('#profileView');
  if (!host) return;

  const profile = state.profile;
  const photo = profilePhoto();
  const name = String(profile.name || '').trim();
  const headline = String(profile.headline || '').trim();
  const summary = String(profile.summary || '').trim();
  const skills = Array.isArray(profile.skills) ? profile.skills.filter(Boolean) : [];
  const resumeText = String(profile.resumeText || '').trim();
  const excerpt = normalizeWhitespace(resumeText).replace(/\n+/g, ' ').slice(0, 300);
  const resumeLabel = resumeText
    ? (profile.resumeFileName || 'Pasted resume') + ' · ' + wordCount(resumeText) + ' words'
    : 'No resume on file';

  host.innerHTML =
    '<div class="profile-sheet-head">' +
      '<button type="button" class="profile-photo profile-photo-edit' + (photo ? ' has-photo' : '') +
        '" data-profile-edit="photo" aria-label="Edit profile photo">' +
        (photo ? '<img src="' + photo + '" alt="">' : escapeHtml(initials(name))) +
      '</button>' +
      '<div class="profile-sheet-identity">' +
        '<button type="button" class="profile-read-name' + (name ? '' : ' is-empty') + '" data-profile-edit="name" aria-label="Edit name">' +
          escapeHtml(name || 'Add your name') +
        '</button>' +
        '<button type="button" class="profile-read-headline' + (headline ? '' : ' is-empty') + '" data-profile-edit="headline" aria-label="Edit headline">' +
          escapeHtml(headline || 'Add the role you want next') +
        '</button>' +
        '<div class="profile-sheet-contact">' +
          profileContactItem('email', 'Email', profile.email) +
          profileContactItem('phone', 'Phone', profile.phone) +
          profileContactItem('location', 'Location', profile.location) +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="profile-sheet-section">' +
      '<h3>Summary</h3>' +
      '<button type="button" class="profile-read-block' + (summary ? '' : ' is-empty') + '" data-profile-edit="summary" aria-label="Edit summary">' +
        escapeHtml(summary || 'Add a short summary of your focus, strengths, and the roles you want.') +
      '</button>' +
    '</div>' +

    '<div class="profile-sheet-section">' +
      '<h3>Skills</h3>' +
      '<button type="button" class="profile-read-skills' + (skills.length ? '' : ' is-empty') + '" data-profile-edit="skills" aria-label="Edit skills">' +
        (skills.length
          ? skills.map((skill) => '<span class="profile-skill-chip">' + escapeHtml(skill) + '</span>').join('')
          : 'Add skills') +
      '</button>' +
    '</div>' +

    '<div class="profile-sheet-section">' +
      '<h3>Links</h3>' +
      '<div class="profile-read-grid">' +
        profileViewField('linkedin', 'LinkedIn', profile.links.linkedin, 'Add LinkedIn') +
        profileViewField('github', 'GitHub', profile.links.github, 'Add GitHub') +
        profileViewField('website', 'Portfolio', profile.links.website, 'Add portfolio', 'span-2') +
      '</div>' +
    '</div>' +

    '<div class="profile-sheet-section">' +
      '<h3>Resume</h3>' +
      '<button type="button" class="profile-read-resume' + (resumeText ? '' : ' is-empty') + '" data-profile-edit="resume" aria-label="Edit resume">' +
        '<span class="profile-read-label">Base resume</span>' +
        '<span class="profile-read-value' + (resumeText ? '' : ' is-empty') + '">' + escapeHtml(resumeLabel) + '</span>' +
        '<span class="profile-resume-excerpt">' +
          escapeHtml(resumeText
            ? excerpt + (resumeText.length > 300 ? '…' : '')
            : 'Upload or paste a resume so knomad can tailor it for each job.') +
        '</span>' +
      '</button>' +
    '</div>';
}

function renderProfileMode() {
  const form = $('#profileForm');
  const view = $('#profileView');
  const editBtn = $('#profileEditBtn');
  if (!form || !view) return;

  form.hidden = !profileEditing;
  view.hidden = profileEditing;
  if (editBtn) editBtn.hidden = profileEditing;
  if (!profileEditing) renderProfileView();
}

function enterProfileEdit(field) {
  if (!profileEditing) {
    profileEditing = true;
    profileEditSnapshot = normalizeProfile(JSON.parse(JSON.stringify(state.profile)));
    applyProfileToForm();
    renderProfileResumeMeta();
    renderProfileMode();
  }

  const target = $(PROFILE_EDIT_TARGETS[field] || PROFILE_EDIT_TARGETS.name);
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function cancelProfileEdit(options = {}) {
  if (profileEditSnapshot) {
    const current = state.profile;
    state.profile = normalizeProfile({
      ...profileEditSnapshot,
      photo: current.photo,
      resumeFileKey: current.resumeFileKey
    });
    saveProfile();
  }

  profileEditing = false;
  profileEditSnapshot = null;
  applyProfileToForm();
  renderProfileResumeMeta();
  renderProfileMode();
  if (!options.silent) toast('Changes discarded');
}

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
  renderProfilePhoto();
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
  profileEditing = false;
  profileEditSnapshot = null;
  renderProfileResumeMeta();
  renderProfileMode();
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

    if (cloudReady()) {
      uploadResumeFile(file)
        .then((uploaded) => {
          if (!uploaded || !uploaded.key) return;
          state.profile.resumeFileKey = uploaded.key;
          saveProfile();
          toast('Original resume archived to Neon Object Storage');
        })
        .catch((err) => console.warn('Resume archive failed', err.message));
    }
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
  const module = await import('jszip');
  const JSZip = module.default || module;
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
  const module = await import('pdfjs-dist');
  const pdfjsLib = module.default || module;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
  if (modal.id === 'addJobModal') resolveQuestionsResponse('closed');
  if (modal.id === 'confirmModal') settleConfirm(false);
  if (!$$('.modal').some((item) => !item.hidden)) {
    document.body.classList.remove('modal-open');
  }
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
}

function closeTopModal() {
  const open = $$('.modal').filter((modal) => !modal.hidden);
  if (open.length) closeModal(open[open.length - 1]);
}

// ---------------------------------------------------------------- Confirm card

// Destructive actions use one shared card instead of the browser's native
// confirm(). Cancel, Escape, and backdrop clicks all resolve false; the accept
// button resolves true. Cancel is focused first so Enter never deletes by accident.
let confirmResolver = null;

function settleConfirm(result) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve(result);
}

function confirmAction(options = {}) {
  const modal = $('#confirmModal');
  if (!modal) return Promise.resolve(window.confirm(options.message || 'Are you sure?'));
  settleConfirm(false);

  const danger = options.tone !== 'neutral';
  const panel = modal.querySelector('.modal-panel');
  if (panel) panel.classList.toggle('is-danger', danger);
  const eyebrow = $('#confirmEyebrow');
  if (eyebrow) eyebrow.textContent = danger ? 'Destructive action' : 'Please confirm';
  const title = $('#confirmTitle');
  if (title) title.textContent = options.title || 'Are you sure?';
  const message = $('#confirmMessage');
  if (message) message.textContent = options.message || '';
  const cancel = $('#confirmCancelBtn');
  if (cancel) cancel.textContent = options.cancelLabel || 'Cancel';
  const accept = $('#confirmAcceptBtn');
  if (accept) {
    accept.textContent = options.confirmLabel || (danger ? 'Delete' : 'Confirm');
    accept.className = 'btn ' + (danger ? 'danger' : 'primary');
  }

  openModal(modal);
  return new Promise((resolve) => { confirmResolver = resolve; });
}

// ---------------------------------------------------------------- Add job

let currentDetailId = null;
let addJobPrefill = null;

function openAddJob(prefill) {
  if (!state.profile.resumeText) {
    toast('Add your resume first, then knomad can tailor it.', 'error');
    showPage('profile');
    const field = $('#profileResumeText');
    if (field) setTimeout(() => field.focus(), 200);
    return;
  }
  resetAddJob();

  const seed = prefill && typeof prefill === 'object' && prefill.url ? prefill : null;
  if (seed) {
    addJobPrefill = {
      url: seed.url || '',
      company: seed.company || '',
      position: seed.position || '',
      description: seed.description || ''
    };
    const urlInput = $('#jobUrl');
    if (urlInput) urlInput.value = addJobPrefill.url;
    const pasteInput = $('#jobPaste');
    if (pasteInput && addJobPrefill.description) {
      pasteInput.value = addJobPrefill.description;
      const details = pasteInput.closest('details');
      if (details) details.open = true;
    }
  }

  openModal($('#addJobModal'));
}

function resetAddJob() {
  addJobPrefill = null;
  verifySession = null;
  questionsResolver = null;
  const form = $('#addJobForm');
  if (form) form.reset();
  const wrap = $('#addJobFormWrap');
  if (wrap) wrap.hidden = false;
  const progress = $('#jobProgress');
  if (progress) progress.hidden = true;
  const error = $('#jobError');
  if (error) error.hidden = true;
  const questionsWrap = $('#questionsWrap');
  if (questionsWrap) questionsWrap.hidden = true;
  const verifyWrap = $('#verifyWrap');
  if (verifyWrap) verifyWrap.hidden = true;
  const questionsFields = $('#questionsFields');
  if (questionsFields) questionsFields.innerHTML = '';

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

  let page = null;
  let job = null;
  let pack = null;
  let clarifications = '';

  try {
    setStep('read', 'running');

    if (pasted) {
      page = { text: pasted, html: '', via: 'paste' };
      setStep('read', 'done', 'pasted text');
    } else {
      page = await fetchJobPage(rawUrl);
      setStep('read', 'done', page.via);
    }

    job = extractJobInfo(page, rawUrl);

    if (addJobPrefill && pasted && addJobPrefill.description && pasted === addJobPrefill.description) {
      job.company = addJobPrefill.company || job.company;
      job.position = addJobPrefill.position || job.position;
      job.description = addJobPrefill.description;
    }

    // Ask the user a few grounded questions before generating.
    setStep('questions', 'running');
    const questions = buildQuestions(state.profile, job);
    if (questions) {
      state.questionState = { questions };
      openQuestionsModal(questions);
      const outcome = await waitForQuestionsResponse();
      if (outcome === 'closed') {
        resetAddJob();
        return;
      }
      clarifications = outcome === 'answered' ? collectQuestionAnswers() : '';
      closeQuestionsModal();
      setStep('questions', 'done', clarifications ? 'answered' : 'skipped');
    } else {
      setStep('questions', 'done', 'none needed');
    }

    // Generate.
    $('#jobProgress').hidden = false;
    setStep('tailor', 'running');
    pack = await buildJobPack({
      company: job.company,
      position: job.position,
      description: job.description,
      url: rawUrl
    }, clarifications);
    setStep('tailor', 'done', pack.source === 'ai' ? 'Gemini' : pack.source === 'ai-gateway' ? 'Neon AI Gateway' : 'basic mode');

    // Verify before filing.
    setStep('verify', 'running');
    const flagged = (pack.resume || '').trim()
      ? verifyResume(pack.resume, { clarifications })
      : [];

    if (flagged.length) {
      showVerifyScreen(pack, job, flagged, rawUrl, clarifications);
      return;
    }

    setStep('verify', 'done', 'clean');
    await saveApplication(pack, job, rawUrl, clarifications);
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

let questionsResolver = null;
let verifySession = null;

function waitForQuestionsResponse() {
  if (!$('#questionsForm')) return Promise.resolve('closed');
  return new Promise((resolve) => {
    questionsResolver = resolve;
  });
}

function resolveQuestionsResponse(outcome) {
  const resolve = questionsResolver;
  questionsResolver = null;
  if (resolve) resolve(outcome || 'closed');
}

function showVerifyScreen(pack, job, flagged, rawUrl, clarifications) {
  verifySession = { job, rawUrl, clarifications };
  if ($('#addJobModal').hidden) openModal($('#addJobModal'));
  $('#addJobFormWrap').hidden = true;
  $('#questionsWrap').hidden = true;
  $('#verifyWrap').hidden = false;
  $('#jobProgress').hidden = true;
  $('#verifySub').textContent = 'Found ' + flagged.length + ' passage' + (flagged.length === 1 ? '' : 's') +
    ' that ' + (flagged.length === 1 ? 'mentions details' : 'mention details') +
    ' not obviously in your profile, base resume, or your notes. Check them before saving.';

  const whyFor = {
    date: 'A date here is not traceable to your profile, base resume, or your notes — it could be a year, month, or range the generator inferred from the posting.',
    year: 'A year here is not traceable to your profile, base resume, or your notes — only your real employment dates should appear on the tailored resume.',
    metric: 'A number or metric here is not traceable to your profile, base resume, or your notes — do not keep a figure you did not actually achieve.',
    'possible company or org name': 'This looks like a company or organization name that is not traceable to your profile, base resume, or your notes — verify you actually worked or volunteered there.',
  };

  const host = $('#verifyDetails');
  if (host) {
    host.innerHTML = flagged
      .map((item, index) => {
        const why = whyFor[item.reason] || 'This detail is not obviously from your profile, base resume, or your notes.';
        return '<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:8px">' +
          '<p class="label-mono" style="margin:0 0 2px;color:var(--amber)">' + (index + 1) + '. Possible ' + escapeHtml(item.reason) + '</p>' +
          '<p style="margin:0 0 4px">' + escapeHtml(item.line) + '</p>' +
          '<p class="muted small" style="margin:0 0 8px">Why this is flagged: ' + escapeHtml(why) + '</p>' +
          '</div>';
      })
      .join('');
  }

  $('#verifyDiscardBtn').onclick = () => {
    verifySession = null;
    closeModal($('#addJobModal'));
    resetAddJob();
  };

  $('#verifyEditBtn').onclick = () => {
    $('#verifyWrap').hidden = true;
    const questions = buildQuestions(state.profile, job);
    state.questionState = { questions };
    const previous = splitClarificationsToAnswers(questions, clarifications || '');
    openQuestionsModal(questions);
    renderQuestionsUI(questions, previous);
    $('#jobProgress').hidden = true;
  };

  $('#verifySaveBtn').onclick = async () => {
    verifySession = null;
    $('#verifyWrap').hidden = true;
    await saveApplication(pack, job, rawUrl, clarifications);
  };
}

async function regenerateFromVerify() {
  const session = verifySession;
  if (!session) return;
  const clarifications = collectQuestionAnswers();
  closeQuestionsModal();
  $('#jobProgress').hidden = false;
  setStep('tailor', 'running');

  try {
    const pack = await buildJobPack({
      company: session.job.company,
      position: session.job.position,
      description: session.job.description,
      url: session.rawUrl
    }, clarifications);
    setStep('tailor', 'done', pack.source === 'ai' ? 'Gemini' : pack.source === 'ai-gateway' ? 'Neon AI Gateway' : 'basic mode');

    setStep('verify', 'running');
    const flagged = (pack.resume || '').trim()
      ? verifyResume(pack.resume, { clarifications })
      : [];

    if (flagged.length) {
      showVerifyScreen(pack, session.job, flagged, session.rawUrl, clarifications);
      return;
    }

    setStep('verify', 'done', 'clean');
    verifySession = null;
    await saveApplication(pack, session.job, session.rawUrl, clarifications);
  } catch (err) {
    failRunningStep();
    const errorBox = $('#jobError');
    const errorText = $('#jobErrorText');
    if (errorText) {
      errorText.textContent = err && err.message
        ? err.message
        : 'Something went wrong while regenerating that draft.';
    }
    if (errorBox) errorBox.hidden = false;
  }
}

async function saveApplication(pack, job, rawUrl, clarifications) {
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
    jobDescription: job.description || '',
    clarifications: clarifications || ''
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
  } else if (pack.source === 'ai-gateway') {
    toast('Application tailored with Neon AI Gateway and filed');
  } else if (pack.aiError) {
    toast('AI tailoring failed, so knomad saved a basic draft. Check Settings.', 'error');
  } else {
    toast('Saved in basic mode. Add a Gemini key or sign in for full rewrites.');
  }
}

// ---------------------------------------------------------------- Clarifying questions

const QUESTION_TEMPLATES = [
  {
    label: 'What facts am I relying on?',
    selector: (profile, job, resumeText) => {
      const resume = String(resumeText || '').toLowerCase();
      const posting = String((job.description || '') + ' ' + (job.position || '')).toLowerCase();
      const important = extractPostingRequirements(posting);
      if (!important.length) return null;
      const covered = important.filter((req) => resume.includes(req.word));
      const gap = important.filter((req) => !covered.includes(req));
      if (!gap.length) return null;
      const items = gap.slice(0, 3).map((req) => {
        const coveredText = covered.length
          ? ' Your base resume already mentions: ' + covered.map((c) => c.sample).join('; ').
            replace(/\s+/g, ' ').
            trim()
          : '';
        return 'The posting emphasizes ' + req.phrase + '. ' +
          'Is that something you have direct experience with? If yes, briefly note the project or role; if no, leave it out.' +
          coveredText;
      });
      return {
        intro: 'A few things the posting wants don\'t obviously appear in your base resume. Confirm only what\'s true.',
        items,
        fieldLabel: 'Your notes (optional)'
      };
    }
  },
  {
    label: 'Which experience should lead?',
    selector: (profile, job, resumeText) => {
      const resume = String(resumeText || '').toLowerCase();
      const posting = String((job.description || '') + ' ' + (job.position || '')).toLowerCase();
      const target = (job.position || 'this role');
      const match = findCloserExperience(resume, posting, target);
      if (!match) return null;
      return {
        intro: 'Pick the one or two projects from your base resume that best match this role.',
        items: [
          'Your base resume mentions: ' + match.sample +
            '. Is that the experience you want front and center for ' + target + '? If not, briefly name the one you do want used.',
          'Any of the above that should be de-emphasized or left off for this application?'
        ],
        fieldLabel: 'Which experience to lead with (optional)'
      };
    }
  },
  {
    label: 'Anything true that the base resume omits?',
    selector: () => ({
      intro: 'Only include facts that are genuinely true and not already in your base resume or profile.',
      items: [
        'Is there a skill, project, certification, degree, or role that your base resume omits but that is true and relevant here? If yes, briefly state it — otherwise leave blank.',
        'Any dates, titles, company names, or numbers you want used exactly as written?'
      ],
      fieldLabel: 'Additional true facts (optional)'
    })
  }
];

function extractPostingRequirements(posting) {
  const words = [];
  const seen = new Set();
  for (const word of SKILL_WORDS) {
    if (seen.has(word)) continue;
    seen.add(word);
    if (posting.includes(word)) {
      words.push({ word, phrase: word, sample: word });
    }
  }
  const requirements = [
    'typescript', 'react', 'next.js', 'node.js', 'python', 'sql',
    'aws', 'docker', 'kubernetes', 'terraform', 'graphql', 'rest', 'api',
    'agile', 'scrum', 'jira', 'kanban', 'accessibility', 'ux', 'ui',
    'machine learning', 'data analysis', 'data visualization', 'analytics',
    'seo', 'content marketing', 'product management', 'project management',
    'customer success', 'leadership', 'stakeholder management', 'communication',
    'copywriting', 'email marketing', 'paid media', 'crm', 'salesforce',
    'excel', 'tableau', 'power bi', 'photoshop', 'illustrator'
  ];
  for (const word of requirements) {
    if (seen.has(word)) continue;
    seen.add(word);
    if (posting.includes(word)) {
      words.push({ word, phrase: word, sample: word });
    }
  }
  return words.slice(0, 6);
}

function findCloserExperience(resume, posting, target) {
  const lines = resume.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const scored = lines
    .map((line) => {
      const lower = line.toLowerCase();
      let score = 0;
      for (const word of SKILL_WORDS) {
        if (lower.includes(word) && posting.includes(word)) score += 1;
      }
      return { line, score };
    })
    .filter((item) => item.score > 0 && item.line.length > 8 && item.line.length < 160);
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ? { sample: scored[0].line } : null;
}

function buildQuestions(profile, job) {
  const resumeText = profile.resumeText || '';
  const selected = QUESTION_TEMPLATES
    .map((tpl) => tpl.selector(profile, job, resumeText))
    .filter(Boolean);
  if (!selected.length) return null;

  const intro = selected.map((s) => s.intro).filter(Boolean).join('\n');
  const items = selected.flatMap((s) => s.items);
  const fieldLabel = selected[selected.length - 1].fieldLabel;

  return { intro, items, fieldLabel };
}

function renderQuestionsUI(state, priorAnswers) {
  const host = $('#questionsFields');
  if (!host) return;
  if (!state) {
    host.innerHTML = '<p class="field-help">No specific gaps found. You can skip straight to generation.</p>';
    return;
  }

  const prior = (priorAnswers || []).filter(Boolean);
  let html = '';
  if (state.intro) {
    html += '<p class="field-help">' + escapeHtml(state.intro) + '</p>';
  }
  state.items.forEach((item, index) => {
    const value = (index < prior.length ? prior[index] : '');
    html += '<div class="field"><label>' + escapeHtml(item) + '</label>' +
      '<textarea id="questionAnswer-' + index + '" rows="3" placeholder="Brief note, or leave blank.">' +
      escapeHtml(value) + '</textarea></div>';
  });
  const freeformValue = (prior.length > state.items.length ? prior[state.items.length] : '');
  html += '<div class="field"><label>' + escapeHtml(state.fieldLabel) + '</label>' +
    '<textarea id="questionFreeform" rows="2" placeholder="Anything else true that the base resume omits — or leave blank.">' +      escapeHtml(freeformValue) + '</textarea></div>';
  host.innerHTML = html;
}

function collectQuestionAnswers() {
  const answers = [];
  let index = 0;
  while ($('#questionAnswer-' + index)) {
    const ta = $('#questionAnswer-' + index);
    if (ta) answers.push(normalizeWhitespace(ta.value));
    index += 1;
  }
  const freeform = $('#questionFreeform');
  if (freeform) answers.push(normalizeWhitespace(freeform.value));
  return answers.filter(Boolean).join('\n');
}

function splitClarificationsToAnswers(questions, clarifications) {
  if (!questions || !questions.items || !clarifications) return null;
  const count = questions.items.length;
  const lines = clarifications.split('\n').map((l) => normalizeWhitespace(l)).filter(Boolean);
  const answers = [];
  for (let i = 0; i < count; i += 1) {
    answers.push(lines[i] || '');
  }
  if (lines.length > count) {
    answers.push(lines.slice(count).join('\n'));
  }
  return answers.length ? answers : null;
}

function openQuestionsModal(state) {
  renderQuestionsUI(state);
  $('#questionsWrap').hidden = false;
  $('#jobProgress').hidden = true;
  const first = $('#questionAnswer-0');
  if (first) setTimeout(() => first.focus(), 60);
}

function closeQuestionsModal() {
  $('#questionsWrap').hidden = true;
  $('#questionsFields').innerHTML = '';
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

async function buildJobPack(job, clarifications) {
  const key = state.geminiKey.trim();
  const attempts = [];

  if (key) {
    attempts.push(['ai', () => generateWithGemini(job, key, clarifications)]);
  }
  if (cloudReady()) {
    attempts.push(['ai-gateway', () => generateWithGateway(job, clarifications)]);
  }

  let lastError = null;
  for (const [source, run] of attempts) {
    try {
      return { ...(await run()), source };
    } catch (err) {
      console.warn(source + ' request failed', err);
      lastError = err;
    }
  }

  return { ...fallbackPack(job), source: 'basic', aiError: lastError ? lastError.message : '' };
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

function buildPrompt(job, clarifications) {
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

  const sourcesBlock = [
    'CANDIDATE PROFILE',
    profileBlock,
    '',
    'BASE RESUME',
    (profile.resumeText || '').slice(0, 20000),
    ''
  ];

  const clarificationsBlock = clarifications
    ? [
      'CANDIDATE CLARIFICATIONS (user-confirmed only)',
      'These are the only facts you may add that are not already in the profile or base resume.',
      'If a detail is not in the profile, the base resume, or these clarifications, leave it out.',
      String(clarifications)
    ]
    : [];

  const jobBlock = [
    '',
    'JOB POSTING',
    'URL: ' + job.url,
    'Company (detected): ' + (job.company || 'unknown'),
    'Role (detected): ' + (job.position || 'unknown'),
    'Description:',
    (job.description || '').slice(0, 20000)
  ];

  return [
    'You are an expert resume writer and interview coach. Tailor the candidate’s resume to the job posting and prepare interview material.',
    '',
    'Sources of truth (in this order): the CANDIDATE PROFILE, the BASE RESUME, and, only if present, CANDIDATE CLARIFICATIONS.',
    'The job posting is for tailoring emphasis and wording only. It is NOT a source of facts about the candidate.',
    '',
    'Rules:',
    '- Never invent employers, job titles, dates, degrees, certifications, school names, metrics, or numbers.',
    '- If a detail is not stated in the profile, the base resume, or the clarifications, leave it out. Prefer a honest gap over an invented one.',
    '- Rephrase, reorder, and emphasize real experience. Only include a keyword if the candidate’s materials already support it.',
    '- The resume must be plain text, fit on one page, and use ALL-CAPS section headings. No markdown symbols such as ** or #. No tables.',
    '- Open the resume with this exact header block, copied verbatim as the first lines. Never alter spelling, email, phone, or links:',
    header || '(no profile header available)',
    '- Keep the whole resume short enough to fit one page. Lead with the experience most relevant to the role; keep bullets tight.',
    '- Interview prep must be plain text with three sections in this order: LIKELY QUESTIONS, QUESTIONS TO ASK, TOPICS TO REVIEW.',
    '- Under LIKELY QUESTIONS, write exactly 6 numbered questions in the form "1. Question?" and put a "Talking point: ..." line under each one.',
    '- Under QUESTIONS TO ASK, write 3 numbered questions. Under TOPICS TO REVIEW, write 5 bullet points starting with "- ".',
    '',
    ...sourcesBlock,
    ...clarificationsBlock,
    ...jobBlock,
    '',
    'Return ONLY valid JSON in this exact shape:',
    '{"company":"","position":"","resume":"","interviewPrep":""}',
    'If the company or role is unclear, infer the most likely answer from the posting.'
  ].join('\n');
}

async function generateWithGemini(job, key, clarifications) {
  const prompt = buildPrompt(job, clarifications);
  const text = await geminiRequest(prompt, key);
  return parseJobPack(text, job);
}

async function generateWithGateway(job, clarifications) {
  const prompt = buildPrompt(job, clarifications);
  const text = await aiChat(prompt);
  return parseJobPack(text, job);
}

function parseJobPack(text, job) {
  const parsed = parseJsonBlock(text);

  if (!parsed || (!parsed.resume && !parsed.interviewPrep)) {
    throw new Error('The model returned an empty result');
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

// ---------------------------------------------------------------- Local resume verification

const DATE_PATTERN = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i;
const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;
const NUMBER_METRIC_PATTERN = /\b(\d+(?:\.\d+)?%|\d+\+?\s*(?:x|times|fold)|(?:more than|over|up to|increased|reduced|grew|saved|generated|led|managed|led a team of|team of)\s+\d+)\b/i;
const COMPANY_LIKE_PATTERN = /\b[A-Z][A-Za-z&.'-]{2,90}\b/;

function scanForPotentiallyInventedFacts(resumeText, profile, baseResume, clarifications) {
  const haystacks = [
    profile.name, profile.headline, profile.email, profile.phone, profile.location,
    (profile.links || []).linkedin, (profile.links || []).github, (profile.links || []).website,
    profile.summary, ...(profile.skills || []),
    baseResume,
    clarifications
  ].filter(Boolean).map(String);

  const normalized = (v) => (v || '').toLowerCase();
  const inAnySource = (token) => haystacks.some((h) => normalized(h).includes(normalized(token)));

  const flagged = [];
  const lines = resumeText.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();

    const dateMatch = line.match(DATE_PATTERN);
    if (dateMatch && !inAnySource(dateMatch[0]) && !inAnySource(profile.email)) {
      flagged.push({ line, reason: 'date', detail: dateMatch[0] });
      continue;
    }

    if (YEAR_PATTERN.test(line)) {
      const yearMatch = line.match(YEAR_PATTERN);
      if (yearMatch && !inAnySource(yearMatch[0])) {
        flagged.push({ line, reason: 'year', detail: yearMatch[0] });
        continue;
      }
    }

    const metricMatch = line.match(NUMBER_METRIC_PATTERN);
    if (metricMatch && !inAnySource(metricMatch[0])) {
      flagged.push({ line, reason: 'metric', detail: metricMatch[0] });
      continue;
    }

    if (companyLiker(line) && !inAnySource(line) && !looksLikeOwnName(line, profile)) {
      const candidate = line.match(COMPANY_LIKE_PATTERN);
      if (candidate && candidate[0].length > 2) {
        flagged.push({ line, reason: 'possible company or org name', detail: candidate[0] });
      }
    }
  }

  return flagged;
}

function companyLiker(line) {
  const lower = line.toLowerCase();
  return /inc\.?|llc|ltd|\bcorp\.?\b|co\.|gmbh|ag|sa|S\.A\.|pty\s*limited|limited\s*liability/i.test(lower)
    || /^(?:at|with|led|managed|worked|senior|junior|staff|principal|lead|head of|director of|vp of)\b/i.test(lower);
}

function looksLikeOwnName(line, profile) {
  if (!profile.name) return false;
  return line.toLowerCase().includes(profile.name.toLowerCase())
    || line.toLowerCase().includes((profile.email || '').split('@')[0].toLowerCase());
}

function verifyResume(resumeText, application) {
  const profile = state.profile;
  const baseResume = profile.resumeText || '';
  const clarifications = application.clarifications || '';
  const flagged = scanForPotentiallyInventedFacts(resumeText, profile, baseResume, clarifications);
  return flagged;
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
  $('#detailJD').textContent = application.jobDescription || 'No job description saved';
  $('#detailResume').textContent = application.resume || '';
  $('#detailPrep').textContent = application.interviewPrep || 'No interview brief saved';

  const resumeMeta = $('#resumeMetaLine');
  if (resumeMeta) {
    resumeMeta.textContent = application.resume
      ? wordCount(application.resume) + ' words · tailored for ' + (application.position || 'this role') + (application.company ? ' at ' + application.company : '')
      : 'No tailored resume saved yet';
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
    const active = panel.dataset.appPanel === target;
    panel.classList.toggle('active', active);
    panel.setAttribute('aria-hidden', String(!active));
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
    .replace(/^[*_]+|[*_]+$/g, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function cleanResumeInline(value) {
  return String(value || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
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
    headerLines = mainLines.slice(0, firstKnownHeading).map((line) => cleanResumeInline(line)).filter(Boolean);
    bodyStart = firstKnownHeading;
  } else if (firstKnownHeading < 0 && blankIndex >= 0) {
    headerLines = mainLines.slice(0, blankIndex).map((line) => cleanResumeInline(line)).filter(Boolean);
    bodyStart = blankIndex + 1;
  } else if (firstKnownHeading < 0) {
    headerLines = mainLines.map((line) => cleanResumeInline(line)).filter(Boolean);
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
  let lastListItem = null;
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
    const value = paragraph.join('\n').trim();
    paragraph = [];
    if (value) ensureSection().items.push({ type: 'p', text: value });
  };

  for (let i = bodyStart; i < mainLines.length; i += 1) {
    const line = mainLines[i].trim();
    if (!line) {
      flushParagraph();
      lastListItem = null;
      continue;
    }

    if (!bodyHasContent) {
      if (!current && headerTokens.has(line.toLowerCase())) continue;
      bodyHasContent = true;
    }

    const title = resumeHeadingTitle(line);
    if (title) {
      flushParagraph();
      lastListItem = null;
      current = { title, items: [] };
      result.sections.push(current);
      continue;
    }

    if (/^[-•*–—]\s+/.test(line)) {
      flushParagraph();
      lastListItem = {
        type: 'li',
        text: cleanResumeInline(line.replace(/^[-•*–—]\s+/, ''))
      };
      ensureSection().items.push(lastListItem);
      continue;
    }

    // A wrapped line inside a bullet continues that bullet, the way Markdown
    // treats a lazy continuation. Without this, wrapped resume bullets break
    // out of the list and sit flush against the margin.
    if (lastListItem) {
      lastListItem.text = (lastListItem.text + ' ' + cleanResumeInline(line)).trim();
      continue;
    }

    paragraph.push(cleanResumeInline(line));
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
    : '<div class="resume-empty"><span>No tailored resume saved yet</span><span>Add a job to generate one</span></div>';
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
  const module = await import('jspdf');
  const JsPDF = module.jsPDF || (module.default && module.default.jsPDF);
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
    const logicalLines = text.split('\n');

    logicalLines.forEach((logicalLine) => {
      const value = logicalLine.trim();
      if (!value) {
        y += lineHeight * 0.45;
        return;
      }
      const lines = doc.splitTextToSize(value, contentWidth - indent);
      lines.forEach((line, index) => {
        ensureSpace(lineHeight);
        if (bullet && index === 0) doc.text('•', margin + 2, y + size);
        doc.text(line, margin + indent, y + size);
        y += lineHeight;
      });
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
    '<h4>Practice the conversation, one question at a time</h4>' +
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
    '<div class="practice-progress" role="progressbar" aria-label="Practice progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><span style="width:' + percent + '%"></span></div>' +
    '<h4 class="practice-question">' + escapeHtml(question.text) + '</h4>' +
    '<div class="practice-hint" id="practiceHint" hidden>' + escapeHtml(question.hint) + '</div>' +
    '<textarea class="practice-answer" id="practiceAnswer" aria-label="Your answer to question ' + (index + 1) + '" placeholder="Write your answer the way you would say it out loud…">' + escapeHtml(answer) + '</textarea>' +
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
    ? 'Strong, specific answers'
    : score >= 50
      ? 'A solid foundation — tighten the details'
      : 'A good start — add specifics and structure';
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
    '<div class="score-ring ' + tone + '" style="--score:' + score + '" role="img" aria-label="Overall score ' + score + ' out of 100"><span>' + score + '<small>/100</small></span></div>' +
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
  if (meta) meta.textContent = questions.length + ' questions';

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

  const appId = currentDetailId;
  const activeApp = currentApplication();
  const activeSession = activeApp ? activeApp.interviewSession : null;
  const activeIndex = activeSession ? activeSession.index : 0;

  clearTimeout(practiceSaveTimer);
  practiceSaveTimer = setTimeout(() => {
    const target = state.applications.find((app) => String(app.id) === String(appId));
    const session = target ? target.interviewSession : null;
    if (!target || !session || !session.started || session.completed) return;

    const questions = practiceQuestions(target);
    ensurePracticeAnswers(session, questions.length);
    if (activeIndex < 0 || activeIndex >= session.answers.length) return;

    session.answers[activeIndex] = input.value;
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

async function deleteApplication(id) {
  const application = state.applications.find((app) => String(app.id) === String(id));
  if (!application) return;
  const label = application.company + ' — ' + application.position;
  const ok = await confirmAction({
    title: 'Delete application?',
    message: 'Delete ' + label + '? This cannot be undone.',
    confirmLabel: 'Delete'
  });
  if (!ok) return;

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

function cloudStatusText() {
  if (!cloudConfig.configured) return 'Cloud sync is not configured in this build';
  if (!state.cloud.user) return 'Signed out';
  if (state.cloud.status === 'syncing') return 'Syncing…';
  if (state.cloud.status === 'error') return state.cloud.error || 'Sync error';
  if (state.cloud.status === 'polling') return state.cloud.error || 'Live updates paused — polling every 30s';
  if (state.cloud.status === 'synced') {
    const when = state.cloud.lastSync
      ? new Date(state.cloud.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    return 'Synced' + (when ? ' · ' + when : '') + (state.cloud.realtime ? ' · live' : '');
  }
  return 'Not synced yet';
}

function renderAccount() {
  const card = $('#accountCard');
  if (!card) return;

  const badge = $('#accountBadge');
  const signedOut = $('#accountSignedOut');
  const signedIn = $('#accountSignedIn');
  const intro = $('#accountIntro');
  const emailLabel = $('#accountEmailLabel');
  const statusLine = $('#syncStatus');
  const statusText = $('#syncStatusText');

  const configured = cloudConfig.configured;
  const signedInNow = Boolean(state.cloud.user);
  const status = state.cloud.status;
  const ok = status === 'synced';

  if (badge) {
    badge.textContent = !configured ? 'Not configured' : signedInNow ? 'On' : 'Off';
    badge.classList.toggle('on', ok);
  }

  if (intro) {
    intro.textContent = configured
      ? 'Sign in to sync your profile, applications, and archive originals across devices. Your Gemini key never leaves this device.'
      : 'This build has no Neon Auth or sync Function URL. Set VITE_NEON_AUTH_URL and VITE_NEON_SYNC_URL, then rebuild.';
  }

  if (signedOut) signedOut.hidden = !configured || signedInNow;
  if (signedIn) signedIn.hidden = !signedInNow;

  if (emailLabel) {
    emailLabel.textContent = signedInNow
      ? (state.cloud.user.email || state.cloud.user.name || 'Signed in')
      : '';
  }

  if (statusLine) statusLine.classList.toggle('on', ok);
  if (statusText) statusText.textContent = cloudStatusText();
  renderTogetherBadge();
}

function renderDailyPortalSetting() {
  const select = $('#dailyPortalSelect');
  if (!select) return;

  const current = normalizePortalChoice(state.profile.dailyPortal);
  const auto = resolveDailyPortal('auto', state.profile, dailyReadKeywords());

  select.innerHTML =
    '<option value="auto">Auto — from my profile</option>' +
    DAILY_PORTALS.map((portal) =>
      '<option value="' + escapeHtml(portal.id) + '">' + escapeHtml(portal.label) + '</option>'
    ).join('') +
    '<option value="general">General Wikipedia feed</option>';
  select.value = current;

  const help = $('#dailyPortalHelp');
  if (help) {
    if (current === 'auto') {
      help.textContent = auto ? 'Currently: ' + auto.label + '.' : 'No strong match yet, so the general feed is used.';
    } else if (current === 'general') {
      help.textContent = 'Finishes the day with Wikipedia’s featured and most-read articles.';
    } else {
      const portal = DAILY_PORTALS.find((item) => item.id === current);
      help.textContent = portal
        ? 'Rotates through recognized articles from the ' + portal.label + ' portal.' :
        '';
    }
  }
}

function renderSettings() {
  renderDailyPortalSetting();

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

  const dashActivityToggle = $('#dashActivityToggle');
  if (dashActivityToggle) dashActivityToggle.checked = dashActivity;
  const dashStatusToggle = $('#dashStatusToggle');
  if (dashStatusToggle) dashStatusToggle.checked = dashStatus;

  renderAccount();
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

async function clearKey() {
  if (!state.geminiKey) {
    toast('No key saved');
    return;
  }
  const ok = await confirmAction({
    title: 'Remove the Gemini key?',
    message: 'knomad will stop using this key for AI tailoring on this device.',
    confirmLabel: 'Remove key'
  });
  if (!ok) return;
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

async function resetAll() {
  const ok = await confirmAction({
    title: 'Erase all data?',
    message: cloudReady()
      ? 'This removes your profile, resume, applications, and Gemini key from this browser and your cloud account. It cannot be undone.'
      : 'This removes your profile, resume, applications, and Gemini key from this browser. It cannot be undone.',
    confirmLabel: 'Erase everything'
  });
  if (!ok) return;

  const previousApplications = state.applications.slice();

  localStorage.removeItem(STORE.profile);
  localStorage.removeItem(STORE.applications);
  localStorage.removeItem(STORE.key);
  localStorage.removeItem(NOTIFIED_KEY);

  state.profile = defaultProfile();
  state.applications = [];
  state.geminiKey = '';
  notifiedKeys = new Set();
  profileEditing = false;
  profileEditSnapshot = null;
  currentDetailId = null;
  renderedApplicationId = null;
  applicationTab = 'overview';
  applicationReturnPage = 'dashboard';
  clearTimeout(practiceSaveTimer);
  workingModel = null;

  if (cloudReady()) {
    previousApplications.forEach((application) => queueDoc('application', application.id, null, true));
    queueDoc('profile', 'me', state.profile);
    cloudDiffProfile = JSON.stringify(state.profile);
    cloudDiffApplications.clear();
    flushCloudQueue();
  }

  applyProfileToForm();
  showPage('dashboard');
  toast(cloudReady() ? 'All local and cloud data erased' : 'All local data erased');
}

// ---------------------------------------------------------------- Friends & shared inbox

let socialInFlight = false;
let socialSeenInbox = null;
let socialSeenMessages = null;
let socialGeneration = 0;
let shareJobDraft = { jobDescription: '' };
let shareTab = 'inbox';
const openShareThreads = new Set();
const shareReplyDrafts = new Map();

function resetSocial() {
  socialInFlight = false;
  socialSeenInbox = null;
  socialSeenMessages = null;
  socialGeneration += 1;
  shareTab = 'inbox';
  openShareThreads.clear();
  shareReplyDrafts.clear();
  state.social = {
    status: 'off',
    error: '',
    friends: [],
    incoming: [],
    outgoing: [],
    inbox: [],
    sent: [],
    unread: 0,
    unreadMessages: 0
  };
  renderFriendsBadge();
  if (currentPage === 'together') renderFriends();
}

function socialList(value) {
  return Array.isArray(value) ? value : [];
}

function socialUnreadTotal() {
  return (Number(state.social.unread) || 0) + (Number(state.social.unreadMessages) || 0);
}

function socialThreadFocused() {
  if (currentPage !== 'together' || togetherTab !== 'kniggurs') return false;
  const active = document.activeElement;
  if (!active || !active.matches('[data-share-reply-input]')) return false;
  // Only protect a reply that actually contains text; an empty, focused box can
  // be repainted so new messages still show up.
  return Boolean(active.value && active.value.trim());
}

function renderFriendsBadge() {
  // One rail entry now covers Together and kniggurs, so the unread count
  // shares the Together badge instead of a second badge on the icon.
  renderTogetherBadge();
}

/**
 * Pull the friend list, pending requests, and both sides of the shared inbox in
 * one snapshot. Quiet refreshes happen on the normal 30-second poll; a new
 * unread share raises one toast instead of repainting the page.
 */
async function loadSocial(options = {}) {
  const silent = Boolean(options.silent);
  if (!cloudReady()) {
    renderFriendsBadge();
    renderFriends();
    return;
  }
  if (socialInFlight) return;
  socialInFlight = true;
  const generation = socialGeneration;

  if (!silent && state.social.status !== 'ready') {
    state.social.status = 'loading';
    renderFriends();
  }

  try {
    const data = await api('/social');
    if (generation !== socialGeneration) return;
    const inbox = socialList(data && data.inbox);
    const sent = socialList(data && data.sent);
    const ids = inbox.map((item) => item.id);

    if (socialSeenInbox) {
      const fresh = inbox.filter((item) => !item.readAt && !socialSeenInbox.has(item.id));
      if (fresh.length) {
        const from = (fresh[0].from && fresh[0].from.name) || 'A kniggur';
        toast(fresh.length === 1 ? from + ' sent you a job' : from + ' sent you ' + fresh.length + ' jobs');
      }
    }
    socialSeenInbox = new Set(ids);

    // One toast per refresh for new replies, on either side of the thread.
    const messageEvents = [];
    inbox.forEach((share) => {
      socialList(share.messages).forEach((message) => {
        if (!message.mine) messageEvents.push({ message, share, author: share.from });
      });
    });
    sent.forEach((share) => {
      socialList(share.messages).forEach((message) => {
        if (!message.mine) messageEvents.push({ message, share, author: share.to });
      });
    });

    if (socialSeenMessages) {
      const freshReplies = messageEvents.filter((entry) => !socialSeenMessages.has(entry.message.id));
      if (freshReplies.length) {
        const first = freshReplies[0];
        const who = socialPersonName(first.author);
        const what = first.share.company || first.share.position || 'a job';
        toast(freshReplies.length === 1
          ? who + ' replied about ' + what
          : who + ' sent ' + freshReplies.length + ' replies about ' + what);
      }
    }
    socialSeenMessages = new Set(messageEvents.map((entry) => entry.message.id));

    state.social = {
      status: 'ready',
      error: '',
      friends: socialList(data && data.friends),
      incoming: socialList(data && data.incoming),
      outgoing: socialList(data && data.outgoing),
      inbox,
      sent,
      unread: Number(data && data.unread) || inbox.filter((item) => !item.readAt).length,
      unreadMessages: Number(data && data.unreadMessages) ||
        [...inbox, ...sent].reduce((total, item) => total + (Number(item.messageUnread) || 0), 0)
    };

    renderFriendsBadge();
    // A silent poll must not repaint a reply the person is in the middle of
    // typing; the next refresh carries the new data instead.
    if (silent && socialThreadFocused()) return;
    renderFriends();
    if (currentPage === 'together' && !togetherEditing()) renderTogether();
  } catch (err) {
    if (generation !== socialGeneration) return;
    if (isAuthRequired(err)) {
      handleAuthRequired();
      return;
    }
    state.social.status = 'error';
    state.social.error = err.message || 'Could not load kniggurs';
    if (!silent) renderFriends();
    if (currentPage === 'together' && !togetherEditing()) renderTogether();
  } finally {
    socialInFlight = false;
  }
}

function renderFriends() {
  const configured = cloudConfig.configured;
  const signedIn = Boolean(state.cloud.user);

  const signedOut = $('#friendsSignedOut');
  const signedInPanel = $('#friendsSignedIn');
  if (signedOut) signedOut.hidden = !configured || signedIn;
  if (signedInPanel) signedInPanel.hidden = !signedIn;

  if (!configured && signedOut) {
    const copy = signedOut.querySelector('p');
    if (copy) copy.textContent = 'This build has no Neon Auth or sync Function URL, so kniggurs cannot be added yet.';
  }

  const summary = $('#friendsSummary');
  if (summary) {
    if (!configured) {
      summary.textContent = 'Cloud sync is not configured in this build';
    } else if (!signedIn) {
      summary.textContent = 'Sign in to add kniggurs and share jobs';
    } else if (state.social.status === 'error') {
      summary.textContent = state.social.error;
    } else if (state.social.status === 'loading' || state.social.status === 'off') {
      summary.textContent = 'Loading your kniggurs…';
    } else {
      const count = state.social.friends.length;
      summary.textContent = count + (count === 1 ? ' kniggur' : ' kniggurs') +
        ' · ' + socialUnreadTotal() + ' unread';
    }
  }

  renderFriendsBadge();
  if (!signedIn) return;

  renderFriendRequests();
  renderFriendList();
  renderSharedInbox();
  renderSentShares();
  renderSharedTabs();
}

function userOnline(user) {
  return Boolean(user && user.online);
}

// A small dot after the name, plus a ring on the avatar. Missing or stale
// presence data reads as offline, never as a guess.
function onlineDot(user) {
  if (!userOnline(user)) return '';
  return '<span class="online-dot" title="Online now" aria-label="Online now"></span>';
}

function onlineById(id) {
  return Boolean(id && userOnline(state.space.people[id]));
}

function onlineDotById(id) {
  return id ? onlineDot(state.space.people[id]) : '';
}

function socialAvatar(user) {
  const name = (user && (user.name || user.email)) || '?';
  return '<span class="social-avatar' + (userOnline(user) ? ' is-online' : '') +
    '" aria-hidden="true">' + escapeHtml(initials(name)) + '</span>';
}

function socialPersonName(user) {
  return (user && (user.name || user.email)) || 'Knomad user';
}

function socialNameHtml(user) {
  return escapeHtml(socialPersonName(user)) + onlineDot(user);
}

function personNameHtml(id) {
  return escapeHtml(personName(id)) + onlineDotById(id);
}

function renderFriendRequests() {
  const card = $('#friendRequestsCard');
  const host = $('#friendRequests');
  if (!card || !host) return;

  const incoming = state.social.incoming || [];
  const outgoing = state.social.outgoing || [];
  const total = incoming.length + outgoing.length;
  card.hidden = total === 0;

  const count = $('#requestCount');
  if (count) count.textContent = total ? total + ' pending' : '';
  if (!total) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = [
    ...incoming.map((request) => (
      '<div class="social-person">' +
        socialAvatar(request.from) +
        '<div class="social-person-main">' +
          '<strong>' + socialNameHtml(request.from) + '</strong>' +
          '<span>Wants to be kniggurs</span>' +
        '</div>' +
        '<div class="social-person-actions">' +
          '<button class="btn primary small" type="button" data-accept-request="' + escapeHtml(request.id) + '">Accept</button>' +
          '<button class="btn ghost small" type="button" data-decline-request="' + escapeHtml(request.id) + '">Decline</button>' +
        '</div>' +
      '</div>'
    )),
    ...outgoing.map((request) => (
      '<div class="social-person">' +
        socialAvatar(request.to) +
        '<div class="social-person-main">' +
          '<strong>' + socialNameHtml(request.to) + '</strong>' +
          '<span>Request sent · waiting for them</span>' +
        '</div>' +
        '<div class="social-person-actions">' +
          '<button class="btn ghost small" type="button" data-cancel-request="' + escapeHtml(request.id) + '">Cancel</button>' +
        '</div>' +
      '</div>'
    ))
  ].join('');
}

function renderFriendList() {
  const host = $('#friendList');
  if (!host) return;

  const friends = state.social.friends || [];
  const count = $('#friendCount');
  if (count) count.textContent = friends.length ? friends.length + ' total' : '';

  if (!friends.length) {
    host.innerHTML = '<div class="social-empty">No kniggurs yet. Send a request by email above; once they accept, you can swap job leads here.</div>';
    return;
  }

  host.innerHTML = friends.map((friend) => {
    const detail = friend.headline || friend.email || 'Knomad member';
    return '<div class="social-person">' +
      socialAvatar(friend) +
      '<div class="social-person-main">' +
        '<strong>' + socialNameHtml(friend) + '</strong>' +
        '<span title="' + escapeHtml(friend.email || '') + '">' + escapeHtml(detail) + '</span>' +
      '</div>' +
      '<div class="social-person-actions">' +
        '<button class="btn ghost small" type="button" data-send-to="' + escapeHtml(friend.id) + '">Send job</button>' +
        '<button class="btn quiet-danger small" type="button" data-remove-friend="' + escapeHtml(friend.id) + '">Remove</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function shareRoleHtml(share) {
  const company = share.company || 'Untitled role';
  const position = share.position || '';
  return position
    ? escapeHtml(position) + ' <span>at ' + escapeHtml(company) + '</span>'
    : escapeHtml(company);
}

function shareThreadToggle(share) {
  const open = openShareThreads.has(share.id);
  const replies = socialList(share.messages).length;
  const unread = Number(share.messageUnread) || 0;
  const label = open ? 'Hide replies' : replies
    ? (replies === 1 ? '1 reply' : replies + ' replies')
    : 'Reply';

  return '<button class="btn ghost small share-thread-toggle" type="button" data-share-thread="' +
    escapeHtml(share.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    escapeHtml(label) +
    (unread ? '<span class="share-thread-new">' + unread + ' new</span>' : '') +
  '</button>';
}

function shareThreadHtml(share, friend) {
  if (!openShareThreads.has(share.id)) return '';

  const messages = socialList(share.messages);
  const draft = shareReplyDrafts.get(share.id) || '';
  const rows = messages.length
    ? messages.map((message) => {
        const unread = !message.mine && !message.readAt;
        const author = message.mine ? 'You' : socialNameHtml(friend);
        return '<div class="share-message' + (message.mine ? ' mine' : '') + (unread ? ' unread' : '') + '">' +
          '<div class="share-message-meta">' +
            '<strong>' + author + '</strong>' +
            '<span>' + escapeHtml(relativeDay(message.createdAt)) + '</span>' +
            (unread ? '<span class="unread-dot" aria-hidden="true"></span>' : '') +
          '</div>' +
          '<p>' + escapeHtml(message.body) + '</p>' +
        '</div>';
      }).join('')
    : '<p class="share-thread-empty">No replies yet. Say something about this lead.</p>';

  return '<div class="share-thread">' +
    '<div class="share-thread-list">' + rows + '</div>' +
    '<form class="share-reply" data-share-reply="' + escapeHtml(share.id) + '">' +
      '<textarea data-share-reply-input="' + escapeHtml(share.id) + '" rows="2" maxlength="2000" ' +
        'placeholder="Reply about this job…" aria-label="Reply about this job">' +
        escapeHtml(draft) +
      '</textarea>' +
      '<button class="btn primary small" type="submit">Send</button>' +
    '</form>' +
  '</div>';
}

function renderSharedTabs() {
  const inbox = state.social.inbox || [];
  const sent = state.social.sent || [];

  const inboxTab = $('#inboxTabCount');
  const sentTab = $('#sentTabCount');
  if (inboxTab) inboxTab.textContent = String(inbox.length);
  if (sentTab) sentTab.textContent = String(sent.length);

  const count = $('#inboxCount');
  if (count) {
    const unread = inbox.filter((item) => !item.readAt).length;
    const newReplies = inbox.reduce((total, item) => total + (Number(item.messageUnread) || 0), 0);
    const parts = [];
    if (unread) parts.push(unread + ' unread');
    if (newReplies) parts.push(newReplies + (newReplies === 1 ? ' new reply' : ' new replies'));
    count.textContent = parts.join(' · ');
  }

  document.querySelectorAll('[data-share-tab]').forEach((tab) => {
    const active = tab.dataset.shareTab === shareTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const inboxHost = $('#sharedInbox');
  const sentHost = $('#sentList');
  if (inboxHost) inboxHost.hidden = shareTab !== 'inbox';
  if (sentHost) sentHost.hidden = shareTab !== 'sent';
}

function setShareTab(tab) {
  const next = tab === 'sent' ? 'sent' : 'inbox';
  if (next === shareTab) return;
  shareTab = next;
  renderSharedTabs();
}

function renderSharedInbox() {
  const host = $('#sharedInbox');
  if (!host) return;

  const inbox = state.social.inbox || [];

  if (!inbox.length) {
    host.innerHTML = '<div class="social-empty">Nothing in your inbox yet. When a kniggur sends you a role it lands here, with their note and a one-click track button.</div>';
    return;
  }

  host.innerHTML = inbox.map((share) => {
    const unread = !share.readAt;
    const note = share.note
      ? '<p class="share-note">' + escapeHtml(share.note) + '</p>'
      : '';
    const open = share.url
      ? '<a class="btn ghost small" href="' + escapeHtml(share.url) + '" target="_blank" rel="noopener noreferrer" data-share-link="' + escapeHtml(share.id) + '">Open posting</a>'
      : '';
    const read = unread
      ? '<button class="btn ghost small" type="button" data-share-read="' + escapeHtml(share.id) + '">Mark read</button>'
      : '';

    return '<article class="share-item' + (unread ? ' unread' : '') + '">' +
      '<div class="share-head">' +
        socialAvatar(share.from) +
        '<div class="share-body">' +
          '<p class="share-role">' + shareRoleHtml(share) + '</p>' +
          '<p class="share-meta">' +
            (unread ? '<span class="unread-dot" aria-hidden="true"></span>' : '') +
            '<span>From ' + socialNameHtml(share.from) + '</span>' +
            '<span>·</span>' +
            '<span>' + escapeHtml(relativeDay(share.createdAt)) + '</span>' +
            (share.status === 'saved' ? '<span>· Saved</span>' : '') +
          '</p>' +
          note +
        '</div>' +
      '</div>' +
      '<div class="share-actions">' +
        open +
        shareThreadToggle(share) +
        '<button class="btn subtle small" type="button" data-share-track="' + escapeHtml(share.id) + '">Track job</button>' +
        read +
        '<button class="btn quiet-danger small" type="button" data-share-dismiss="' + escapeHtml(share.id) + '">Dismiss</button>' +
      '</div>' +
      shareThreadHtml(share, share.from) +
    '</article>';
  }).join('');
}

function renderSentShares() {
  const host = $('#sentList');
  if (!host) return;

  const sent = state.social.sent || [];
  if (!sent.length) {
    host.innerHTML = '<div class="social-empty">Nothing sent yet. Jobs you send to kniggurs appear here with the same reply thread.</div>';
    return;
  }

  host.innerHTML = sent.map((share) => {
    const note = share.note
      ? '<p class="share-note">' + escapeHtml(share.note) + '</p>'
      : '';
    return '<article class="share-item">' +
      '<div class="share-head">' +
        socialAvatar(share.to) +
        '<div class="share-body">' +
          '<p class="share-role">' + shareRoleHtml(share) + '</p>' +
          '<p class="share-meta">' +
            '<span>To ' + socialNameHtml(share.to) + '</span>' +
            '<span>·</span>' +
            '<span>' + escapeHtml(relativeDay(share.createdAt)) + '</span>' +
            (share.status === 'dismissed' ? '<span>· Dismissed</span>' : '') +
          '</p>' +
          note +
        '</div>' +
      '</div>' +
      '<div class="share-actions">' +
        (share.url
          ? '<a class="btn ghost small" href="' + escapeHtml(share.url) + '" target="_blank" rel="noopener noreferrer">Open posting</a>'
          : '') +
        shareThreadToggle(share) +
        '<button class="btn quiet-danger small" type="button" data-delete-sent="' + escapeHtml(share.id) + '">Remove</button>' +
      '</div>' +
      shareThreadHtml(share, share.to) +
    '</article>';
  }).join('');
}

async function handleFriendRequest(event) {
  event.preventDefault();
  const input = $('#friendEmail');
  const button = $('#friendRequestBtn');
  const email = input ? input.value.trim() : '';
  if (!email) return;

  if (button) button.disabled = true;
  try {
    const data = await api('/friends/request', { method: 'POST', body: { email } });
    if (input) input.value = '';
    toast(data && data.status === 'accepted' ? 'You are now kniggurs' : 'Kniggur request sent');
    await loadSocial({ silent: true });
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else toast(err.message || 'Could not send that request', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function respondToFriendRequest(requestId, action) {
  try {
    await api('/friends/respond', { method: 'POST', body: { requestId, action } });
    toast(action === 'accept' ? 'Kniggur added' : 'Request declined');
    await loadSocial({ silent: true });
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else toast(err.message || 'Could not update that request', 'error');
  }
}

async function cancelFriendRequest(requestId) {
  try {
    await api('/friends/requests/' + encodeURIComponent(requestId), { method: 'DELETE' });
    toast('Request cancelled');
    await loadSocial({ silent: true });
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else toast(err.message || 'Could not cancel that request', 'error');
  }
}

async function removeFriend(friendId) {
  const friend = (state.social.friends || []).find((entry) => entry.id === friendId);
  const name = friend ? socialPersonName(friend) : 'this kniggur';
  const ok = await confirmAction({
    title: 'Remove kniggur?',
    message: 'Remove ' + name + ' from your kniggurs? They will no longer be able to send you jobs.',
    confirmLabel: 'Remove'
  });
  if (!ok) return;

  try {
    await api('/friends/' + encodeURIComponent(friendId), { method: 'DELETE' });
    toast('Kniggur removed');
    await loadSocial({ silent: true });
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else toast(err.message || 'Could not remove that kniggur', 'error');
  }
}

function patchShareRead(shareId) {
  const share = (state.social.inbox || []).find((entry) => entry.id === shareId);
  if (!share || share.readAt) return;
  share.readAt = new Date().toISOString();
  state.social.unread = Math.max(0, (state.social.unread || 0) - 1);
  renderFriendsBadge();
  if (currentPage === 'together') renderFriends();
}

async function markShareRead(shareId) {
  patchShareRead(shareId);
  try {
    await api('/shares/' + encodeURIComponent(shareId) + '/read', { method: 'POST' });
  } catch {
    // Read state is cosmetic; the next snapshot will tell the truth.
  }
}

async function markShareSaved(shareId) {
  const share = (state.social.inbox || []).find((entry) => entry.id === shareId);
  if (share) share.status = 'saved';
  if (currentPage === 'together') renderFriends();
  try {
    await api('/shares/' + encodeURIComponent(shareId) + '/saved', { method: 'POST' });
  } catch {
    // The saved flag is cosmetic; the next snapshot will tell the truth.
  }
}

function trackSharedJob(shareId) {
  const share = (state.social.inbox || []).find((entry) => entry.id === shareId);
  if (!share) return;
  markShareRead(shareId);
  markShareSaved(shareId);
  openAddJob({
    url: share.url || '',
    company: share.company || '',
    position: share.position || '',
    description: share.jobDescription || share.note || ''
  });
}

async function dismissShare(shareId) {
  const ok = await confirmAction({
    title: 'Dismiss this job?',
    message: 'It will be hidden from your inbox. The sender keeps their copy.',
    confirmLabel: 'Dismiss'
  });
  if (!ok) return;
  try {
    await api('/shares/' + encodeURIComponent(shareId), { method: 'DELETE' });
    state.social.inbox = (state.social.inbox || []).filter((entry) => entry.id !== shareId);
    state.social.unread = (state.social.inbox || []).filter((entry) => !entry.readAt).length;
    renderFriendsBadge();
    renderFriends();
    toast('Job dismissed');
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else toast(err.message || 'Could not dismiss that job', 'error');
  }
}

async function deleteSentShare(shareId) {
  const ok = await confirmAction({
    title: 'Remove this shared job?',
    message: 'This removes the share and cannot be undone.',
    confirmLabel: 'Remove'
  });
  if (!ok) return;
  try {
    await api('/shares/' + encodeURIComponent(shareId), { method: 'DELETE' });
    state.social.sent = (state.social.sent || []).filter((entry) => entry.id !== shareId);
    renderFriends();
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else toast(err.message || 'Could not remove that share', 'error');
  }
}

function findShare(shareId) {
  const all = [...(state.social.inbox || []), ...(state.social.sent || [])];
  return all.find((entry) => entry.id === shareId) || null;
}

function recomputeUnreadMessages() {
  const all = [...(state.social.inbox || []), ...(state.social.sent || [])];
  state.social.unreadMessages = all.reduce(
    (total, item) => total + socialList(item.messages).filter((message) => !message.mine && !message.readAt).length,
    0
  );
  renderFriendsBadge();
}

function replyInputFor(shareId) {
  const inputs = document.querySelectorAll('[data-share-reply-input]');
  for (const input of inputs) {
    if (input.dataset.shareReplyInput === shareId) return input;
  }
  return null;
}

/**
 * Opening a thread counts as reading it. The local patch keeps the badge
 * honest without waiting for the next snapshot; the POST makes it durable.
 */
function patchThreadRead(shareId) {
  const share = findShare(shareId);
  if (!share) return;
  const now = new Date().toISOString();
  socialList(share.messages).forEach((message) => {
    if (!message.mine && !message.readAt) message.readAt = now;
  });
  share.messageUnread = 0;
  recomputeUnreadMessages();
}

async function markThreadRead(shareId) {
  try {
    await api('/shares/' + encodeURIComponent(shareId) + '/messages/read', { method: 'POST' });
  } catch {
    // Read state is cosmetic; the next snapshot will tell the truth.
  }
}

async function toggleShareThread(shareId) {
  const opening = !openShareThreads.has(shareId);
  if (opening) openShareThreads.add(shareId);
  else openShareThreads.delete(shareId);

  if (opening) patchThreadRead(shareId);
  renderFriends();
  if (!opening) return;

  const input = replyInputFor(shareId);
  if (input) input.focus();
  await markThreadRead(shareId);
}

async function submitShareReply(form) {
  const shareId = form.dataset.shareReply;
  const input = form.querySelector('[data-share-reply-input]');
  const text = input ? input.value.trim() : '';
  if (!text) {
    if (input) input.focus();
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const data = await api('/shares/' + encodeURIComponent(shareId) + '/messages', {
      method: 'POST',
      body: { text }
    });
    const message = data && data.message;
    shareReplyDrafts.delete(shareId);

    const share = findShare(shareId);
    if (share && message) {
      // Posting marks the other person's side read, and a reply revives a
      // lead the recipient had dismissed.
      const now = message.createdAt || new Date().toISOString();
      socialList(share.messages).forEach((entry) => {
        if (!entry.mine && !entry.readAt) entry.readAt = now;
      });
      share.messages = [...socialList(share.messages), message];
      share.messageUnread = 0;
      if (share.status === 'dismissed') share.status = 'inbox';
    }

    recomputeUnreadMessages();
    renderFriends();
    const nextInput = replyInputFor(shareId);
    if (nextInput) nextInput.focus();
  } catch (err) {
    if (isAuthRequired(err)) handleAuthRequired();
    else toast(err.message || 'Could not send that reply', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function openShareModal(prefill = {}) {
  if (!cloudConfig.configured) {
    toast('Cloud sync is not configured in this build', 'error');
    return;
  }
  if (!state.cloud.user) {
    toast('Sign in to send jobs to kniggurs', 'error');
    showPage('settings');
    return;
  }

  if (!(state.social.friends || []).length && state.social.status !== 'ready') {
    await loadSocial({ silent: true });
  }

  const friends = state.social.friends || [];
  if (!friends.length) {
    toast('Add a kniggur first, then send them a job', 'error');
    togetherTab = 'kniggurs';
    showPage('together');
    return;
  }

  shareJobDraft = { jobDescription: String(prefill.jobDescription || '') };

  const form = $('#shareJobForm');
  if (form) form.reset();

  const select = $('#shareFriend');
  if (select) {
    select.innerHTML = friends.map((friend) => {
      const detail = friend.headline ? ' — ' + friend.headline : '';
      return '<option value="' + escapeHtml(friend.id) + '">' +
        escapeHtml(socialPersonName(friend) + detail) +
        '</option>';
    }).join('');
    if (prefill.toUserId && friends.some((friend) => friend.id === prefill.toUserId)) {
      select.value = prefill.toUserId;
    }
  }

  const company = $('#shareCompany');
  const position = $('#sharePosition');
  const url = $('#shareUrl');
  const note = $('#shareNote');
  if (company) company.value = prefill.company || '';
  if (position) position.value = prefill.position || '';
  if (url) url.value = prefill.url || '';
  if (note) note.value = prefill.note || '';

  const error = $('#shareJobError');
  if (error) {
    error.textContent = '';
    error.hidden = true;
  }

  openModal($('#shareJobModal'));
  if (company) setTimeout(() => company.focus(), 60);
}

async function handleShareJobSubmit(event) {
  event.preventDefault();

  const error = $('#shareJobError');
  const submit = $('#shareJobSubmit');
  const select = $('#shareFriend');
  const toUserId = select ? select.value : '';
  const company = (($('#shareCompany') || {}).value || '').trim();
  const position = (($('#sharePosition') || {}).value || '').trim();
  const url = (($('#shareUrl') || {}).value || '').trim();
  const note = (($('#shareNote') || {}).value || '').trim();

  const fail = (message) => {
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  };

  if (!toUserId) return fail('Choose a kniggur first.');
  if (!company && !position && !url) return fail('Add a company, a role, or a job link.');

  if (submit) submit.disabled = true;
  if (error) error.hidden = true;

  try {
    const data = await api('/shares', {
      method: 'POST',
      body: {
        toUserId,
        company,
        position,
        url,
        note,
        jobDescription: shareJobDraft.jobDescription
      }
    });
    closeModal($('#shareJobModal'));
    toast('Job sent to ' + ((data && data.share && data.share.to && data.share.to.name) || 'your kniggur'));
    await loadSocial({ silent: true });
  } catch (err) {
    if (isAuthRequired(err)) {
      closeModal($('#shareJobModal'));
      handleAuthRequired();
    } else {
      fail(err.message || 'Could not send that job');
    }
  } finally {
    if (submit) submit.disabled = false;
  }
}

function shareCurrentApplication() {
  const application = currentApplication();
  if (!application) return;
  openShareModal({
    company: application.company,
    position: application.position,
    url: application.url,
    jobDescription: application.jobDescription
  });
}

// ---------------------------------------------------------------- Together

const TOGETHER_TABS = ['kniggurs', 'todos', 'projects', 'learning', 'shelf', 'crm'];
const SHELF_CATEGORY_SUGGESTIONS = [
  'Fiction', 'Business', 'Design', 'Science', 'Biography',
  'Self-development', 'History', 'Poetry'
];
const TOGETHER_PLACEHOLDER = {
  learning: 'Learning tracks arrive in phase 3: a language or skill, with a progress bar each.'
};

let togetherScope = 'me';
let togetherTab = 'kniggurs';
let togetherListId = 'all';
let shelfFilter = 'all';
let shelfCategory = 'all';
let editingBookLinkId = null;
let crmStageFilter = 'all';
let crmSearch = '';
let contactModalId = null;
let calendarScope = localStorage.getItem(STORE.calScope) || 'all';
const UPCOMING_WINDOWS = { '1d': 1, '7d': 7, '30d': 30 };
let upcomingWindow = localStorage.getItem(STORE.upcomingWindow);
if (!UPCOMING_WINDOWS[upcomingWindow]) upcomingWindow = '7d';
let spaceLoading = false;
let spaceGeneration = 0;

function resetSpace() {
  state.space = {
    status: 'off',
    error: '',
    loaded: false,
    circles: [],
    members: [],
    taskLists: [],
    projects: [],
    tasks: [],
    books: [],
    shelfCategories: [],
    contacts: [],
    contactNotes: [],
    people: {}
  };
  spaceGeneration += 1;
  spaceLoading = false;
  togetherScope = 'me';
  togetherTab = 'kniggurs';
  togetherListId = 'all';
  shelfFilter = 'all';
  shelfCategory = 'all';
  editingBookLinkId = null;
  renderTogetherBadge();
  refreshDashboardSpace();
}

function spaceCacheKey() {
  const id = (state.cloud.user && state.cloud.user.id) || 'anon';
  return STORE.space + '_' + id;
}

function readSpaceCache() {
  const cached = loadJSON(spaceCacheKey(), null);
  if (!cached || !Array.isArray(cached.tasks)) return;
  applySpace(cached);
  state.space.status = 'ready';
  state.space.loaded = true;
  renderTogetherBadge();
  refreshDashboardSpace();
}

function cacheSpace() {
  try {
    localStorage.setItem(spaceCacheKey(), JSON.stringify({
      circles: state.space.circles,
      members: state.space.members,
      taskLists: state.space.taskLists,
      projects: state.space.projects,
      tasks: state.space.tasks,
      books: state.space.books,
      shelfCategories: state.space.shelfCategories,
      contacts: state.space.contacts,
      contactNotes: state.space.contactNotes,
      people: state.space.people,
      cachedAt: new Date().toISOString()
    }));
  } catch (err) {
    // The cache is a convenience; a full quota must not break the page.
  }
}

function applySpace(data) {
  state.space.circles = Array.isArray(data && data.circles) ? data.circles : [];
  state.space.members = Array.isArray(data && data.members) ? data.members : [];
  state.space.taskLists = Array.isArray(data && data.taskLists) ? data.taskLists : [];
  state.space.projects = Array.isArray(data && data.projects) ? data.projects : [];
  state.space.tasks = Array.isArray(data && data.tasks) ? data.tasks : [];
  state.space.books = Array.isArray(data && data.books) ? data.books : [];
  state.space.shelfCategories = Array.isArray(data && data.shelfCategories) ? data.shelfCategories : [];
  state.space.contacts = Array.isArray(data && data.contacts) ? data.contacts : [];
  state.space.contactNotes = Array.isArray(data && data.contactNotes) ? data.contactNotes : [];
  state.space.people = data && data.people && typeof data.people === 'object' ? data.people : {};
  state.space.loaded = true;

  if (togetherScope !== 'me' && !state.space.circles.some((circle) => circle.id === togetherScope)) {
    togetherScope = 'me';
    togetherListId = 'all';
  }
}

async function loadSpace(options = {}) {
  if (!cloudReady() || spaceLoading) return;
  spaceLoading = true;
  const generation = spaceGeneration;

  if (!options.silent && !state.space.loaded) {
    state.space.status = 'loading';
    if (currentPage === 'together') renderTogether();
    if (currentPage === 'dashboard') renderTogetherDash();
  }

  try {
    const data = await api('/space');
    if (generation !== spaceGeneration) return;
    applySpace(data);
    state.space.status = 'ready';
    state.space.error = '';
    cacheSpace();
    renderTogetherBadge();
    if (currentPage === 'together' && !(options.silent && togetherEditing())) renderTogether();
    if (currentPage === 'calendar') renderCalendar();
    if (currentPage === 'dashboard') {
      refreshDashboardSpace();
      refreshDashboardInsights();
    }
  } catch (err) {
    if (generation !== spaceGeneration) return;
    if (isAuthRequired(err)) {
      handleAuthRequired();
      return;
    }
    state.space.status = 'error';
    state.space.error = err.message || 'Could not load Together';
    if (currentPage === 'together') renderTogether();
  } finally {
    if (generation === spaceGeneration) spaceLoading = false;
  }
}

async function spaceRequest(path, options = {}) {
  try {
    return await api(path, options);
  } catch (err) {
    if (isAuthRequired(err)) {
      handleAuthRequired();
      return null;
    }
    toast(
      err.status === 409
        ? 'Someone changed that first — showing their version.'
        : err.message || 'Could not save that',
      'error'
    );
    await loadSpace({ silent: true });
    return null;
  }
}

function findSpaceTask(id) {
  return state.space.tasks.find((task) => task.id === id) || null;
}

function findSpaceList(id) {
  return state.space.taskLists.find((list) => list.id === id) || null;
}

function circleById(id) {
  return state.space.circles.find((circle) => circle.id === id) || null;
}

function circleName(id) {
  const circle = circleById(id);
  return circle ? circle.name : 'Circle';
}

function circleMembers(id) {
  return state.space.members.filter((member) => member.circleId === id);
}

function personName(id) {
  if (!id) return 'Anyone';
  if (state.cloud.user && id === state.cloud.user.id) {
    const me = state.space.people[id];
    return (me && (me.name || me.email)) || firstName(state.profile.name) || 'You';
  }
  const person = state.space.people[id];
  return (person && (person.name || person.email)) || 'A kniggur';
}

function inSpaceScope(row) {
  return togetherScope === 'me' ? !row.circleId : row.circleId === togetherScope;
}

function scopeTasks() {
  return state.space.tasks.filter(inSpaceScope);
}

function scopeLists() {
  return state.space.taskLists.filter(inSpaceScope);
}

function scopeProjects() {
  return (state.space.projects || []).filter(inSpaceScope);
}

function scopeBooks() {
  return (state.space.books || []).filter(inSpaceScope);
}

function scopeCategories() {
  return (state.space.shelfCategories || []).filter(inSpaceScope);
}

function scopeContacts() {
  return (state.space.contacts || []).filter(inSpaceScope);
}

function findContact(id) {
  return (state.space.contacts || []).find((contact) => contact.id === id) || null;
}

function contactNotes(contactId) {
  return (state.space.contactNotes || [])
    .filter((note) => note.contactId === contactId)
    .sort((a, b) => {
      const left = String(a.happenedOn || '');
      const right = String(b.happenedOn || '');
      if (left !== right) return right.localeCompare(left);
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
}

function contactScopeLabel(contact) {
  return contact.circleId ? circleName(contact.circleId) : 'Just me';
}

function contactInitials(name) {
  return initials(name || '?');
}

function canEditContact(contact) {
  if (!contact || !cloudReady()) return false;
  const me = state.cloud.user && state.cloud.user.id;
  if (contact.ownerId === me) return true;
  return Boolean(contact.circleId && circleById(contact.circleId));
}

function canMoveContact(contact) {
  return Boolean(contact && cloudReady() && contact.ownerId === (state.cloud.user && state.cloud.user.id));
}

function canDeleteContactNote(contact, note) {
  const me = state.cloud.user && state.cloud.user.id;
  if (!contact || !note || !me) return false;
  if (note.authorId === me) return true;
  if (contact.ownerId === me) return true;
  const circle = contact.circleId ? circleById(contact.circleId) : null;
  return Boolean(circle && (circle.role === 'owner' || circle.ownerId === me));
}

function contactStageOptions(selected) {
  return [
    ['lead', 'Lead'],
    ['talking', 'Talking'],
    ['active', 'Active'],
    ['dormant', 'Dormant']
  ].map(([value, label]) => (
    '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' + label + '</option>'
  )).join('');
}

function contactTagsText(contact) {
  return (contact.tags || []).join(', ');
}

function scopeCircleId() {
  return togetherScope === 'me' ? null : togetherScope;
}

function canManageShelfCategories() {
  if (!cloudReady()) return false;
  if (togetherScope === 'me') return true;
  const circle = circleById(togetherScope);
  const me = state.cloud.user && state.cloud.user.id;
  return Boolean(circle && (circle.role === 'owner' || circle.ownerId === me));
}

function upsertSpaceRow(collection, row) {
  const list = state.space[collection] || [];
  const index = list.findIndex((entry) => entry.id === row.id);
  if (index >= 0) list[index] = row;
  else list.push(row);
}

function dropSpaceRow(collection, id) {
  state.space[collection] = (state.space[collection] || []).filter((entry) => entry.id !== id);
}

function refreshSpaceViews() {
  cacheSpace();
  renderTogetherBadge();
  if (currentPage === 'together') renderTogether();
  if (currentPage === 'calendar') renderCalendar();
  if (currentPage === 'dashboard') {
    refreshDashboardSpace();
    refreshDashboardInsights();
  }
  const projectModal = $('#projectModal');
  if (projectModal && !projectModal.hidden) renderProjectModal();
}

// A silent poll must not wipe an unsaved task title, note, due date, or
// assignee. The data still updates; the next render carries it.
function togetherEditing() {
  const active = document.activeElement;
  const page = $('#togetherPage');
  if (!active || !page || !page.contains(active)) return false;
  return Boolean(active.closest('input, textarea, select'));
}

function renderTogetherBadge() {
  const badge = $('#togetherBadge');
  if (!badge) return;
  const tomorrow = startOfDay(new Date()).getTime() + DAY_MS;
  const taskCount = cloudReady()
    ? state.space.tasks.filter((task) => {
        if (task.status === 'done' || !task.dueAt) return false;
        const at = new Date(task.dueAt).getTime();
        return Number.isFinite(at) && at < tomorrow;
      }).length
    : 0;
  const followUpCount = cloudReady()
    ? togetherDashFollowUps().length
    : 0;
  const socialCount = cloudReady() ? socialUnreadTotal() : 0;
  const count = taskCount + followUpCount + socialCount;
  badge.textContent = String(count);
  badge.hidden = !cloudReady() || count === 0;
}

function setTogetherScope(scope) {
  togetherScope = scope === 'me' || circleById(scope) ? scope : 'me';
  togetherListId = 'all';
  const tray = $('#circleSettingsTray');
  if (tray) tray.hidden = true;
  editingBookLinkId = null;
  renderTogether();
}

function setScopeMenuOpen(open) {
  const button = $('#togetherScopeBtn');
  const menu = $('#togetherScopeMenu');
  if (!button || !menu) return;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

function setTogetherTab(tab) {
  togetherTab = TOGETHER_TABS.includes(tab) ? tab : 'kniggurs';
  renderTogetherTabs();
}

// Add forms stay collapsed until asked for, so each tab opens on its records.
function toggleAddPanel(button) {
  const panel = document.getElementById(button.dataset.addToggle);
  if (!panel) return;

  const open = panel.hidden;
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  const label = button.querySelector('[data-add-label]');
  if (label) label.textContent = open ? 'Close' : 'Add';

  const grid = button.closest('.together-grid');
  if (grid && grid.querySelector('.add-card')) {
    grid.classList.toggle('adds-closed', !grid.querySelector('.add-card:not([hidden])'));
  }

  if (open) {
    const field = panel.querySelector('input:not([type="hidden"]), textarea, select');
    if (field) setTimeout(() => field.focus(), 40);
  }
}
function renderTogether() {
  const signedOut = $('#togetherSignedOut');
  const signedIn = $('#togetherSignedIn');
  const actions = $('#togetherActions');
  const summary = $('#togetherSummary');
  const ready = cloudReady();

  if (signedOut) signedOut.hidden = ready;
  if (signedIn) signedIn.hidden = !ready;
  if (actions) actions.hidden = !ready;

  if (!ready) {
    if (summary) summary.textContent = 'Sign in to plan with your kniggurs';
    renderTogetherBadge();
    return;
  }

  renderTogetherScope();
  renderTogetherTabs();
  renderCircleCard();
  renderTodos();
  renderProjects();
  renderShelf();
  renderCrm();
  // The kniggurs tab lives in this page. A quiet poll must not repaint a
  // reply the person is in the middle of typing.
  if (!socialThreadFocused()) renderFriends();

  const circle = togetherScope === 'me' ? null : circleById(togetherScope);
  const open = scopeTasks().filter((task) => task.status !== 'done').length;
  if (summary) {
    if (state.space.status === 'loading' && !state.space.loaded) {
      summary.textContent = 'Loading your space…';
    } else if (state.space.status === 'error') {
      summary.textContent = state.space.error;
    } else if (!state.space.loaded) {
      summary.textContent = 'Loading your space…';
    } else if (circle) {
      const members = circleMembers(circle.id).length;
      summary.textContent = circle.name + ' · ' + members + (members === 1 ? ' member' : ' members') +
        ' · ' + open + (open === 1 ? ' open task' : ' open tasks');
    } else {
      const circles = state.space.circles.length;
      const projects = scopeProjects().length;
      const contacts = scopeContacts().length;
      const projectText = projects
        ? (projects === 1 ? ' · 1 project' : ' · ' + projects + ' projects')
        : '';
      const contactText = contacts
        ? (contacts === 1 ? ' · 1 contact' : ' · ' + contacts + ' contacts')
        : '';
      summary.textContent = 'Just me · ' + open + (open === 1 ? ' open task' : ' open tasks') + projectText +
        (circles ? ' · ' + circles + (circles === 1 ? ' circle' : ' circles') : '') + contactText;
    }
  }

  renderTogetherBadge();
}

function renderTogetherScope() {
  const menu = $('#togetherScopeMenu');
  const label = $('#togetherScopeLabel');
  if (!menu || !label) return;

  if (togetherScope !== 'me' && !circleById(togetherScope)) togetherScope = 'me';

  const options = [{ value: 'me', name: 'Just me' }].concat(
    state.space.circles.map((circle) => ({ value: circle.id, name: circle.name }))
  );

  if (menu.hidden) {
    menu.innerHTML = options.map((option) => (
      '<button class="scope-option" type="button" role="option" data-scope-value="' + escapeHtml(option.value) + '" aria-selected="' + String(option.value === togetherScope) + '">' +
        '<span class="scope-option-name">' + escapeHtml(option.name) + '</span>' +
        '<svg class="icon scope-option-check" aria-hidden="true"><use href="#icon-check"/></svg>' +
      '</button>'
    )).join('');
  }

  const current = options.find((option) => option.value === togetherScope) || options[0];
  label.textContent = current.name;
}

function renderTogetherTabs() {
  $$('[data-together-tab]').forEach((tab) => {
    const active = tab.dataset.togetherTab === togetherTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const todos = $('#togetherTodos');
  const kniggurs = $('#togetherKniggurs');
  const projects = $('#togetherProjects');
  const shelf = $('#togetherShelf');
  const crm = $('#togetherCrm');
  const placeholder = $('#togetherPlaceholder');
  if (todos) todos.hidden = togetherTab !== 'todos';
  if (kniggurs) kniggurs.hidden = togetherTab !== 'kniggurs';
  if (projects) projects.hidden = togetherTab !== 'projects';
  if (shelf) shelf.hidden = togetherTab !== 'shelf';
  if (crm) crm.hidden = togetherTab !== 'crm';
  if (placeholder) {
    const isPlaceholder = togetherTab !== 'todos' && togetherTab !== 'kniggurs' &&
      togetherTab !== 'projects' && togetherTab !== 'shelf' && togetherTab !== 'crm';
    placeholder.hidden = !isPlaceholder;
    const copy = TOGETHER_PLACEHOLDER[togetherTab];
    if (copy && isPlaceholder) {
      placeholder.innerHTML = '<p><strong>' + escapeHtml(togetherTab[0].toUpperCase() + togetherTab.slice(1)) +
        '</strong> is not live yet.</p><p>' + escapeHtml(copy) + '</p>';
    }
  }
}

function renderCircleCard() {
  const tray = $('#circleSettingsTray');
  const card = $('#circleCard');
  const gear = $('#circleSettingsBtn');
  const circle = togetherScope === 'me' ? null : circleById(togetherScope);

  if (gear) {
    gear.hidden = !circle;
    gear.disabled = !circle;
    gear.setAttribute('aria-disabled', String(!circle));
  }

  if (!circle) {
    if (tray) tray.hidden = true;
    if (card) card.hidden = true;
    return;
  }

  if (card) card.hidden = false;

  const me = state.cloud.user && state.cloud.user.id;
  const members = circleMembers(circle.id);
  const isOwner = circle.role === 'owner' || circle.ownerId === me;

  const title = $('#circleTitle');
  if (title) title.textContent = circle.name;
  const meta = $('#circleMeta');
  if (meta) {
    meta.textContent = isOwner
      ? (members.length === 1 ? 'You own this circle · just you so far' : 'You own this circle')
      : 'Owned by ' + personName(circle.ownerId);
  }

  const host = $('#circleMembers');
  if (host) {
    host.innerHTML = members.map((member) => {
      const self = member.userId === me;
      const canRemove = self ? !isOwner : isOwner;
      const detail = member.role === 'owner' ? 'Owner' : (self ? 'You' : 'Member');
      return '<div class="social-person">' +
        '<span class="social-avatar' + (onlineById(member.userId) ? ' is-online' : '') + '" aria-hidden="true">' +
          escapeHtml(initials(personName(member.userId))) + '</span>' +
        '<div class="social-person-main">' +
          '<strong>' + personNameHtml(member.userId) + '</strong>' +
          '<span>' + escapeHtml(detail) + '</span>' +
        '</div>' +
        (canRemove
          ? '<div class="social-person-actions"><button class="btn ghost small" type="button" data-circle-remove="' +
              escapeHtml(member.userId) + '">' + (self ? 'Leave' : 'Remove') + '</button></div>'
          : '') +
      '</div>';
    }).join('');
  }

  const addWrap = $('#circleAddWrap');
  if (addWrap) {
    if (!isOwner) {
      addWrap.innerHTML = '<p class="field-help">Only the owner can add kniggurs to this circle.</p>';
    } else {
      const memberIds = new Set(members.map((member) => member.userId));
      const candidates = (state.social.friends || []).filter((friend) => !memberIds.has(friend.id));
      addWrap.innerHTML = candidates.length
        ? '<form id="circleAddForm" class="friend-add-row" autocomplete="off">' +
            '<select id="circleAddSelect" aria-label="Kniggur to add">' +
              candidates.map((friend) => (
                '<option value="' + escapeHtml(friend.id) + '">' +
                  escapeHtml(friend.name || friend.email || 'Kniggur') + '</option>'
              )).join('') +
            '</select>' +
            '<button class="btn primary small" type="submit">Add</button>' +
          '</form>' +
          '<p class="field-help">Only your kniggurs can join a circle.</p>'
        : '<p class="field-help">' +
            (state.social.status === 'ready'
              ? 'Add a kniggur on the Kniggurs page first, then come back.'
              : 'Loading your kniggurs…') +
          '</p>';
    }
  }

  const exit = $('#circleExitBtn');
  if (exit) {
    exit.hidden = false;
    exit.textContent = isOwner ? 'Delete circle' : 'Leave circle';
    exit.dataset.circleExit = circle.id;
  }
}

function showCircleSettingsPanel() {
  const tray = $('#circleSettingsTray');
  if (tray) tray.hidden = false;
}

function hideCircleSettingsPanel() {
  const tray = $('#circleSettingsTray');
  if (tray) tray.hidden = true;
}

function renderTodos() {
  const listHost = $('#spaceLists');
  const taskHost = $('#spaceTasks');
  if (!listHost || !taskHost) return;

  const lists = scopeLists();
  const projects = scopeProjects();
  const tasks = scopeTasks();
  const open = tasks.filter((task) => task.status !== 'done').length;

  const listCount = $('#spaceListCount');
  if (listCount) listCount.textContent = lists.length + (lists.length === 1 ? ' list' : ' lists');
  const taskCount = $('#spaceTaskCount');
  if (taskCount) {
    taskCount.textContent = tasks.length
      ? open + ' open · ' + tasks.length + ' total'
      : 'Nothing yet';
  }

  const listRow = (id, name, count, extra = '') => (
    '<div class="space-list-row">' +
      '<button class="space-list' + (togetherListId === id ? ' active' : '') + '" type="button" data-space-list="' + escapeHtml(id) + '">' +
        '<span class="space-list-name">' + escapeHtml(name) + '</span>' +
        '<span class="space-list-count">' + count + '</span>' +
      '</button>' +
      extra +
    '</div>'
  );

  listHost.innerHTML = [
    listRow('all', 'All tasks', tasks.length),
    ...lists.map((list) => listRow(
      list.id,
      list.name,
      tasks.filter((task) => task.listId === list.id).length,
      '<button class="space-list-del" type="button" data-list-delete="' + escapeHtml(list.id) +
        '" title="Delete list" aria-label="Delete ' + escapeHtml(list.name) + '">×</button>'
    )),
    listRow('none', 'No list', tasks.filter((task) => !task.listId).length)
  ].join('');

  const listSelect = $('#taskListSelect');
  if (listSelect) {
    const selected = listSelect.value;
    listSelect.innerHTML = '<option value="">No list</option>' +
      lists.map((list) => '<option value="' + escapeHtml(list.id) + '">' + escapeHtml(list.name) + '</option>').join('');
    if (selected && lists.some((list) => list.id === selected)) listSelect.value = selected;
  }

  const projectSelect = $('#taskProjectSelect');
  if (projectSelect) {
    const selected = projectSelect.value;
    projectSelect.innerHTML = '<option value="">No project</option>' +
      projects.map((project) => '<option value="' + escapeHtml(project.id) + '">' + escapeHtml(project.name) + '</option>').join('');
    if (selected && projects.some((project) => project.id === selected)) projectSelect.value = selected;
  }

  const assignee = $('#taskAssignee');
  if (assignee) {
    if (togetherScope === 'me') {
      assignee.hidden = true;
      assignee.innerHTML = '';
    } else {
      assignee.hidden = false;
      const members = circleMembers(togetherScope);
      assignee.innerHTML = '<option value="">Anyone</option>' +
        members.map((member) => (
          '<option value="' + escapeHtml(member.userId) + '">' +
            escapeHtml(personName(member.userId)) + (state.cloud.user && member.userId === state.cloud.user.id ? ' (you)' : '') +
          '</option>'
        )).join('');
    }
  }

  const visible = tasks
    .filter((task) => {
      if (togetherListId === 'all') return true;
      if (togetherListId === 'none') return !task.listId;
      return task.listId === togetherListId;
    })
    .slice()
    .sort((a, b) => {
      const aDone = a.status === 'done';
      const bDone = b.status === 'done';
      if (aDone !== bDone) return aDone ? 1 : -1;
      const aAt = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const bAt = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      if (aAt !== bAt) return aAt - bAt;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  if (!visible.length) {
    taskHost.innerHTML = '<div class="social-empty">' +
      (tasks.length
        ? 'Nothing in this list yet. Add a task above, or pick another list.'
        : 'No tasks in this scope yet. Add one above; give it a due date and it shows up on your calendar.') +
      '</div>';
    return;
  }

  const members = togetherScope === 'me' ? [] : circleMembers(togetherScope);

  taskHost.innerHTML = visible.map((task) => {
    const done = task.status === 'done';
    const list = task.listId ? findSpaceList(task.listId) : null;
    const project = task.projectId ? findProject(task.projectId) : null;
    const projectOptions = projects.length
      ? '<select class="task-project" data-task-project="' + escapeHtml(task.id) + '" aria-label="Project">' +
          '<option value="">No project</option>' +
          projects.map((entry) => (
            '<option value="' + escapeHtml(entry.id) + '"' + (task.projectId === entry.id ? ' selected' : '') + '>' +
              escapeHtml(entry.name) +
            '</option>'
          )).join('') +
        '</select>'
      : (project ? '<span class="task-list-chip">' + escapeHtml(project.name) + '</span>' : '');
    const assigneeOptions = members.length
      ? '<select class="task-assignee" data-task-assignee="' + escapeHtml(task.id) + '" aria-label="Assignee">' +
          '<option value="">Anyone</option>' +
          members.map((member) => (
            '<option value="' + escapeHtml(member.userId) + '"' + (task.assigneeId === member.userId ? ' selected' : '') + '>' +
              escapeHtml(personName(member.userId)) +
            '</option>'
          )).join('') +
        '</select>'
      : '';

    return '<article class="space-task' + (done ? ' is-done' : '') + '" id="spaceTask-' + escapeHtml(task.id) + '">' +
      '<button class="task-check" type="button" data-task-toggle="' + escapeHtml(task.id) + '" aria-pressed="' + done + '" ' +
        'aria-label="' + (done ? 'Reopen task' : 'Mark task done') + '">' + (done ? '✓' : '') + '</button>' +
      '<div class="space-task-main">' +
        '<input class="task-title-input" type="text" maxlength="240" data-task-title="' + escapeHtml(task.id) + '" ' +
          'value="' + escapeHtml(task.title) + '" aria-label="Task title">' +
        (task.notes ? '<p class="task-notes">' + escapeHtml(task.notes) + '</p>' : '') +
        '<div class="task-meta">' +
          '<span class="task-list-chip">' + escapeHtml(list ? list.name : 'No list') + '</span>' +
          projectOptions +
          '<label class="task-due"><span>Due</span>' +
            '<input type="datetime-local" data-task-due="' + escapeHtml(task.id) + '" ' +
              'value="' + (task.dueAt ? localInputValue(task.dueAt) : '') + '" aria-label="Due date">' +
          '</label>' +
          assigneeOptions +
          (task.assigneeId && !members.length
            ? '<span class="task-assignee-chip">' + personNameHtml(task.assigneeId) + '</span>'
            : '') +
          (task.circleId ? '<span class="task-circle-chip">' + escapeHtml(circleName(task.circleId)) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<button class="task-del" type="button" data-task-delete="' + escapeHtml(task.id) + '" ' +
        'title="Delete task" aria-label="Delete task">×</button>' +
    '</article>';
  }).join('');
}

// --- Projects: an outcome, a target date, milestones, and progress.

const PROJECT_STATUS_LABEL = {
  planning: 'Planning',
  active: 'Active',
  paused: 'Paused',
  done: 'Done'
};

let projectModalId = null;

function findProject(id) {
  return (state.space.projects || []).find((project) => project.id === id) || null;
}

function projectTasks(projectId) {
  return state.space.tasks.filter((task) => task.projectId === projectId);
}

function projectMilestones(projectId) {
  return projectTasks(projectId).filter((task) => task.isMilestone);
}

function projectProgress(project) {
  const tasks = projectTasks(project.id);
  const milestones = tasks.filter((task) => task.isMilestone);
  const basis = milestones.length ? milestones : tasks;
  const done = basis.filter((task) => task.status === 'done').length;
  return {
    done,
    total: basis.length,
    percent: basis.length ? Math.round((done / basis.length) * 100) : 0,
    milestones: milestones.length > 0
  };
}

function projectStatusOptions(selected) {
  return ['planning', 'active', 'paused', 'done'].map((value) => (
    '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' +
      PROJECT_STATUS_LABEL[value] +
    '</option>'
  )).join('');
}

function projectStatusChip(status) {
  const key = PROJECT_STATUS_LABEL[status] ? status : 'active';
  return '<span class="project-status ' + key + '">' + PROJECT_STATUS_LABEL[key] + '</span>';
}

function projectTargetLabel(project) {
  if (!project.targetOn) return 'No target date';
  const overdue = dayOnly(project.targetOn) < dayKey(new Date()) && project.status !== 'done';
  return '<span class="project-target' + (overdue ? ' is-overdue' : '') + '">Target ' +
    escapeHtml(formatDay(project.targetOn)) + '</span>';
}

function projectMilestoneRow(task) {
  const done = task.status === 'done';
  return '<div class="project-milestone' + (done ? ' is-done' : '') + '">' +
    '<button class="task-check" type="button" data-task-toggle="' + escapeHtml(task.id) + '" ' +
      'aria-pressed="' + done + '" aria-label="' + (done ? 'Reopen milestone' : 'Mark milestone done') + '">' +
      (done ? '✓' : '') +
    '</button>' +
    '<span class="project-milestone-title">' + escapeHtml(task.title) + '</span>' +
    (task.dueAt ? '<span class="project-milestone-due">' + escapeHtml(formatDay(task.dueAt)) + '</span>' : '') +
  '</div>';
}

function renderProjects() {
  const host = $('#projectList');
  if (!host) return;

  const projects = scopeProjects().slice().sort((a, b) => {
    const aDone = a.status === 'done' ? 1 : 0;
    const bDone = b.status === 'done' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const aAt = a.targetOn ? new Date(dayOnly(a.targetOn) + 'T00:00:00').getTime() : Number.POSITIVE_INFINITY;
    const bAt = b.targetOn ? new Date(dayOnly(b.targetOn) + 'T00:00:00').getTime() : Number.POSITIVE_INFINITY;
    if (aAt !== bAt) return aAt - bAt;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const count = $('#projectCount');
  if (count) {
    const active = projects.filter((project) => project.status !== 'done').length;
    count.textContent = projects.length
      ? active + ' active · ' + projects.length + ' total'
      : 'Nothing yet';
  }

  if (!projects.length) {
    host.innerHTML = '<div class="social-empty">' +
      'No projects in this scope yet. Start one with a name and target date; milestones then give it a progress bar.' +
      '</div>';
    return;
  }

  host.innerHTML = projects.map((project) => {
    const progress = projectProgress(project);
    const milestones = projectMilestones(project.id);
    const tasks = projectTasks(project.id);
    const checklist = milestones.length
      ? milestones.slice(0, 6).map(projectMilestoneRow).join('') +
        (milestones.length > 6 ? '<p class="field-help">+' + (milestones.length - 6) + ' more in the project</p>' : '')
      : '<p class="field-help">No milestones yet. Progress follows its tasks.</p>';
    const progressLabel = progress.milestones
      ? progress.done + ' of ' + progress.total + (progress.total === 1 ? ' milestone' : ' milestones')
      : (progress.total
        ? progress.done + ' of ' + progress.total + (progress.total === 1 ? ' task' : ' tasks')
        : 'No tasks yet');

    return '<article class="project-card' + (project.status === 'done' ? ' is-done' : '') + '">' +
      '<div class="project-card-head">' +
        '<button class="project-open" type="button" data-project-open="' + escapeHtml(project.id) + '">' +
          '<strong>' + escapeHtml(project.name) + '</strong>' +
        '</button>' +
        projectStatusChip(project.status) +
        '<button class="task-del" type="button" data-project-delete="' + escapeHtml(project.id) + '" ' +
          'title="Delete project" aria-label="Delete project">×</button>' +
      '</div>' +
      (project.summary ? '<p class="project-summary">' + escapeHtml(project.summary) + '</p>' : '') +
      '<div class="project-meta">' +
        projectTargetLabel(project) +
        '<span>' + tasks.length + (tasks.length === 1 ? ' task' : ' tasks') + '</span>' +
        (project.circleId ? '<span class="task-circle-chip">' + escapeHtml(circleName(project.circleId)) + '</span>' : '') +
      '</div>' +
      '<div class="project-progress" role="img" aria-label="' + progress.percent + '% complete">' +
        '<span style="width: ' + progress.percent + '%"></span>' +
      '</div>' +
      '<div class="project-progress-label">' + escapeHtml(progressLabel) + ' · ' + progress.percent + '%</div>' +
      '<div class="project-milestones">' + checklist + '</div>' +
      '<button class="btn ghost small" type="button" data-project-open="' + escapeHtml(project.id) + '">Open project</button>' +
    '</article>';
  }).join('');
}

function openProjectModal(id) {
  if (!findProject(id)) return;
  projectModalId = id;
  renderProjectModal();
  const modal = $('#projectModal');
  if (modal && modal.hidden) openModal(modal);
}

function renderProjectModal() {
  const modal = $('#projectModal');
  if (!modal || !projectModalId) return;
  const project = findProject(projectModalId);
  if (!project) {
    closeModal(modal);
    projectModalId = null;
    return;
  }

  const title = $('#projectModalTitle');
  if (title) title.textContent = project.name;
  const sub = $('#projectModalSub');
  if (sub) {
    sub.textContent = [
      project.circleId ? circleName(project.circleId) : 'Only you',
      PROJECT_STATUS_LABEL[project.status] || 'Active'
    ].join(' · ');
  }

  const fields = {
    projectFormId: project.id,
    projectFormVersion: project.version,
    projectFormName: project.name,
    projectFormSummary: project.summary || '',
    projectFormTarget: project.targetOn ? dayOnly(project.targetOn) : ''
  };
  Object.entries(fields).forEach(([key, value]) => {
    const input = $('#' + key);
    if (input) input.value = value;
  });
  const status = $('#projectFormStatus');
  if (status) status.innerHTML = projectStatusOptions(project.status);

  const deleteBtn = $('#projectDeleteBtn');
  if (deleteBtn) deleteBtn.dataset.projectDelete = project.id;

  const milestoneCount = $('#projectMilestoneCount');
  const milestones = projectMilestones(project.id);
  if (milestoneCount) {
    milestoneCount.textContent = milestones.length
      ? milestones.filter((task) => task.status === 'done').length + ' of ' + milestones.length + ' done'
      : 'No milestones';
  }
  const milestoneHost = $('#projectMilestones');
  if (milestoneHost) {
    milestoneHost.innerHTML = milestones.length
      ? milestones.map(projectMilestoneRow).join('')
      : '<div class="social-empty">Add a milestone to measure progress.</div>';
  }

  const taskCount = $('#projectTaskCount');
  const tasks = projectTasks(project.id).filter((task) => !task.isMilestone);
  if (taskCount) taskCount.textContent = tasks.length + (tasks.length === 1 ? ' task' : ' tasks');
  const taskHost = $('#projectTasks');
  if (taskHost) {
    taskHost.innerHTML = tasks.length
      ? tasks.map((task) => {
          const done = task.status === 'done';
          return '<div class="project-task' + (done ? ' is-done' : '') + '">' +
            '<button class="task-check" type="button" data-task-toggle="' + escapeHtml(task.id) + '" ' +
              'aria-pressed="' + done + '" aria-label="' + (done ? 'Reopen task' : 'Mark task done') + '">' +
              (done ? '✓' : '') +
            '</button>' +
            '<span class="project-task-title">' + escapeHtml(task.title) + '</span>' +
            (task.assigneeId ? '<span class="task-assignee-chip">' + personNameHtml(task.assigneeId) + '</span>' : '') +
            (task.dueAt ? '<span class="project-milestone-due">' + escapeHtml(formatDay(task.dueAt)) + '</span>' : '') +
          '</div>';
        }).join('')
      : '<div class="social-empty">Tasks you assign to this project in To-dos show up here.</div>';
  }
}

async function addProject(event) {
  event.preventDefault();
  const nameInput = $('#projectName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    toast('Give the project a name', 'error');
    if (nameInput) nameInput.focus();
    return;
  }

  const summaryInput = $('#projectSummary');
  const statusInput = $('#projectStatusNew');
  const targetInput = $('#projectTargetNew');
  const data = await spaceRequest('/projects', {
    method: 'POST',
    body: {
      name,
      summary: summaryInput ? summaryInput.value.trim() : '',
      status: statusInput ? statusInput.value : 'active',
      targetOn: targetInput ? targetInput.value : '',
      circleId: scopeCircleId()
    }
  });
  if (!data || !data.project) return;

  upsertSpaceRow('projects', data.project);
  if (nameInput) nameInput.value = '';
  if (summaryInput) summaryInput.value = '';
  if (targetInput) targetInput.value = '';
  refreshSpaceViews();
  toast('Project added');
  if (nameInput) nameInput.focus();
}

async function saveProject(event) {
  event.preventDefault();
  const project = findProject($('#projectFormId').value);
  if (!project) return;
  const nameInput = $('#projectFormName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    toast('Give the project a name', 'error');
    if (nameInput) nameInput.focus();
    return;
  }

  const data = await spaceRequest('/projects/' + encodeURIComponent(project.id), {
    method: 'PATCH',
    body: {
      name,
      summary: $('#projectFormSummary') ? $('#projectFormSummary').value.trim() : '',
      status: $('#projectFormStatus') ? $('#projectFormStatus').value : project.status,
      targetOn: $('#projectFormTarget') ? $('#projectFormTarget').value : '',
      version: project.version
    }
  });
  if (!data || !data.project) return;

  upsertSpaceRow('projects', data.project);
  refreshSpaceViews();
  toast('Project saved');
}

async function deleteProject(id) {
  const project = findProject(id);
  if (!project) return;
  const ok = await confirmAction({
    title: 'Delete project?',
    message: 'Delete "' + project.name + '"? Its tasks stay in To-dos, without the project.',
    confirmLabel: 'Delete project'
  });
  if (!ok) return;

  const data = await spaceRequest('/projects/' + encodeURIComponent(id), {
    method: 'DELETE',
    body: { version: project.version }
  });
  if (!data) return;

  state.space.tasks.forEach((task) => {
    if (task.projectId === id) {
      task.projectId = null;
      task.isMilestone = false;
    }
  });
  dropSpaceRow('projects', id);
  if (projectModalId === id) {
    projectModalId = null;
    closeModal($('#projectModal'));
  }
  refreshSpaceViews();
  toast('Project deleted');
}

async function addProjectMilestone(event) {
  event.preventDefault();
  const project = findProject(projectModalId);
  if (!project) return;
  const titleInput = $('#projectMilestoneTitle');
  const title = titleInput ? titleInput.value.trim() : '';
  if (!title) {
    toast('Name the milestone', 'error');
    if (titleInput) titleInput.focus();
    return;
  }

  const dueInput = $('#projectMilestoneDue');
  let dueAt = null;
  if (dueInput && dueInput.value) {
    const due = new Date(dueInput.value + 'T09:00');
    if (!Number.isNaN(due.getTime())) dueAt = due.toISOString();
  }

  const data = await spaceRequest('/tasks', {
    method: 'POST',
    body: {
      title,
      projectId: project.id,
      circleId: project.circleId,
      isMilestone: true,
      dueAt,
      dueAllDay: Boolean(dueAt)
    }
  });
  if (!data || !data.task) return;

  upsertSpaceRow('tasks', data.task);
  if (titleInput) titleInput.value = '';
  if (dueInput) dueInput.value = '';
  refreshSpaceViews();
  toast('Milestone added');
  if (titleInput) titleInput.focus();
}

function openProjectFromCalendar(id) {
  const project = findProject(id);
  if (!project) return;
  togetherScope = project.circleId || 'me';
  togetherTab = 'projects';
  showPage('together');
  openProjectModal(id);
}

// --- Shelf: books shared with the selected scope, four shelves, page progress.

function shelfProgress(book) {
  const total = Number(book.pagesTotal) || 0;
  const read = Number(book.pagesRead) || 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((read / total) * 100));
}

function renderShelf() {
  const host = $('#shelfGrid');
  if (!host) return;

  renderShelfCategories();

  const books = scopeBooks();
  const reading = books.filter((book) => book.shelf === 'reading').length;
  const finished = books.filter((book) => book.shelf === 'finished').length;
  const count = $('#shelfCount');
  if (count) {
    count.textContent = books.length
      ? reading + ' reading · ' + finished + ' finished'
      : 'Nothing yet';
  }

  $$('[data-shelf-filter]').forEach((tab) => {
    const active = tab.dataset.shelfFilter === shelfFilter;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // The filter offers every curated category plus any label already on a book,
  // so an older book never becomes unreachable after a category is retired.
  const categoryNames = Array.from(new Set([
    ...scopeCategories().map((category) => category.name),
    ...books.map((book) => book.category)
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const bookCategory = $('#bookCategory');
  if (bookCategory) {
    const previous = bookCategory.value;
    const options = categoryNames.length ? categoryNames : ['General'];
    bookCategory.innerHTML = options.map((name) => (
      '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>'
    )).join('');
    bookCategory.value = options.includes(previous) ? previous : options[0];
  }

  if (shelfCategory !== 'all' && !categoryNames.includes(shelfCategory)) shelfCategory = 'all';
  const categorySelect = $('#shelfCategory');
  if (categorySelect) {
    categorySelect.innerHTML = '<option value="all">All categories</option>' +
      categoryNames.map((category) => (
        '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>'
      )).join('');
    categorySelect.value = shelfCategory;
  }

  const visible = books
    .filter((book) => shelfFilter === 'all' || book.shelf === shelfFilter)
    .filter((book) => shelfCategory === 'all' || book.category === shelfCategory)
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());

  if (!visible.length) {
    host.innerHTML = '<div class="social-empty">' +
      (books.length
        ? 'No books on this shelf yet. Pick another shelf or category.'
        : 'The shelf is empty. Add a book above and decide whether it is reading, want to read, finished, or paused.') +
      '</div>';
    return;
  }

  host.innerHTML = visible.map((book) => {
    const percent = shelfProgress(book);
    const total = Number(book.pagesTotal) || 0;
    const read = Number(book.pagesRead) || 0;
    const shelfOptions = [
      ['want', 'Want to read'],
      ['reading', 'Reading'],
      ['finished', 'Finished'],
      ['paused', 'Paused']
    ].map(([value, label]) => (
      '<option value="' + value + '"' + (book.shelf === value ? ' selected' : '') + '>' + label + '</option>'
    )).join('');
    const ratingOptions = '<option value="">No rating</option>' +
      [1, 2, 3, 4, 5].map((rating) => (
        '<option value="' + rating + '"' + (book.rating === rating ? ' selected' : '') + '>' +
          '★'.repeat(rating) +
        '</option>'
      )).join('');
    const openLink = book.linkUrl
      ? '<a class="shelf-open" href="' + escapeHtml(book.linkUrl) + '" target="_blank" rel="noopener noreferrer">Open book ↗</a>'
      : '';
    const cardCategories = Array.from(new Set([
      ...categoryNames,
      book.category
    ].filter(Boolean)));
    const categoryOptions = (cardCategories.length ? cardCategories : ['General']).map((name) => (
      '<option value="' + escapeHtml(name) + '"' + (book.category === name ? ' selected' : '') + '>' + escapeHtml(name) + '</option>'
    )).join('');
    const linkForm = editingBookLinkId === book.id
      ? '<form class="shelf-link-edit" data-book-link-form="' + escapeHtml(book.id) + '" autocomplete="off">' +
          '<input type="url" maxlength="1000" data-book-link-input="' + escapeHtml(book.id) + '" value="' + escapeHtml(book.linkUrl || '') + '" placeholder="https://drive.google.com/..." aria-label="Book link">' +
          '<button class="btn primary small" type="submit">Save</button>' +
          '<button class="btn ghost small" type="button" data-book-link-cancel="' + escapeHtml(book.id) + '">Cancel</button>' +
        '</form>'
      : '';

    return '<article class="shelf-book">' +
      '<div class="shelf-cover" aria-hidden="true"><span>' + escapeHtml(initials(book.title)) + '</span></div>' +
      '<div class="shelf-book-main">' +
        '<div class="shelf-book-head">' +
          '<strong>' + escapeHtml(book.title) + '</strong>' +
          '<div class="shelf-book-actions">' + openLink +
            '<button class="shelf-link-btn" type="button" data-book-link-edit="' + escapeHtml(book.id) + '" title="Edit link" aria-label="Edit link">' + (book.linkUrl ? 'Edit link' : 'Add link') + '</button>' +
            '<button class="task-del" type="button" data-book-delete="' + escapeHtml(book.id) + '" title="Remove book" aria-label="Remove book">×</button>' +
          '</div>' +
        '</div>' +
        '<span class="shelf-book-by">' + escapeHtml(book.author || 'No author') + '</span>' +
        '<div class="shelf-progress" role="img" aria-label="' + percent + '% read"><span style="width: ' + percent + '%"></span></div>' +
        '<div class="shelf-meta">' +
          '<label class="shelf-pages">Read ' +
            '<input type="number" min="0" max="' + (total || 20000) + '" step="1" data-book-pages="' + escapeHtml(book.id) + '" value="' + read + '" aria-label="Pages read">' +
            ' / ' + (total || '—') +
          '</label>' +
          '<select data-book-category="' + escapeHtml(book.id) + '" aria-label="Category">' + categoryOptions + '</select>' +
          '<select data-book-shelf="' + escapeHtml(book.id) + '" aria-label="Shelf">' + shelfOptions + '</select>' +
          '<select data-book-rating="' + escapeHtml(book.id) + '" aria-label="Rating">' + ratingOptions + '</select>' +
          (book.circleId ? '<span class="task-circle-chip">' + escapeHtml(circleName(book.circleId)) + '</span>' : '') +
        '</div>' +
        linkForm +
      '</div>' +
    '</article>';
  }).join('');
}

function renderShelfCategories() {
  const host = $('#shelfCategories');
  if (!host) return;

  const categories = scopeCategories();
  const canManage = canManageShelfCategories();
  const existing = new Set(categories.map((category) => category.name.toLowerCase()));
  const suggestions = SHELF_CATEGORY_SUGGESTIONS.filter((name) => !existing.has(name.toLowerCase()));

  if (!canManage && !categories.length) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML =
    '<div class="shelf-categories-head">' +
      '<span class="label-mono">Categories</span>' +
      (canManage ? '<span class="field-help">Only you can change these</span>' : '') +
    '</div>' +
    '<div class="shelf-category-chips">' +
      (categories.length
        ? categories.map((category) =>
            '<span class="shelf-category-chip">' + escapeHtml(category.name) +
              (canManage
                ? '<button type="button" data-shelf-category-delete="' + escapeHtml(category.id) + '" title="Remove category" aria-label="Remove ' + escapeHtml(category.name) + '">×</button>'
                : '') +
            '</span>'
          ).join('')
        : '<span class="field-help">No categories yet. Add one below or pick a suggestion.</span>') +
    '</div>' +
    (canManage
      ? (suggestions.length
          ? '<div class="shelf-category-chips">' +
              suggestions.map((name) =>
                '<button class="shelf-category-chip shelf-category-suggest" type="button" data-shelf-category-suggest="' + escapeHtml(name) + '">+ ' + escapeHtml(name) + '</button>'
              ).join('') +
            '</div>'
          : '') +
        '<form id="newShelfCategoryForm" class="friend-add-row" autocomplete="off">' +
          '<input id="shelfCategoryName" maxlength="40" placeholder="New category" aria-label="New category">' +
          '<button class="btn ghost small" type="submit">' +
            '<svg class="icon" aria-hidden="true"><use href="#icon-plus"/></svg>Add' +
          '</button>' +
        '</form>'
      : '');
}

async function createShelfCategory(name) {
  const data = await spaceRequest('/shelf-categories', {
    method: 'POST',
    body: { name, circleId: scopeCircleId() }
  });
  if (!data || !data.shelfCategory) return false;
  upsertSpaceRow('shelfCategories', data.shelfCategory);
  refreshSpaceViews();
  return true;
}

async function addShelfCategory(event) {
  event.preventDefault();
  const input = $('#shelfCategoryName');
  const name = input ? input.value.trim() : '';
  if (!name) {
    toast('Name the category', 'error');
    if (input) input.focus();
    return;
  }
  if (await createShelfCategory(name)) {
    if (input) input.value = '';
    toast('Category added');
  }
}

async function suggestShelfCategory(name) {
  if (await createShelfCategory(name)) toast(name + ' added');
}

async function deleteShelfCategory(id) {
  const category = (state.space.shelfCategories || []).find((entry) => entry.id === id);
  if (!category) return;
  const ok = await confirmAction({
    title: 'Remove category?',
    message: 'Remove the category "' + category.name + '"? Existing books keep the label.',
    confirmLabel: 'Remove'
  });
  if (!ok) return;

  const data = await spaceRequest('/shelf-categories/' + encodeURIComponent(id), {
    method: 'DELETE',
    body: { version: category.version }
  });
  if (!data) return;

  dropSpaceRow('shelfCategories', id);
  refreshSpaceViews();
  toast('Category removed');
}

// ---------------------------------------------------------------- Together CRM

const CONTACT_STAGE_LABEL = {
  lead: 'Lead',
  talking: 'Talking',
  active: 'Active',
  dormant: 'Dormant'
};

function parseContactTags(value) {
  return Array.from(new Set(
    String(value || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
  )).slice(0, 8);
}

function contactStageBadge(stage) {
  const key = CONTACT_STAGE_LABEL[stage] ? stage : 'lead';
  return '<span class="contact-stage ' + key + '">' + CONTACT_STAGE_LABEL[key] + '</span>';
}

function contactFollowUpLabel(contact) {
  if (!contact.nextFollowUpOn) return '';
  const today = dayKey(new Date());
  const overdue = dayOnly(contact.nextFollowUpOn) < today;
  return '<span class="contact-follow' + (overdue ? ' is-overdue' : '') + '">' +
    (overdue ? 'Overdue · ' : 'Next · ') + escapeHtml(formatDay(contact.nextFollowUpOn)) +
    '</span>';
}

function renderCrm() {
  renderContactList();

  const note = $('#contactScopeNote');
  if (note) {
    note.textContent = togetherScope === 'me'
      ? 'Only you'
      : 'Shared with ' + circleName(togetherScope);
  }

  const stageFilter = $('#contactStageFilter');
  if (stageFilter) stageFilter.value = crmStageFilter;
  const search = $('#contactSearch');
  if (search) search.value = crmSearch;
}

function renderContactList() {
  const host = $('#contactList');
  if (!host) return;

  const contacts = scopeContacts();
  const term = crmSearch.trim().toLowerCase();
  const visible = contacts
    .filter((contact) => crmStageFilter === 'all' || contact.stage === crmStageFilter)
    .filter((contact) => {
      if (!term) return true;
      return [contact.name, contact.company, contact.role, contact.source]
        .concat(contact.tags || [])
        .some((value) => String(value || '').toLowerCase().includes(term));
    })
    .sort((a, b) => {
      const left = a.nextFollowUpOn || '9999-12-31';
      const right = b.nextFollowUpOn || '9999-12-31';
      if (left !== right) return left.localeCompare(right);
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });

  const count = $('#contactCount');
  if (count) {
    count.textContent = contacts.length
      ? visible.length + ' of ' + contacts.length + (contacts.length === 1 ? ' contact' : ' contacts')
      : '0 contacts';
  }

  if (!visible.length) {
    host.innerHTML = '<div class="social-empty">' +
      (contacts.length
        ? 'No contacts match this filter.'
        : 'No contacts in this scope yet. Add one on the left, then log interactions as you go.') +
      '</div>';
    return;
  }

  host.innerHTML = visible.map((contact) => {
    const meta = [
      contact.company || '',
      contact.role || ''
    ].filter(Boolean).join(' · ');
    const tags = (contact.tags || []).length
      ? '<span class="contact-tags">' + contact.tags.map((tag) => escapeHtml(tag)).join(' · ') + '</span>'
      : '';
    return '<article class="contact-card">' +
      '<button class="contact-open" type="button" data-contact-open="' + escapeHtml(contact.id) + '">' +
        '<span class="social-avatar" aria-hidden="true">' + escapeHtml(contactInitials(contact.name)) + '</span>' +
        '<span class="contact-main">' +
          '<strong class="contact-name">' + escapeHtml(contact.name) + '</strong>' +
          (meta ? '<span>' + escapeHtml(meta) + '</span>' : '') +
          '<span class="contact-meta">' + contactStageBadge(contact.stage) +
            (contact.lastContactOn
              ? '<span>Last · ' + escapeHtml(formatDay(contact.lastContactOn)) + '</span>'
              : '') +
            contactFollowUpLabel(contact) +
          '</span>' +
          tags +
        '</span>' +
      '</button>' +
      '<button class="contact-del" type="button" data-contact-delete="' + escapeHtml(contact.id) +
        '" title="Delete contact" aria-label="Delete ' + escapeHtml(contact.name) + '">×</button>' +
    '</article>';
  }).join('');
}

function openContactModal(id) {
  contactModalId = id || null;
  renderContactModal();
  const modal = $('#contactModal');
  if (modal) openModal(modal);
}

function renderContactModal() {
  const id = contactModalId;
  const contact = id ? findContact(id) : null;
  if (id && !contact) {
    closeModal($('#contactModal'));
    return;
  }

  const title = $('#contactModalTitle');
  if (title) title.textContent = contact ? contact.name : 'Add contact';
  const sub = $('#contactModalSub');
  if (sub) {
    sub.textContent = contact
      ? [contact.company, contact.role].filter(Boolean).join(' · ') || 'Contact'
      : 'Add a business contact, then log every interaction in one timeline.';
  }

  const fields = {
    contactFormId: contact ? contact.id : '',
    contactFormVersion: contact ? contact.version : '',
    contactFormName: contact ? contact.name : '',
    contactFormCompany: contact ? contact.company : '',
    contactFormRole: contact ? contact.role : '',
    contactFormEmail: contact ? contact.email : '',
    contactFormPhone: contact ? contact.phone : '',
    contactFormUrl: contact ? contact.url : '',
    contactFormSource: contact ? contact.source : '',
    contactFormTags: contact ? contactTagsText(contact) : '',
    contactFormFollowUp: contact ? dayOnly(contact.nextFollowUpOn) : '',
    contactFormLastTouch: contact ? dayOnly(contact.lastContactOn) : '',
    contactFormNotes: contact ? (contact.notes || '') : ''
  };
  Object.entries(fields).forEach(([key, value]) => {
    const input = $('#' + key);
    if (input) input.value = value;
  });

  const stage = $('#contactFormStage');
  if (stage) stage.innerHTML = contactStageOptions(contact ? contact.stage : 'lead');

  const scope = $('#contactFormScope');
  if (scope) {
    scope.textContent = contact
      ? (contact.circleId
        ? 'Shared with ' + circleName(contact.circleId) + '. Notes are visible to everyone in the circle.'
        : 'Private to ' + personName(contact.ownerId) + '.')
      : (togetherScope === 'me'
        ? 'Private to you. You can share it later from a circle.'
        : 'Shared with ' + circleName(togetherScope) + '.');
  }

  const error = $('#contactFormError');
  if (error) error.hidden = true;

  const deleteBtn = $('#contactDeleteBtn');
  if (deleteBtn) {
    deleteBtn.hidden = !contact || !canEditContact(contact);
    if (contact) deleteBtn.dataset.contactDelete = contact.id;
  }

  const timelineWrap = $('#contactTimelineWrap');
  if (timelineWrap) timelineWrap.hidden = !contact;
  if (contact) renderContactTimeline(contact);
}

function renderContactTimeline(contact) {
  const host = $('#contactTimeline');
  if (!host) return;
  const notes = contactNotes(contact.id);
  const count = $('#contactTimelineCount');
  if (count) {
    count.textContent = notes.length
      ? notes.length + (notes.length === 1 ? ' note' : ' notes')
      : 'No notes';
  }

  if (!notes.length) {
    host.innerHTML = '<div class="social-empty">No interactions logged yet. Log the first one below.</div>';
    return;
  }

  host.innerHTML = notes.map((note) => {
    const canDelete = canDeleteContactNote(contact, note);
    return '<div class="contact-note">' +
      '<div class="contact-note-head">' +
        '<strong>' + personNameHtml(note.authorId) + '</strong>' +
        '<span>' + escapeHtml(formatDay(note.happenedOn)) + '</span>' +
        (canDelete
          ? '<button class="contact-note-del" type="button" data-note-delete="' + escapeHtml(note.id) +
            '" title="Remove note" aria-label="Remove note">×</button>'
          : '') +
      '</div>' +
      '<p>' + escapeHtml(note.body) + '</p>' +
    '</div>';
  }).join('');
}

async function addContact(event) {
  event.preventDefault();
  const nameInput = $('#contactName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    toast('Give the contact a name', 'error');
    if (nameInput) nameInput.focus();
    return;
  }

  const value = (key) => {
    const input = $('#' + key);
    return input ? input.value.trim() : '';
  };

  const followUp = value('contactFollowUpNew');
  const data = await spaceRequest('/contacts', {
    method: 'POST',
    body: {
      name,
      company: value('contactCompany'),
      role: value('contactRole'),
      email: value('contactEmail'),
      phone: value('contactPhone'),
      url: value('contactUrl'),
      source: value('contactSource'),
      stage: value('contactStageNew') || 'lead',
      tags: parseContactTags(value('contactTagsNew')),
      nextFollowUpOn: followUp || undefined,
      circleId: scopeCircleId()
    }
  });
  if (!data || !data.contact) return;

  upsertSpaceRow('contacts', data.contact);
  refreshSpaceViews();
  toast('Contact added');
  const form = $('#newContactForm');
  if (form) form.reset();
  const stageNew = $('#contactStageNew');
  if (stageNew) stageNew.value = 'lead';
}

async function saveContact(event) {
  event.preventDefault();
  const id = $('#contactFormId').value;
  const nameInput = $('#contactFormName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    toast('Give the contact a name', 'error');
    if (nameInput) nameInput.focus();
    return;
  }

  const value = (key) => {
    const input = $('#' + key);
    return input ? input.value.trim() : '';
  };
  const followUp = value('contactFormFollowUp');
  const body = {
    name,
    company: value('contactFormCompany'),
    role: value('contactFormRole'),
    email: value('contactFormEmail'),
    phone: value('contactFormPhone'),
    url: value('contactFormUrl'),
    source: value('contactFormSource'),
    stage: value('contactFormStage') || 'lead',
    tags: parseContactTags(value('contactFormTags')),
    nextFollowUpOn: followUp || '',
    lastContactOn: value('contactFormLastTouch') || '',
    notes: value('contactFormNotes')
  };

  const data = id
    ? await spaceRequest('/contacts/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: { ...body, version: Number(value('contactFormVersion')) || 1 }
      })
    : await spaceRequest('/contacts', {
        method: 'POST',
        body: { ...body, circleId: scopeCircleId() }
      });
  if (!data || !data.contact) return;

  upsertSpaceRow('contacts', data.contact);
  contactModalId = null;
  closeModal($('#contactModal'));
  refreshSpaceViews();
  toast(id ? 'Contact updated' : 'Contact added');
}

async function deleteContact(id) {
  const contact = findContact(id);
  if (!contact) return;
  const ok = await confirmAction({
    title: 'Delete contact?',
    message: 'Delete ' + contact.name + '? The contact and its notes will be hidden.',
    confirmLabel: 'Delete contact'
  });
  if (!ok) return;

  const data = await spaceRequest('/contacts/' + encodeURIComponent(id), {
    method: 'DELETE',
    body: { version: contact.version }
  });
  if (!data) return;

  dropSpaceRow('contacts', id);
  state.space.contactNotes = state.space.contactNotes.filter((note) => note.contactId !== id);
  if (contactModalId === id) {
    contactModalId = null;
    closeModal($('#contactModal'));
  }
  refreshSpaceViews();
  toast('Contact deleted');
}

async function addContactNote(event) {
  event.preventDefault();
  const id = contactModalId;
  if (!id) return;
  const bodyInput = $('#contactNoteBody');
  const body = bodyInput ? bodyInput.value.trim() : '';
  if (!body) {
    toast('Write the interaction first', 'error');
    if (bodyInput) bodyInput.focus();
    return;
  }

  const dateInput = $('#contactNoteDate');
  const followUpInput = $('#contactNoteFollowUp');
  const data = await spaceRequest('/contacts/' + encodeURIComponent(id) + '/notes', {
    method: 'POST',
    body: {
      body,
      happenedOn: dateInput && dateInput.value ? dateInput.value : undefined,
      nextFollowUpOn: followUpInput && followUpInput.value ? followUpInput.value : ''
    }
  });
  if (!data || !data.note || !data.contact) return;

  upsertSpaceRow('contactNotes', data.note);
  upsertSpaceRow('contacts', data.contact);
  if (bodyInput) bodyInput.value = '';
  if (followUpInput) followUpInput.value = '';
  // Keep the user's other edits (company, role, …) — they may have typed
  // them before logging this interaction. Only the note form itself resets.
  const contactRef = findContact(id);
  if (contactRef) {
    renderContactTimeline(contactRef);
    const lastTouch = $('#contactFormLastTouch');
    if (lastTouch && !lastTouch.value) {
      lastTouch.value = dayOnly(contactRef.lastContactOn) || '';
    }
    const versionInput = $('#contactFormVersion');
    if (versionInput) versionInput.value = String(contactRef.version);
  }
  refreshSpaceViews();
  toast('Interaction logged');
}

async function deleteContactNote(noteId) {
  const ok = await confirmAction({
    title: 'Remove this note?',
    message: 'The interaction will be removed from the timeline.',
    confirmLabel: 'Remove'
  });
  if (!ok) return;
  const data = await spaceRequest(
    '/contacts/' + encodeURIComponent(contactModalId) + '/notes/' + encodeURIComponent(noteId),
    { method: 'DELETE' }
  );
  if (!data) return;
  dropSpaceRow('contactNotes', noteId);
  renderContactModal();
  refreshSpaceViews();
  toast('Note removed');
}

async function addBook(event) {
  event.preventDefault();
  const titleInput = $('#bookTitle');
  const authorInput = $('#bookAuthor');
  const linkInput = $('#bookLink');
  const categoryInput = $('#bookCategory');
  const pagesInput = $('#bookPages');

  const title = titleInput ? titleInput.value.trim() : '';
  if (!title) {
    toast('Give the book a title', 'error');
    if (titleInput) titleInput.focus();
    return;
  }

  const pages = pagesInput && pagesInput.value ? Number(pagesInput.value) : 0;
  if (!Number.isInteger(pages) || pages < 0 || pages > 20000) {
    toast('Pages must be a whole number', 'error');
    return;
  }

  const data = await spaceRequest('/books', {
    method: 'POST',
    body: {
      title,
      author: authorInput ? authorInput.value.trim() : '',
      linkUrl: linkInput ? linkInput.value.trim() : '',
      category: categoryInput && categoryInput.value ? categoryInput.value : 'General',
      pagesTotal: pages,
      circleId: scopeCircleId()
    }
  });
  if (!data || !data.book) return;

  upsertSpaceRow('books', data.book);
  if (titleInput) titleInput.value = '';
  if (authorInput) authorInput.value = '';
  if (linkInput) linkInput.value = '';
  if (pagesInput) pagesInput.value = '';
  refreshSpaceViews();
  toast('Book added to the shelf');
  if (titleInput) titleInput.focus();
}

async function saveBookShelf(id, shelf) {
  const book = (state.space.books || []).find((entry) => entry.id === id);
  if (!book || shelf === book.shelf) return;

  const data = await spaceRequest('/books/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { shelf, version: book.version }
  });
  if (data && data.book) {
    upsertSpaceRow('books', data.book);
    refreshSpaceViews();
  } else {
    renderShelf();
  }
}

async function saveBookPages(id, value) {
  const book = (state.space.books || []).find((entry) => entry.id === id);
  if (!book) return;

  const total = Number(book.pagesTotal) || 0;
  let pagesRead = value === '' ? 0 : Number(value);
  if (!Number.isInteger(pagesRead) || pagesRead < 0) {
    toast('Pages read must be a whole number', 'error');
    renderShelf();
    return;
  }
  if (total > 0) pagesRead = Math.min(pagesRead, total);
  if (pagesRead === book.pagesRead) {
    renderShelf();
    return;
  }

  const data = await spaceRequest('/books/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { pagesRead, version: book.version }
  });
  if (data && data.book) {
    upsertSpaceRow('books', data.book);
    refreshSpaceViews();
  } else {
    renderShelf();
  }
}

async function saveBookCategory(id, value) {
  const book = (state.space.books || []).find((entry) => entry.id === id);
  if (!book) return;

  const category = value || 'General';
  if (category === book.category) return;

  const data = await spaceRequest('/books/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { category, version: book.version }
  });
  if (data && data.book) {
    upsertSpaceRow('books', data.book);
    refreshSpaceViews();
  } else {
    renderShelf();
  }
}

function editBookLink(id) {
  editingBookLinkId = id;
  renderShelf();
  setTimeout(() => {
    const input = document.querySelector('[data-book-link-input="' + id + '"]');
    if (input) input.focus();
  }, 0);
}

async function saveBookLink(id, value) {
  const book = (state.space.books || []).find((entry) => entry.id === id);
  if (!book) return;

  const linkUrl = value.trim();
  if (linkUrl === (book.linkUrl || '')) {
    editingBookLinkId = null;
    renderShelf();
    return;
  }

  const data = await spaceRequest('/books/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { linkUrl, version: book.version }
  });
  if (data && data.book) {
    upsertSpaceRow('books', data.book);
    editingBookLinkId = null;
    refreshSpaceViews();
    toast(linkUrl ? 'Book link saved' : 'Book link removed');
  }
}

async function saveBookRating(id, value) {
  const book = (state.space.books || []).find((entry) => entry.id === id);
  if (!book) return;

  const rating = value === '' ? null : Number(value);
  if (rating === book.rating) return;

  const data = await spaceRequest('/books/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { rating, version: book.version }
  });
  if (data && data.book) {
    upsertSpaceRow('books', data.book);
    refreshSpaceViews();
  } else {
    renderShelf();
  }
}

async function deleteBook(id) {
  const book = (state.space.books || []).find((entry) => entry.id === id);
  if (!book) return;
  const ok = await confirmAction({
    title: 'Remove book?',
    message: 'Remove "' + book.title + '" from the shelf?',
    confirmLabel: 'Remove'
  });
  if (!ok) return;

  const data = await spaceRequest('/books/' + encodeURIComponent(id), {
    method: 'DELETE',
    body: { version: book.version }
  });
  if (!data) return;

  dropSpaceRow('books', id);
  refreshSpaceViews();
  toast('Book removed');
}

async function addSpaceTask(event) {
  event.preventDefault();
  const titleInput = $('#taskTitle');
  const notesInput = $('#taskNotes');
  const listSelect = $('#taskListSelect');
  const projectSelect = $('#taskProjectSelect');
  const dueInput = $('#taskDue');
  const assigneeSelect = $('#taskAssignee');

  const title = titleInput ? titleInput.value.trim() : '';
  if (!title) {
    toast('Write the task first', 'error');
    titleInput && titleInput.focus();
    return;
  }

  let dueAt = null;
  if (dueInput && dueInput.value) {
    const due = new Date(dueInput.value);
    if (Number.isNaN(due.getTime())) {
      toast('That due date is not valid', 'error');
      return;
    }
    dueAt = due.toISOString();
  }

  const data = await spaceRequest('/tasks', {
    method: 'POST',
    body: {
      title,
      notes: notesInput ? notesInput.value.trim() : '',
      listId: listSelect && listSelect.value ? listSelect.value : null,
      projectId: projectSelect && projectSelect.value ? projectSelect.value : null,
      circleId: togetherScope === 'me' ? null : togetherScope,
      dueAt,
      assigneeId: assigneeSelect && !assigneeSelect.hidden && assigneeSelect.value
        ? assigneeSelect.value
        : null
    }
  });
  if (!data || !data.task) return;

  upsertSpaceRow('tasks', data.task);
  if (titleInput) titleInput.value = '';
  if (notesInput) notesInput.value = '';
  if (dueInput) dueInput.value = '';
  refreshSpaceViews();
  toast('Task added');
  if (titleInput) titleInput.focus();
}

async function toggleSpaceTask(id) {
  const task = findSpaceTask(id);
  if (!task) return;

  const next = task.status === 'done' ? 'open' : 'done';
  const previous = { status: task.status, completedAt: task.completedAt };
  task.status = next;
  task.completedAt = next === 'done' ? new Date().toISOString() : null;
  renderTogether();

  const data = await spaceRequest('/tasks/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { status: next, version: task.version }
  });

  if (data && data.task) {
    upsertSpaceRow('tasks', data.task);
  } else {
    task.status = previous.status;
    task.completedAt = previous.completedAt;
  }
  refreshSpaceViews();
}

async function saveTaskTitle(id, value) {
  const task = findSpaceTask(id);
  if (!task) return;
  const title = value.trim();
  if (!title) {
    toast('A task needs a title', 'error');
    renderTodos();
    return;
  }
  if (title === task.title) return;

  const data = await spaceRequest('/tasks/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { title, version: task.version }
  });
  if (data && data.task) {
    upsertSpaceRow('tasks', data.task);
    refreshSpaceViews();
  }
}

async function saveTaskDue(id, value) {
  const task = findSpaceTask(id);
  if (!task) return;

  let dueAt = null;
  if (value) {
    const due = new Date(value);
    if (Number.isNaN(due.getTime())) {
      toast('That due date is not valid', 'error');
      renderTodos();
      return;
    }
    dueAt = due.toISOString();
  }

  const data = await spaceRequest('/tasks/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { dueAt, version: task.version }
  });
  if (data && data.task) {
    upsertSpaceRow('tasks', data.task);
    refreshSpaceViews();
    if (currentPage === 'calendar') toast('Calendar updated');
  }
}

async function saveTaskAssignee(id, value) {
  const task = findSpaceTask(id);
  if (!task) return;

  const data = await spaceRequest('/tasks/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { assigneeId: value || null, version: task.version }
  });
  if (data && data.task) {
    upsertSpaceRow('tasks', data.task);
    refreshSpaceViews();
  }
}

async function saveTaskProject(id, value) {
  const task = findSpaceTask(id);
  if (!task) return;

  const data = await spaceRequest('/tasks/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: { projectId: value || null, version: task.version }
  });
  if (data && data.task) {
    upsertSpaceRow('tasks', data.task);
    refreshSpaceViews();
  }
}

async function deleteSpaceTask(id) {
  const task = findSpaceTask(id);
  if (!task) return;
  const ok = await confirmAction({
    title: 'Delete task?',
    message: 'Delete "' + task.title + '"?',
    confirmLabel: 'Delete task'
  });
  if (!ok) return;

  const data = await spaceRequest('/tasks/' + encodeURIComponent(id), {
    method: 'DELETE',
    body: { version: task.version }
  });
  if (!data) return;
  dropSpaceRow('tasks', id);
  refreshSpaceViews();
  toast('Task deleted');
}

async function addSpaceList(event) {
  event.preventDefault();
  const input = $('#newListName');
  const name = input ? input.value.trim() : '';
  if (!name) {
    toast('Give the list a name', 'error');
    return;
  }

  const data = await spaceRequest('/task-lists', {
    method: 'POST',
    body: { name, circleId: togetherScope === 'me' ? null : togetherScope }
  });
  if (!data || !data.taskList) return;

  upsertSpaceRow('taskLists', data.taskList);
  togetherListId = data.taskList.id;
  if (input) input.value = '';
  refreshSpaceViews();
  toast('List added');
}

async function deleteSpaceList(id) {
  const list = findSpaceList(id);
  if (!list) return;
  const ok = await confirmAction({
    title: 'Delete list?',
    message: 'Delete the list "' + list.name + '"? Its tasks stay, without a list.',
    confirmLabel: 'Delete list'
  });
  if (!ok) return;

  const data = await spaceRequest('/task-lists/' + encodeURIComponent(id), {
    method: 'DELETE',
    body: { version: list.version }
  });
  if (!data) return;

  state.space.tasks.forEach((task) => {
    if (task.listId === id) task.listId = null;
  });
  dropSpaceRow('taskLists', id);
  if (togetherListId === id) togetherListId = 'all';
  refreshSpaceViews();
  toast('List deleted');
}

function openTaskFromCalendar(id) {
  const task = findSpaceTask(id);
  if (!task) return;
  togetherScope = task.circleId || 'me';
  togetherTab = 'todos';
  togetherListId = 'all';
  showPage('together');
  setTimeout(() => {
    const row = document.getElementById('spaceTask-' + id);
    if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 80);
}

async function handleCreateCircle(event) {
  event.preventDefault();
  const input = $('#circleName');
  const name = input ? input.value.trim() : '';
  if (!name) {
    toast('Give the circle a name', 'error');
    return;
  }

  const submit = $('#circleCreateBtn');
  if (submit) submit.disabled = true;
  const data = await spaceRequest('/circles', { method: 'POST', body: { name } });
  if (submit) submit.disabled = false;
  if (!data || !data.circle) return;

  closeModal($('#circleModal'));
  if (input) input.value = '';
  togetherScope = data.circle.id;
  togetherListId = 'all';
  await loadSpace({ silent: true });
  renderTogether();
  toast('Circle created');
}

async function addCircleMemberFromForm(event) {
  event.preventDefault();
  const select = $('#circleAddSelect');
  const userId = select ? select.value : '';
  if (!userId || togetherScope === 'me') return;

  const data = await spaceRequest('/circles/' + encodeURIComponent(togetherScope) + '/members', {
    method: 'POST',
    body: { userId }
  });
  if (!data) return;

  await loadSpace({ silent: true });
  renderTogether();
  toast('Kniggur added to the circle');
}

async function removeCircleMember(circleId, userId) {
  const me = state.cloud.user && state.cloud.user.id;
  const self = userId === me;
  const ok = await confirmAction({
    title: self ? 'Leave this circle?' : 'Remove member?',
    message: self
      ? 'You will lose access to its shared lists and tasks.'
      : 'Remove ' + personName(userId) + ' from this circle?',
    confirmLabel: self ? 'Leave' : 'Remove'
  });
  if (!ok) return;

  const data = await spaceRequest(
    '/circles/' + encodeURIComponent(circleId) + '/members/' + encodeURIComponent(userId),
    { method: 'DELETE' }
  );
  if (!data) return;

  if (self) {
    togetherScope = 'me';
    togetherListId = 'all';
  }
  await loadSpace({ silent: true });
  renderTogether();
  toast(self ? 'You left the circle' : 'Kniggur removed');
}

async function deleteCircle(circleId) {
  const circle = circleById(circleId);
  if (!circle) return;
  const ok = await confirmAction({
    title: 'Archive circle?',
    message: 'Archive "' + circle.name + '"? Its lists and tasks go back to their creators.',
    confirmLabel: 'Archive'
  });
  if (!ok) return;

  const data = await spaceRequest('/circles/' + encodeURIComponent(circleId), { method: 'DELETE' });
  if (!data) return;

  if (togetherScope === circleId) {
    togetherScope = 'me';
    togetherListId = 'all';
  }
  await loadSpace({ silent: true });
  renderTogether();
  toast('Circle archived');
}

function exitCircle(circleId) {
  const circle = circleById(circleId);
  const me = state.cloud.user && state.cloud.user.id;
  if (!circle || !me) return;
  if (circle.role === 'owner' || circle.ownerId === me) {
    deleteCircle(circleId);
    return;
  }
  removeCircleMember(circleId, me);
}

// ---------------------------------------------------------------- Together calendar

function spaceScheduleItems() {
  const taskItems = state.space.tasks
    .filter((task) => task.dueAt && !Number.isNaN(new Date(task.dueAt).getTime()))
    .map((task) => ({
      key: 'task:' + task.id,
      source: 'task',
      sourceId: task.id,
      title: task.title,
      at: task.dueAt,
      allDay: Boolean(task.dueAllDay),
      kind: 'task',
      circleId: task.circleId || null,
      done: task.status === 'done',
      task
    }));
  const projectItems = (state.space.projects || [])
    .filter((project) => project.targetOn)
    .map((project) => ({
      key: 'project:' + project.id,
      source: 'project',
      sourceId: project.id,
      title: project.name,
      at: dayOnly(project.targetOn) + 'T09:00',
      allDay: true,
      kind: 'milestone',
      circleId: project.circleId || null,
      done: project.status === 'done',
      project
    }));
  const contactItems = (state.space.contacts || [])
    .filter((contact) => contact.nextFollowUpOn)
    .map((contact) => ({
      key: 'contact:' + contact.id,
      source: 'crm',
      sourceId: contact.id,
      title: 'Follow up: ' + contact.name,
      at: dayOnly(contact.nextFollowUpOn) + 'T09:00',
      allDay: true,
      kind: 'follow-up',
      circleId: contact.circleId || null,
      contact
    }));
  return taskItems.concat(projectItems, contactItems);
}

function scheduleItems() {
  const applicationItems = allEvents().map(({ app, event }) => ({
    key: 'event:' + event.id,
    source: 'application',
    sourceId: event.id,
    title: eventTitle(event),
    at: event.at,
    allDay: false,
    kind: event.kind,
    circleId: null,
    done: false,
    app,
    event
  }));
  return applicationItems
    .concat(spaceScheduleItems())
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function calendarVisibleItems() {
  const items = scheduleItems();
  if (calendarScope === 'all') return items;
  if (calendarScope === 'me') return items.filter((item) => !item.circleId);
  return items.filter((item) => item.circleId === calendarScope);
}

function calendarSourceLabel(item) {
  if (item.source === 'task') {
    const where = item.circleId ? circleName(item.circleId) : 'My task';
    const assignee = item.task && item.task.assigneeId ? ' · ' + personName(item.task.assigneeId) : '';
    return where + assignee;
  }
  if (item.source === 'crm') {
    const where = item.contact && item.contact.circleId
      ? circleName(item.contact.circleId)
      : 'My contact';
    return where + (item.contact && item.contact.company ? ' · ' + item.contact.company : '');
  }
  if (item.source === 'project') {
    const where = item.circleId ? circleName(item.circleId) : 'My project';
    return where + ' · Project target';
  }
  return eventKindLabel(item.event);
}

// Same label as calendarSourceLabel, but marked up so a task assignee can carry
// a live presence dot. Google Calendar still uses the plain-text label.
function calendarSourceHtml(item) {
  if (item.source === 'task') {
    const where = item.circleId ? circleName(item.circleId) : 'My task';
    const assignee = item.task && item.task.assigneeId
      ? ' · ' + personNameHtml(item.task.assigneeId)
      : '';
    return escapeHtml(where) + assignee;
  }
  return escapeHtml(calendarSourceLabel(item));
}

function scheduleWhen(item, options = {}) {
  if (item.allDay) {
    const day = options.withDay || options.full ? relativeDay(item.at) : '';
    return day ? day + ' · All day' : 'All day';
  }
  let when = formatTime(item.at);
  if (options.withDay) when = relativeDay(item.at) + ' · ' + when;
  if (options.full) when = formatEventDateTime(item.at);
  return when;
}

function scheduleRowHtml(item, options = {}) {
  const past = new Date(item.at).getTime() < Date.now() ? ' is-past' : '';
  const subHtml = escapeHtml(scheduleWhen(item, options)) + ' · ' + calendarSourceHtml(item);
  const kindClass = item.source === 'task' ? ' task'
    : item.source === 'crm' ? ' crm'
    : item.source === 'project' ? ' project'
    : (item.kind === 'reminder' ? ' reminder' : '');
  const main = item.source === 'task'
    ? '<button class="event-row-main event-row-button" type="button" data-cal-task-open="' +
        escapeHtml(item.sourceId) + '">' +
        '<strong>' + escapeHtml(item.title) + '</strong>' +
        '<span>' + subHtml + '</span>' +
      '</button>'
    : item.source === 'crm'
      ? '<button class="event-row-main event-row-button" type="button" data-cal-contact-open="' +
          escapeHtml(item.sourceId) + '">' +
          '<strong>' + escapeHtml(item.title) + '</strong>' +
          '<span>' + subHtml + '</span>' +
        '</button>'
      : item.source === 'project'
        ? '<button class="event-row-main event-row-button" type="button" data-cal-project-open="' +
            escapeHtml(item.sourceId) + '">' +
            '<strong>' + escapeHtml(item.title) + '</strong>' +
            '<span>' + subHtml + '</span>' +
          '</button>'
        : '<span class="event-row-main">' +
            '<strong>' + escapeHtml(item.title) + '</strong>' +
            '<span>' + subHtml + '</span>' +
          '</span>';

  const action = item.source === 'task'
    ? '<button class="event-del task-check-mini" type="button" data-cal-task-done="' +
        escapeHtml(item.sourceId) + '" title="' + (item.done ? 'Reopen task' : 'Mark task done') +
        '" aria-label="' + (item.done ? 'Reopen task' : 'Mark task done') + '">' +
        (item.done ? '↺' : '✓') + '</button>'
    : item.source === 'crm'
      ? '<button class="event-del" type="button" data-cal-contact-open="' + escapeHtml(item.sourceId) +
          '" title="Open contact" aria-label="Open contact">↗</button>'
      : item.source === 'project'
        ? '<button class="event-del" type="button" data-cal-project-open="' + escapeHtml(item.sourceId) +
            '" title="Open project" aria-label="Open project">↗</button>'
        : '<button class="event-del" type="button" data-event-del="' + escapeHtml(item.event.id) +
          '" title="Remove event" aria-label="Remove event">×</button>';

  const gcal = googleCalendarLink({
    title: item.title,
    at: item.at,
    allDay: item.allDay,
    details: calendarSourceLabel(item) +
      (item.source === 'application' && item.app && item.app.company ? ' · ' + item.app.company : '')
  });

  return '<div class="event-row' + past + (item.done ? ' is-done' : '') + '">' +
    '<span class="event-kind' + kindClass + '"></span>' +
    main +
    gcal +
    action +
  '</div>';
}

// ---------------------------------------------------------------- Events

function bindEvents() {
  document.addEventListener('click', (event) => {
    const scopeTrigger = event.target.closest('#togetherScopeBtn');
    if (scopeTrigger) {
      event.preventDefault();
      const menu = $('#togetherScopeMenu');
      if (menu && menu.hidden) renderTogetherScope();
      setScopeMenuOpen(Boolean(menu && menu.hidden));
      return;
    }

    const scopeOption = event.target.closest('[data-scope-value]');
    if (scopeOption) {
      event.preventDefault();
      setScopeMenuOpen(false);
      setTogetherScope(scopeOption.dataset.scopeValue);
      const button = $('#togetherScopeBtn');
      if (button) button.focus();
      return;
    }

    const openScopeMenu = $('#togetherScopeMenu');
    if (openScopeMenu && !openScopeMenu.hidden && !event.target.closest('#togetherScopePicker')) {
      setScopeMenuOpen(false);
    }

    const railButton = event.target.closest('.rail-btn');
    if (railButton && railButton.dataset.page) {
      event.preventDefault();
      showPage(railButton.dataset.page);
      return;
    }

    const togetherTabButton = event.target.closest('[data-together-tab]');
    if (togetherTabButton) {
      event.preventDefault();
      setTogetherTab(togetherTabButton.dataset.togetherTab);
      return;
    }

    const addToggle = event.target.closest('[data-add-toggle]');
    if (addToggle) {
      event.preventDefault();
      toggleAddPanel(addToggle);
      return;
    }

    const togetherOpenTab = event.target.closest('[data-together-open-tab]');
    if (togetherOpenTab) {
      event.preventDefault();
      const tab = togetherOpenTab.dataset.togetherOpenTab;
      togetherTab = TOGETHER_TABS.includes(tab) ? tab : 'kniggurs';
      showPage('together');
      return;
    }

    const togetherOpenCircle = event.target.closest('[data-together-open-circle]');
    if (togetherOpenCircle) {
      event.preventDefault();
      togetherScope = togetherOpenCircle.dataset.togetherOpenCircle;
      togetherListId = 'all';
      showPage('together');
      return;
    }

    const contactOpen = event.target.closest('[data-contact-open]');
    if (contactOpen) {
      event.preventDefault();
      openContactModal(contactOpen.dataset.contactOpen);
      return;
    }

    const contactDelete = event.target.closest('[data-contact-delete]');
    if (contactDelete) {
      event.preventDefault();
      deleteContact(contactDelete.dataset.contactDelete);
      return;
    }

    const noteDelete = event.target.closest('[data-note-delete]');
    if (noteDelete) {
      event.preventDefault();
      deleteContactNote(noteDelete.dataset.noteDelete);
      return;
    }

    const togetherOpenContact = event.target.closest('[data-together-open-contact]');
    if (togetherOpenContact) {
      event.preventDefault();
      openContactModal(togetherOpenContact.dataset.togetherOpenContact);
      return;
    }

    const calContactOpen = event.target.closest('[data-cal-contact-open]');
    if (calContactOpen) {
      event.preventDefault();
      openContactModal(calContactOpen.dataset.calContactOpen);
      return;
    }

    const circleSettingsBtn = event.target.closest('[data-circle-settings]');
    if (circleSettingsBtn) {
      event.preventDefault();
      const tray = $('#circleSettingsTray');
      const circle = togetherScope === 'me' ? null : circleById(togetherScope);
      if (circle && tray) {
        if (tray.hidden) {
          renderCircleCard();
          tray.hidden = false;
        } else {
          tray.hidden = true;
        }
      }
      return;
    }

    const circleSettingsClose = event.target.closest('#circleSettingsClose');
    if (circleSettingsClose) {
      event.preventDefault();
      const tray = $('#circleSettingsTray');
      if (tray) tray.hidden = true;
      return;
    }

    const circleRemove = event.target.closest('[data-circle-remove]');
    if (circleRemove) {
      event.preventDefault();
      if (togetherScope !== 'me') {
        removeCircleMember(togetherScope, circleRemove.dataset.circleRemove);
      }
      return;
    }

    const circleExit = event.target.closest('[data-circle-exit]');
    if (circleExit) {
      event.preventDefault();
      if (circleExit.dataset.circleExit) exitCircle(circleExit.dataset.circleExit);
      return;
    }

    const spaceList = event.target.closest('[data-space-list]');
    if (spaceList) {
      event.preventDefault();
      togetherListId = spaceList.dataset.spaceList;
      renderTodos();
      return;
    }

    const listDelete = event.target.closest('[data-list-delete]');
    if (listDelete) {
      event.preventDefault();
      deleteSpaceList(listDelete.dataset.listDelete);
      return;
    }

    const shelfFilterButton = event.target.closest('[data-shelf-filter]');
    if (shelfFilterButton) {
      event.preventDefault();
      shelfFilter = shelfFilterButton.dataset.shelfFilter;
      renderShelf();
      return;
    }

    const bookDelete = event.target.closest('[data-book-delete]');
    if (bookDelete) {
      event.preventDefault();
      deleteBook(bookDelete.dataset.bookDelete);
      return;
    }

    const categorySuggestion = event.target.closest('[data-shelf-category-suggest]');
    if (categorySuggestion) {
      event.preventDefault();
      suggestShelfCategory(categorySuggestion.dataset.shelfCategorySuggest);
      return;
    }

    const crmStageFilterButton = event.target.closest('[data-crm-stage]');
    if (crmStageFilterButton) {
      crmStageFilter = crmStageFilterButton.dataset.crmStage || 'all';
      renderContactList();
      return;
    }

    const categoryDelete = event.target.closest('[data-shelf-category-delete]');
    if (categoryDelete) {
      event.preventDefault();
      deleteShelfCategory(categoryDelete.dataset.shelfCategoryDelete);
      return;
    }

    const bookLinkEdit = event.target.closest('[data-book-link-edit]');
    if (bookLinkEdit) {
      event.preventDefault();
      editBookLink(bookLinkEdit.dataset.bookLinkEdit);
      return;
    }

    const bookLinkCancel = event.target.closest('[data-book-link-cancel]');
    if (bookLinkCancel) {
      event.preventDefault();
      editingBookLinkId = null;
      renderShelf();
      return;
    }

    const taskToggle = event.target.closest('[data-task-toggle]');
    if (taskToggle) {
      event.preventDefault();
      toggleSpaceTask(taskToggle.dataset.taskToggle);
      return;
    }

    const taskDelete = event.target.closest('[data-task-delete]');
    if (taskDelete) {
      event.preventDefault();
      deleteSpaceTask(taskDelete.dataset.taskDelete);
      return;
    }

    const circleRemoveBtn = event.target.closest('[data-circle-remove-btn]');
    if (circleRemoveBtn) {
      const memberId = circleRemoveBtn.dataset.circleRemoveBtn;
      if (memberId && togetherScope !== 'me') {
        event.preventDefault();
        removeCircleMember(togetherScope, memberId);
      }
      return;
    }

    const circleDeleteBtn = event.target.closest('[data-circle-delete-btn]');
    if (circleDeleteBtn) {
      const circleId = circleDeleteBtn.dataset.circleDeleteBtn;
      if (circleId) {
        event.preventDefault();
        deleteCircle(circleId);
      }
      return;
    }

    const projectOpen = event.target.closest('[data-project-open]');
    if (projectOpen) {
      event.preventDefault();
      openProjectModal(projectOpen.dataset.projectOpen);
      return;
    }

    const projectDelete = event.target.closest('[data-project-delete]');
    if (projectDelete) {
      event.preventDefault();
      deleteProject(projectDelete.dataset.projectDelete);
      return;
    }

    const calProjectOpen = event.target.closest('[data-cal-project-open]');
    if (calProjectOpen) {
      event.preventDefault();
      openProjectFromCalendar(calProjectOpen.dataset.calProjectOpen);
      return;
    }

    const calTaskOpen = event.target.closest('[data-cal-task-open]');
    if (calTaskOpen) {
      event.preventDefault();
      openTaskFromCalendar(calTaskOpen.dataset.calTaskOpen);
      return;
    }

    const calTaskDone = event.target.closest('[data-cal-task-done]');
    if (calTaskDone) {
      event.preventDefault();
      toggleSpaceTask(calTaskDone.dataset.calTaskDone);
      return;
    }

    const addJob = event.target.closest('[data-action="add-job"]');
    if (addJob) {
      event.preventDefault();
      openAddJob();
      return;
    }

    const trackJob = event.target.closest('[data-track-job]');
    if (trackJob) {
      event.preventDefault();
      trackSearchJob(trackJob.dataset.trackJob);
      return;
    }

    const sendJob = event.target.closest('[data-send-job]');
    if (sendJob) {
      event.preventDefault();
      sendSearchJob(sendJob.dataset.sendJob);
      return;
    }

    const searchExample = event.target.closest('[data-search-role]');
    if (searchExample) {
      event.preventDefault();
      const input = $('#jobSearchRole');
      if (input) input.value = searchExample.dataset.searchRole;
      handleJobSearchSubmit();
      return;
    }

    const retrySearch = event.target.closest('[data-retry-search]');
    if (retrySearch) {
      event.preventDefault();
      handleJobSearchSubmit();
      return;
    }

    const retryDaily = event.target.closest('[data-retry-daily]');
    if (retryDaily) {
      event.preventDefault();
      dailyReadState.status = 'idle';
      dailyReadState.data = null;
      dailyReadState.error = '';
      renderDailyRead();
      return;
    }

    const showAllSearch = event.target.closest('[data-show-all-search]');
    if (showAllSearch) {
      event.preventDefault();
      jobSearch.strict = false;
      const strict = $('#jobSearchStrict');
      if (strict) strict.checked = false;
      renderSearchResults();
      return;
    }

    const loadAiMore = event.target.closest('[data-load-ai-more]');
    if (loadAiMore) {
      event.preventDefault();
      loadMoreAiTraining();
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

    const acceptRequest = event.target.closest('[data-accept-request]');
    if (acceptRequest) {
      event.preventDefault();
      respondToFriendRequest(acceptRequest.dataset.acceptRequest, 'accept');
      return;
    }

    const declineRequest = event.target.closest('[data-decline-request]');
    if (declineRequest) {
      event.preventDefault();
      respondToFriendRequest(declineRequest.dataset.declineRequest, 'decline');
      return;
    }

    const cancelRequest = event.target.closest('[data-cancel-request]');
    if (cancelRequest) {
      event.preventDefault();
      cancelFriendRequest(cancelRequest.dataset.cancelRequest);
      return;
    }

    const removeFriendBtn = event.target.closest('[data-remove-friend]');
    if (removeFriendBtn) {
      event.preventDefault();
      removeFriend(removeFriendBtn.dataset.removeFriend);
      return;
    }

    const sendTo = event.target.closest('[data-send-to]');
    if (sendTo) {
      event.preventDefault();
      openShareModal({ toUserId: sendTo.dataset.sendTo });
      return;
    }

    const shareLink = event.target.closest('[data-share-link]');
    if (shareLink) {
      markShareRead(shareLink.dataset.shareLink);
      return;
    }

    const shareRead = event.target.closest('[data-share-read]');
    if (shareRead) {
      event.preventDefault();
      markShareRead(shareRead.dataset.shareRead);
      return;
    }

    const shareTrack = event.target.closest('[data-share-track]');
    if (shareTrack) {
      event.preventDefault();
      trackSharedJob(shareTrack.dataset.shareTrack);
      return;
    }

    const shareDismiss = event.target.closest('[data-share-dismiss]');
    if (shareDismiss) {
      event.preventDefault();
      dismissShare(shareDismiss.dataset.shareDismiss);
      return;
    }

    const deleteSent = event.target.closest('[data-delete-sent]');
    if (deleteSent) {
      event.preventDefault();
      deleteSentShare(deleteSent.dataset.deleteSent);
      return;
    }

    const shareThread = event.target.closest('[data-share-thread]');
    if (shareThread) {
      event.preventDefault();
      toggleShareThread(shareThread.dataset.shareThread);
      return;
    }

    const shareTabButton = event.target.closest('[data-share-tab]');
    if (shareTabButton) {
      event.preventDefault();
      setShareTab(shareTabButton.dataset.shareTab);
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
      removeEventConfirmed(eventDel.dataset.eventDel);
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
    const scopeMenu = $('#togetherScopeMenu');
    if (scopeMenu) {
      if (event.key === 'Escape' && !scopeMenu.hidden) {
        event.preventDefault();
        setScopeMenuOpen(false);
        const button = $('#togetherScopeBtn');
        if (button) button.focus();
        return;
      }

      const scopeFocused = event.target.closest && (event.target.closest('#togetherScopeBtn') || event.target.closest('#togetherScopeMenu'));
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && scopeFocused) {
        event.preventDefault();
        if (scopeMenu.hidden) {
          renderTogetherScope();
          setScopeMenuOpen(true);
        }
        const options = Array.from(scopeMenu.querySelectorAll('.scope-option'));
        if (!options.length) return;
        const index = options.indexOf(document.activeElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = index === -1
          ? (step === 1 ? 0 : options.length - 1)
          : (index + step + options.length) % options.length;
        options[next].focus();
        return;
      }

      if (event.key === 'Tab' && !scopeMenu.hidden) setScopeMenuOpen(false);
    }

    if (event.key === 'Escape') closeTopModal();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      const input = event.target.closest && event.target.closest('[data-share-reply-input]');
      if (input) {
        event.preventDefault();
        const form = input.closest('[data-share-reply]');
        if (form) submitShareReply(form);
      }
    }
  });

  // Reply drafts live in memory so a silent poll can repaint the thread without
  // wiping what the person is still typing.
  document.addEventListener('input', (event) => {
    const input = event.target.closest && event.target.closest('[data-share-reply-input]');
    if (!input) return;
    shareReplyDrafts.set(input.dataset.shareReplyInput, input.value);
  });

  document.addEventListener('submit', (event) => {
    const shareForm = event.target.closest && event.target.closest('[data-share-reply]');
    if (shareForm) {
      event.preventDefault();
      submitShareReply(shareForm);
      return;
    }

    const taskForm = event.target.closest && event.target.closest('#newTaskForm');
    if (taskForm) {
      event.preventDefault();
      addSpaceTask(event);
      return;
    }

    const projectForm = event.target.closest && event.target.closest('#newProjectForm');
    if (projectForm) {
      event.preventDefault();
      addProject(event);
      return;
    }

    const editProjectForm = event.target.closest && event.target.closest('#projectForm');
    if (editProjectForm) {
      event.preventDefault();
      saveProject(event);
      return;
    }

    const milestoneForm = event.target.closest && event.target.closest('#projectMilestoneForm');
    if (milestoneForm) {
      event.preventDefault();
      addProjectMilestone(event);
      return;
    }

    const listForm = event.target.closest && event.target.closest('#newListForm');
    if (listForm) {
      event.preventDefault();
      addSpaceList(event);
      return;
    }

    const bookForm = event.target.closest && event.target.closest('#newBookForm');
    if (bookForm) {
      event.preventDefault();
      addBook(event);
      return;
    }

    const categoryForm = event.target.closest && event.target.closest('#newShelfCategoryForm');
    if (categoryForm) {
      event.preventDefault();
      addShelfCategory(event);
      return;
    }

    const bookLinkForm = event.target.closest && event.target.closest('[data-book-link-form]');
    if (bookLinkForm) {
      event.preventDefault();
      const input = bookLinkForm.querySelector('[data-book-link-input]');
      saveBookLink(bookLinkForm.dataset.bookLinkForm, input ? input.value : '');
      return;
    }

    const newContactForm = event.target.closest && event.target.closest('#newContactForm');
    if (newContactForm) {
      event.preventDefault();
      addContact(event);
      return;
    }

    const contactForm = event.target.closest && event.target.closest('#contactForm');
    if (contactForm) {
      event.preventDefault();
      saveContact(event);
      return;
    }

    const contactNoteForm = event.target.closest && event.target.closest('#contactNoteForm');
    if (contactNoteForm) {
      event.preventDefault();
      addContactNote(event);
      return;
    }

    const circleForm = event.target.closest && event.target.closest('#circleForm');
    if (circleForm) {
      event.preventDefault();
      handleCreateCircle(event);
      return;
    }

    const circleAdd = event.target.closest && event.target.closest('#circleAddForm');
    if (circleAdd) {
      event.preventDefault();
      addCircleMemberFromForm(event);
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;

    if (target.closest('#contactSearch')) {
      crmSearch = target.value;
      renderContactList();
      return;
    }

    if (target.closest('#contactStageFilter')) {
      crmStageFilter = target.value;
      renderContactList();
      return;
    }

    if (target.closest('#upcomingWindow')) {
      upcomingWindow = UPCOMING_WINDOWS[target.value] ? target.value : '7d';
      localStorage.setItem(STORE.upcomingWindow, upcomingWindow);
      renderUpcoming();
      return;
    }

    if (target.closest('#calScopeFilter')) {
      calendarScope = target.value;
      localStorage.setItem(STORE.calScope, calendarScope);
      renderCalendar();
      return;
    }

    if (target.closest('#shelfCategory')) {
      shelfCategory = target.value;
      renderShelf();
      return;
    }

    const bookCategory = target.closest('[data-book-category]');
    if (bookCategory) {
      saveBookCategory(bookCategory.dataset.bookCategory, bookCategory.value);
      return;
    }

    const bookShelf = target.closest('[data-book-shelf]');
    if (bookShelf) {
      saveBookShelf(bookShelf.dataset.bookShelf, bookShelf.value);
      return;
    }

    const bookPages = target.closest('[data-book-pages]');
    if (bookPages) {
      saveBookPages(bookPages.dataset.bookPages, bookPages.value);
      return;
    }

    const bookRating = target.closest('[data-book-rating]');
    if (bookRating) {
      saveBookRating(bookRating.dataset.bookRating, bookRating.value);
    }

    const taskTitle = target.closest('[data-task-title]');
    if (taskTitle) {
      saveTaskTitle(taskTitle.dataset.taskTitle, taskTitle.value);
      return;
    }

    const taskDue = target.closest('[data-task-due]');
    if (taskDue) {
      saveTaskDue(taskDue.dataset.taskDue, taskDue.value);
      return;
    }

    const taskAssignee = target.closest('[data-task-assignee]');
    if (taskAssignee) {
      saveTaskAssignee(taskAssignee.dataset.taskAssignee, taskAssignee.value);
      return;
    }

    const taskProject = target.closest('[data-task-project]');
    if (taskProject) {
      saveTaskProject(taskProject.dataset.taskProject, taskProject.value);
    }
  });

  const profileForm = $('#profileForm');
  if (profileForm) profileForm.addEventListener('submit', handleProfileSubmit);

  const profileEditBtn = $('#profileEditBtn');
  if (profileEditBtn) profileEditBtn.addEventListener('click', () => enterProfileEdit('name'));

  const profileCancelBtn = $('#profileCancelBtn');
  if (profileCancelBtn) profileCancelBtn.addEventListener('click', () => cancelProfileEdit());

  const dailyPortalSelect = $('#dailyPortalSelect');
  if (dailyPortalSelect) {
    dailyPortalSelect.addEventListener('change', () => {
      state.profile.dailyPortal = normalizePortalChoice(dailyPortalSelect.value);
      saveProfile();
      dailyReadState.key = '';
      if (currentPage === 'dashboard') renderDailyRead();
      renderDailyPortalSetting();
      toast('Daily article portal updated');
    });
  }

  const profileView = $('#profileView');
  if (profileView) {
    profileView.addEventListener('click', (event) => {
      const target = event.target.closest('[data-profile-edit]');
      if (!target) return;
      event.preventDefault();
      enterProfileEdit(target.dataset.profileEdit);
    });
  }

  const photoBtn = $('#profilePhotoBtn');
  const photoInput = $('#profilePhotoFile');
  if (photoBtn && photoInput) {
    photoBtn.addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) handleProfilePhotoFile(file);
      photoInput.value = '';
    });
  }

  const photoRemove = $('#profilePhotoRemove');
  if (photoRemove) photoRemove.addEventListener('click', clearProfilePhoto);

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
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (state.profile.resumeText) {
      const ok = await confirmAction({
        title: 'Clear the pasted resume?',
        message: 'This will not delete the original file.',
        confirmLabel: 'Clear'
      });
      if (!ok) return;
    }
    clearResume();
  });

  const search = $('#searchInput');
  if (search) search.addEventListener('input', renderTracker);
  const filter = $('#statusFilter');
  if (filter) filter.addEventListener('change', renderTracker);

  const jobSearchForm = $('#jobSearchForm');
  if (jobSearchForm) jobSearchForm.addEventListener('submit', handleJobSearchSubmit);

  const jobSearchStrict = $('#jobSearchStrict');
  if (jobSearchStrict) {
    jobSearchStrict.addEventListener('change', () => {
      jobSearch.strict = jobSearchStrict.checked;
      renderSearchResults();
    });
  }

  const jobSearchLocation = $('#jobSearchLocation');
  if (jobSearchLocation) {
    jobSearchLocation.addEventListener('input', () => {
      jobSearch.target = jobSearchLocation.value.trim() || DEFAULT_TARGET;
      updateSearchTargetLabel();
      if (jobSearch.status === 'done') renderSearchResults();
    });
  }

  const addForm = $('#addJobForm');
  if (addForm) addForm.addEventListener('submit', handleAddJobSubmit);

  const questionsForm = $('#questionsForm');
  if (questionsForm) {
    questionsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (questionsResolver) resolveQuestionsResponse('answered');
      else if (verifySession) regenerateFromVerify();
    });
  }

  const questionsWrap = $('#questionsWrap');
  if (questionsWrap) {
    questionsWrap.addEventListener('click', (event) => {
      if (!event.target.closest('[data-close]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (questionsResolver) resolveQuestionsResponse('skipped');
    });
  }

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

  const dashActivityToggle = $('#dashActivityToggle');
  if (dashActivityToggle) {
    dashActivityToggle.addEventListener('change', () => {
      dashActivity = dashActivityToggle.checked;
      saveDashChartPref(STORE.dashActivity, dashActivity);
      if (currentPage === 'dashboard') renderDashboard();
      toast(dashActivity ? 'Activity chart shown' : 'Activity chart hidden');
    });
  }

  const dashStatusToggle = $('#dashStatusToggle');
  if (dashStatusToggle) {
    dashStatusToggle.addEventListener('change', () => {
      dashStatus = dashStatusToggle.checked;
      saveDashChartPref(STORE.dashStatus, dashStatus);
      if (currentPage === 'dashboard') renderDashboard();
      toast(dashStatus ? 'Status breakdown shown' : 'Status breakdown hidden');
    });
  }

  const confirmCancelBtn = $('#confirmCancelBtn');
  if (confirmCancelBtn) {
    confirmCancelBtn.addEventListener('click', () => {
      settleConfirm(false);
      closeModal($('#confirmModal'));
    });
  }

  const confirmAcceptBtn = $('#confirmAcceptBtn');
  if (confirmAcceptBtn) {
    confirmAcceptBtn.addEventListener('click', () => {
      settleConfirm(true);
      closeModal($('#confirmModal'));
    });
  }

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

  const signInBtn = $('#accountSignInBtn');
  if (signInBtn) signInBtn.addEventListener('click', handleCloudSignIn);

  const signUpBtn = $('#accountSignUpBtn');
  if (signUpBtn) signUpBtn.addEventListener('click', handleCloudSignUp);

  const signOutBtn = $('#accountSignOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', handleCloudSignOut);

  const syncNowBtn = $('#accountSyncBtn');
  if (syncNowBtn) syncNowBtn.addEventListener('click', handleCloudSyncNow);

  const accountPassword = $('#accountPassword');
  if (accountPassword) {
    accountPassword.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handleCloudSignIn();
    });
  }

  const friendForm = $('#friendRequestForm');
  if (friendForm) friendForm.addEventListener('submit', handleFriendRequest);

  const shareForm = $('#shareJobForm');
  if (shareForm) shareForm.addEventListener('submit', handleShareJobSubmit);

  const friendsRefresh = $('#friendsRefreshBtn');
  if (friendsRefresh) friendsRefresh.addEventListener('click', () => loadSocial());

  const friendsSend = $('#friendsSendBtn');
  if (friendsSend) friendsSend.addEventListener('click', () => openShareModal());

  const togetherRefresh = $('#togetherRefreshBtn');
  if (togetherRefresh) togetherRefresh.addEventListener('click', () => {
    loadSpace();
    loadSocial();
  });

  const newCircle = $('#newCircleBtn');
  if (newCircle) newCircle.addEventListener('click', () => {
    const form = $('#circleForm');
    if (form) form.reset();
    openModal($('#circleModal'));
    const input = $('#circleName');
    if (input) setTimeout(() => input.focus(), 60);
  });

  const shareApp = $('#shareAppBtn');
  if (shareApp) shareApp.addEventListener('click', shareCurrentApplication);

  const resetBtn = $('#resetBtn');
  if (resetBtn) resetBtn.addEventListener('click', resetAll);
}

// ---------------------------------------------------------------- Init

function init() {
  applyProfileToForm();
  bindEvents();
  showPage('dashboard');
  startReminders();

  window.__knomadReady = true;
  const bootError = document.getElementById('appBootError');
  if (bootError) bootError.hidden = true;

  restoreCloudSession();

  window.addEventListener('online', () => {
    if (cloudReady()) {
      flushCloudQueue();
      pullCloudDocs(false);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && cloudReady()) {
      pullCloudDocs(false);
      loadSocial({ silent: true });
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
