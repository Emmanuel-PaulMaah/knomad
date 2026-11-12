import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyEligibility,
  clearJobSearchCache,
  descriptionLocationHint,
  matchJobs,
  normalizeProviderJobs,
  resolveTarget,
  roleMatchScore,
  roleTokens,
  searchJobs,
  sortJobs
} from '../job-search.js';

test('resolveTarget understands the default and nearby markets', () => {
  assert.deepEqual(resolveTarget('Nigeria'), { country: 'nigeria', label: 'Nigeria', africa: true });
  assert.deepEqual(resolveTarget('Lagos'), { country: 'nigeria', label: 'Nigeria', africa: true });
  assert.equal(resolveTarget('Kenya').country, 'kenya');
  assert.equal(resolveTarget('Somewhere else').country, 'somewhere else');
});

test('locations that include Nigerians are eligible', () => {
  const cases = [
    ['Worldwide', 'worldwide'],
    ['Anywhere', 'worldwide'],
    ['Anywhere in the World', 'worldwide'],
    ['Global', 'worldwide'],
    ['Africa', 'region'],
    ['Africa, Europe', 'region'],
    ['Nigeria', 'country'],
    ['Lagos, Nigeria', 'country'],
    ['USA, Canada, Nigeria', 'country'],
    ['Remote (Worldwide)', 'worldwide']
  ];

  cases.forEach(([location, eligibility]) => {
    const result = classifyEligibility(location, 'Nigeria');
    assert.equal(result.eligible, true, location + ' should be eligible');
    assert.equal(result.eligibility, eligibility, location);
  });
});

test('locations restricted to other regions are not eligible', () => {
  [
    'USA',
    'USA only',
    'Canada, USA',
    'Europe',
    'Europe, USA, Canada, Australia',
    'LATAM',
    'APAC',
    'South Africa',
    'UK',
    'Germany',
    'USA timezones'
  ].forEach((location) => {
    const result = classifyEligibility(location, 'Nigeria');
    assert.equal(result.eligible, false, location + ' should not be eligible');
    assert.equal(result.eligibility, 'restricted', location);
  });
});

test('blank or vague locations are not claimed as eligible', () => {
  assert.equal(classifyEligibility('', 'Nigeria').eligibility, 'unknown');
  assert.equal(classifyEligibility('Remote', 'Nigeria').eligibility, 'unknown');
  assert.equal(classifyEligibility('Remote', 'Nigeria').eligible, false);
  assert.equal(classifyEligibility('EMEA', 'Nigeria').eligibility, 'maybe');
  assert.equal(classifyEligibility('EMEA', 'Nigeria').eligible, false);
});

test('role tokens drop arrangement and seniority words', () => {
  assert.deepEqual(roleTokens('Senior Frontend Developer (Remote)'), ['frontend', 'developer']);
  assert.deepEqual(roleTokens('registered nurse'), ['nurse']);
  assert.deepEqual(roleTokens('remote jobs'), []);
});

test('role matching handles title synonyms without AI', () => {
  const tokens = roleTokens('frontend developer');
  const score = roleMatchScore({
    title: 'Front End Engineer',
    tags: ['react'],
    category: '',
    level: 'Senior'
  }, tokens);
  assert.equal(score, 1);

  const mismatched = roleMatchScore({
    title: 'Data Engineer',
    tags: ['python'],
    category: '',
    level: ''
  }, roleTokens('data analyst'));
  assert.ok(mismatched < 0.6);

  assert.equal(roleMatchScore({ title: 'Registered Nurse' }, roleTokens('nurse')), 1);
  assert.equal(roleMatchScore({ title: 'Senior Product Manager' }, roleTokens('product manager')), 1);
});

