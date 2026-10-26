const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

async function findFreePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function sessionCookie(response) {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('edusmart.sid='));
  assert.ok(cookie, 'Expected the login response to set a session cookie');
  return cookie.split(';', 1)[0];
}

async function api(baseUrl, endpoint, { method = 'GET', body, cookie } = {}) {
  const headers = { Origin: baseUrl };
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json() };
}

test('new registration creates an admin notification that can be read', { timeout: 30000 }, async () => {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edusmart-notification-'));
  const adminEmail = 'admin@edusmart-test.example.com';
  const adminPassword = `Admin-${crypto.randomBytes(18).toString('hex')}-7A`;
  const studentEmail = `student-${crypto.randomUUID()}@edusmart-test.example.com`;
  const child = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      DATA_DIR: dataDir,
      SESSION_SECRET: crypto.randomBytes(40).toString('hex'),
      SEED_ADMIN_EMAIL: adminEmail,
      SEED_ADMIN_PASSWORD: adminPassword,
      BCRYPT_COST: '4',
      AUTO_ACTIVATE_ACCOUNTS: 'false',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: ''
    },
    stdio: 'ignore'
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
      try {
        ready = (await fetch(`${baseUrl}/api/health`)).ok;
      } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Server should start before the smoke-test timeout');

    let result = await api(baseUrl, '/api/auth/login', {
      method: 'POST', body: { email: adminEmail, password: adminPassword }
    });
    assert.equal(result.response.status, 200);
    const adminCookie = sessionCookie(result.response);

    result = await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Pendaftar Uji',
        email: studentEmail,
        password: 'Sekolah123',
        role: 'SISWA',
        identityNumber: `NIS-${crypto.randomUUID().slice(0, 12)}`,
        detail: 'X IPA 2'
      }
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));

    result = await api(baseUrl, '/api/notifications', { cookie: adminCookie });
    assert.equal(result.response.status, 200);
    const registrationNotification = result.data.notifications.find(notification => notification.title === 'Pendaftaran akun baru');
    assert.ok(registrationNotification);
    assert.match(registrationNotification.message, /Pendaftar Uji/);
    assert.equal(registrationNotification.isRead, 0);

    result = await api(baseUrl, '/api/notifications/read-all', { method: 'PATCH', body: {}, cookie: adminCookie });
    assert.equal(result.response.status, 200);
    result = await api(baseUrl, '/api/notifications', { cookie: adminCookie });
    assert.equal(result.data.notifications.find(notification => notification.id === registrationNotification.id).isRead, 1);

    result = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: studentEmail, password: 'Sekolah123' } });
    assert.equal(result.response.status, 403, 'The account should remain pending until admin approval');
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('accounts auto-activate by default', { timeout: 30000 }, async () => {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edusmart-auto-activate-'));
  const adminEmail = 'admin-auto@edusmart-test.example.com';
  const adminPassword = `Admin-${crypto.randomBytes(18).toString('hex')}-7A`;
  const studentEmail = `student-${crypto.randomUUID()}@edusmart-test.example.com`;
  const child = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      DATA_DIR: dataDir,
      SESSION_SECRET: crypto.randomBytes(40).toString('hex'),
      SEED_ADMIN_EMAIL: adminEmail,
      SEED_ADMIN_PASSWORD: adminPassword,
      BCRYPT_COST: '4',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: ''
    },
    stdio: 'ignore'
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
      try { ready = (await fetch(`${baseUrl}/api/health`)).ok; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Server should start before the smoke-test timeout');

    const result = await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Pendaftar Otomatis',
        email: studentEmail,
        password: 'Sekolah123',
        role: 'SISWA',
        identityNumber: `NIS-${crypto.randomUUID().slice(0, 12)}`,
        detail: 'X IPA 2'
      }
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.data.autoActivated, true);
    assert.match(result.data.message, /sudah aktif/);

    const login = await api(baseUrl, '/api/auth/login', {
      method: 'POST', body: { email: studentEmail, password: 'Sekolah123' }
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.user.status, 'AKTIF');
    const studentCookie = sessionCookie(login.response);

    const secondStudentEmail = `student-${crypto.randomUUID()}@edusmart-test.example.com`;
    const secondRegistration = await api(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Pendaftar Kedua',
        email: secondStudentEmail,
        password: 'Sekolah123',
        role: 'SISWA',
        identityNumber: `NIS-${crypto.randomUUID().slice(0, 12)}`,
        detail: 'X IPA 2'
      }
    });
    assert.equal(secondRegistration.response.status, 201);
    const scoreDb = new BetterSqlite3(path.join(dataDir, 'edusmart.sqlite'));
    const adminId = scoreDb.prepare('SELECT id FROM users WHERE email=?').get(adminEmail).id;
    const secondStudentId = scoreDb.prepare('SELECT id FROM users WHERE email=?').get(secondStudentEmail).id;
    const assignmentOne = crypto.randomUUID(), assignmentTwo = crypto.randomUUID();
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    const insertAssignment = scoreDb.prepare('INSERT INTO assignments (id,title,instructions,subject,class_name,due_at,max_score,created_by) VALUES (?,?,?,?,?,?,?,?)');
    insertAssignment.run(assignmentOne, 'Tes Nilai Satu', 'Instruksi tes satu.', 'Matematika', 'X IPA 2', dueAt, 100, adminId);
    insertAssignment.run(assignmentTwo, 'Tes Nilai Dua', 'Instruksi tes dua.', 'Matematika', 'X IPA 2', dueAt, 200, adminId);
    const insertSubmission = scoreDb.prepare('INSERT INTO submissions (id,assignment_id,student_id,score) VALUES (?,?,?,?)');
    insertSubmission.run(crypto.randomUUID(), assignmentOne, login.data.user.id, 80);
    insertSubmission.run(crypto.randomUUID(), assignmentTwo, login.data.user.id, 160);
    insertSubmission.run(crypto.randomUUID(), assignmentOne, secondStudentId, 90);
    insertSubmission.run(crypto.randomUUID(), assignmentTwo, secondStudentId, 180);
    scoreDb.close();

    const ownMetrics = await api(baseUrl, `/api/search/${login.data.user.id}/profile`, { cookie: studentCookie });
    assert.equal(ownMetrics.data.averageScore, 80);
    assert.equal(ownMetrics.data.rank, 2);
    assert.equal(ownMetrics.data.approvedAttendance, 0);

    const secondLogin = await api(baseUrl, '/api/auth/login', {
      method: 'POST', body: { email: secondStudentEmail, password: 'Sekolah123' }
    });
    const secondStudentCookie = sessionCookie(secondLogin.response);
    const privateMetrics = await api(baseUrl, `/api/search/${login.data.user.id}/profile`, { cookie: secondStudentCookie });
    assert.equal(privateMetrics.data.canSeeAcademicMetrics, false);
    assert.equal(privateMetrics.data.averageScore, null);
    assert.equal(privateMetrics.data.rank, null);
    assert.equal(privateMetrics.data.approvedAttendance, null);

    const profile = await api(baseUrl, '/api/profile/me', { cookie: studentCookie });
    assert.equal(profile.data.user.name, 'Pendaftar Otomatis');
    assert.equal(profile.data.user.detail, 'X IPA 2');

    const savedBio = await api(baseUrl, '/api/profile/me', {
      method: 'PUT', body: { bio: 'Senang belajar bersama.' }, cookie: studentCookie
    });
    assert.equal(savedBio.response.status, 200);
    const profileAfterEdit = await api(baseUrl, '/api/profile/me', { cookie: studentCookie });
    assert.equal(profileAfterEdit.data.user.bio, 'Senang belajar bersama.');

    const search = await api(baseUrl, '/api/search?q=Pendaftar%20Otomatis', { cookie: studentCookie });
    assert.equal(search.response.status, 200);
    assert.ok(search.data.people.some(person => person.email === undefined && person.name === 'Pendaftar Otomatis'));
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
