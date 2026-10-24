const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
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
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