test('matchJobs keeps relevant titles and drops loose provider matches', () => {
  const jobs = [
    { title: 'Frontend Developer', tags: [] },
    { title: 'Platform Engineering', tags: [] },
    { title: 'Front End Engineer', tags: [] },
    { title: 'Registered Nurse', tags: [] }
  ];
  const matched = matchJobs(jobs, 'frontend developer').map((job) => job.title);
  assert.deepEqual(matched, ['Frontend Developer', 'Front End Engineer']);
});

test('description hints surface explicit remote restrictions', () => {
  const hint = descriptionLocationHint(
    'About us. REMOTE: United States, Canada, or South America ONLY. Apply today.'
  );
  assert.match(hint, /United States/i);
  assert.equal(classifyEligibility(hint, 'Nigeria').eligible, false);

  assert.equal(descriptionLocationHint('We are a remote-first team based in New York.'), '');
  assert.equal(descriptionLocationHint('Remote: anywhere in the world'), 'Remote: anywhere in the world');
});

test('provider adapters normalize the fields the UI needs', () => {
  const jobicy = normalizeProviderJobs('jobicy', {
    jobs: [{
      id: 42,
      jobTitle: 'Frontend Developer',
      companyName: 'Acme',
      jobGeo: 'Anywhere',
      url: 'https://jobicy.com/jobs/42',
      pubDate: '2026-11-10T10:00:00+00:00',
      jobType: ['Full-Time'],
      jobIndustry: ['Software Engineering'],
      jobLevel: 'Senior',
      jobDescription: '<p>Build <strong>things</strong>.</p>',
      salaryMin: 50000,
      salaryMax: 70000,
      salaryCurrency: 'USD',
      salaryPeriod: 'yearly'
    }]
  });
  assert.equal(jobicy.length, 1);
  assert.equal(jobicy[0].provider, 'Jobicy');
  assert.equal(jobicy[0].title, 'Frontend Developer');
  assert.equal(jobicy[0].location, 'Anywhere');
  assert.match(jobicy[0].description, /Build things/);
  assert.match(jobicy[0].salary, /50,000/);

  const remotive = normalizeProviderJobs('remotive', {
    jobs: [{
      id: 7,
      title: 'Product Manager',
      company_name: 'Beta',
      candidate_required_location: 'Worldwide',
      url: 'https://remotive.com/jobs/7',
      publication_date: '2026-11-09T10:00:00',
      job_type: 'full_time',
      category: 'Product',
      tags: ['product'],
      description: '<p>Own the roadmap.</p>'
    }]
  });
  assert.equal(remotive[0].location, 'Worldwide');
  assert.equal(remotive[0].type, 'Full-Time');

  const remoteok = normalizeProviderJobs('remoteok', [
    { legal: 'notice' },
    {
      id: '99',
      position: 'Backend Engineer',
      company: 'Gamma',
      location: '',
      url: 'https://remoteok.com/jobs/99',
      date: '2026-11-08T10:00:00+00:00',
      tags: ['python'],
      description: 'Remote: Africa only. Build APIs. Please mention the word TOKEN when applying.'
    }
  ]);
  assert.equal(remoteok.length, 1);
  assert.equal(remoteok[0].location, 'Remote: Africa only');
  assert.doesNotMatch(remoteok[0].description, /mention the word/i);
  assert.equal(classifyEligibility(remoteok[0].location, 'Nigeria').eligible, true);
});

test('blank provider locations fall back to a stated description hint', () => {
  const jobicy = normalizeProviderJobs('jobicy', {
    jobs: [{
      id: 5,
      jobTitle: 'Support Engineer',
      companyName: 'Acme',
      jobGeo: '',
      url: 'https://jobicy.com/jobs/5',
      jobDescription: '<p>Remote: anywhere in the world. Help customers.</p>'
    }]
  });
  assert.equal(jobicy[0].location, 'Remote: anywhere in the world');
  assert.equal(classifyEligibility(jobicy[0].location, 'Nigeria').eligible, true);

  const remotive = normalizeProviderJobs('remotive', {
    jobs: [{
      id: 6,
      title: 'Data Analyst',
      company_name: 'Beta',
      candidate_required_location: 'Remote',
      url: 'https://remotive.com/jobs/6',
      description: '<p>Location: Africa and Europe.</p>'
    }]
  });
  assert.equal(remotive[0].location, 'Location: Africa and Europe');
  assert.equal(classifyEligibility(remotive[0].location, 'Nigeria').eligible, true);
});

test('jobicy searches the worldwide-only feed and merges duplicates', async () => {
  clearJobSearchCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('jobicy.com')) {
      const worldwide = url.includes('geo=anywhere');
      const jobs = worldwide
        ? [
            { id: 1, jobTitle: 'Frontend Developer', jobGeo: 'Anywhere', url: 'https://jobicy.com/jobs/1', jobDescription: '<p>React</p>' },
            { id: 2, jobTitle: 'Front End Engineer', jobGeo: 'Anywhere', url: 'https://jobicy.com/jobs/2', jobDescription: '<p>Vue</p>' }
          ]
        : [
            { id: 1, jobTitle: 'Frontend Developer', jobGeo: 'USA', url: 'https://jobicy.com/jobs/1', jobDescription: '<p>React</p>' }
          ];
      return { ok: true, json: async () => ({ jobs }) };
    }
    if (url.includes('remoteok.com')) return { ok: true, json: async () => [{ legal: 'notice' }] };
    return { ok: true, json: async () => ({ jobs: [] }) };
  };

  const result = await searchJobs('frontend developer', { target: 'Nigeria', fetchImpl });

  assert.ok(urls.some((url) => /[?&]geo=anywhere/.test(url)));
  assert.equal(result.jobs.length, 2);
  assert.ok(result.jobs.every((job) => job.eligibility.eligible));
  assert.equal(result.jobs.find((job) => job.id === 'jobicy-1').location, 'Anywhere');
});

test('sortJobs puts eligible roles first', () => {
  const sorted = sortJobs([
    { title: 'A', eligibility: { eligibility: 'restricted' }, matchScore: 1, postedAt: '' },
    { title: 'B', eligibility: { eligibility: 'worldwide' }, matchScore: 0.7, postedAt: '' },
    { title: 'C', eligibility: { eligibility: 'country' }, matchScore: 0.8, postedAt: '' }
  ]).map((job) => job.title);
  assert.deepEqual(sorted, ['B', 'C', 'A']);
});

test('searchJobs keeps working when one provider fails', async () => {
  clearJobSearchCache();
  const responses = {
    'jobicy.com': {
      jobs: [{
        id: 1,
        jobTitle: 'Frontend Developer',
        companyName: 'Acme',
        jobGeo: 'Anywhere',
        url: 'https://jobicy.com/jobs/1',
        pubDate: '2026-11-10T10:00:00+00:00',
        jobType: ['Full-Time'],
        jobIndustry: ['Software Engineering'],
        jobDescription: '<p>React</p>'
      }]
    },
    'remoteok.com': [
      { legal: 'notice' },
      {
        id: '2',
        position: 'Front End Engineer',
        company: 'Beta',
        location: 'Worldwide',
        url: 'https://remoteok.com/jobs/2',
        date: '2026-11-09T10:00:00+00:00',
        tags: ['react'],
        description: 'Build UI'
      }
    ]
  };

  const fakeFetch = async (url) => {
    if (url.includes('remotive.com')) throw new Error('offline');
    const key = Object.keys(responses).find((host) => url.includes(host));
    return { ok: true, json: async () => responses[key] };
  };

  const result = await searchJobs('frontend developer', {
    target: 'Nigeria',
    fetchImpl: fakeFetch
  });

  assert.equal(result.jobs.length, 2);
  assert.equal(result.providers.find((provider) => provider.id === 'remotive').status, 'error');
  assert.equal(result.providers.find((provider) => provider.id === 'jobicy').count, 1);
  assert.ok(result.jobs.every((job) => job.eligibility.eligible));
});
