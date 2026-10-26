require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const BetterSqlite3 = require('better-sqlite3');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const { z } = require('zod');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const publicDir = path.join(__dirname, 'public');
const photoDir = path.join(dataDir, 'attendance-photos');
const isProduction = process.env.NODE_ENV === 'production';
const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const autoActivateAccounts = process.env.AUTO_ACTIVATE_ACCOUNTS !== 'false';
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });

if (isProduction) {
	const appUrl = process.env.APP_URL ? new URL(process.env.APP_URL) : null;
	if (!appUrl || appUrl.protocol !== 'https:' || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
		throw new Error('Production requires an HTTPS APP_URL and SESSION_SECRET with at least 32 characters.');
	}
	if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
		throw new Error('Production requires Google OAuth credentials because Google login is part of the configured sign-in flow.');
	}
	if (!process.env.SEED_ADMIN_EMAIL || !process.env.SEED_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD.length < 12) {
		throw new Error('Production requires a unique initial admin email and password of at least 12 characters.');
	}
}

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(photoDir, { recursive: true });
const rawDb = new BetterSqlite3(path.join(dataDir, 'edusmart.sqlite'));
rawDb.pragma('journal_mode = WAL');
rawDb.pragma('foreign_keys = ON');

class SqliteSessionStore extends session.Store {
	constructor() {
		super();
		rawDb.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL)');
		this.getStatement = rawDb.prepare('SELECT sess,expire FROM sessions WHERE sid=?');
		this.setStatement = rawDb.prepare('INSERT INTO sessions (sid,sess,expire) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expire=excluded.expire');
		this.deleteStatement = rawDb.prepare('DELETE FROM sessions WHERE sid=?');
	}
	get(sid, callback) {
		try {
			const row = this.getStatement.get(sid);
			if (!row) return callback(null, null);
			if (row.expire <= Date.now()) {
				this.deleteStatement.run(sid);
				return callback(null, null);
			}
			callback(null, JSON.parse(row.sess));
		} catch (error) { callback(error); }
	}
	set(sid, value, callback = () => {}) {
		try {
			const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
			this.setStatement.run(sid, JSON.stringify(value), expiresAt);
			callback(null);
		} catch (error) { callback(error); }
	}
	destroy(sid, callback = () => {}) {
		try { this.deleteStatement.run(sid); callback(null); } catch (error) { callback(error); }
	}
	touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }
}

app.disable('x-powered-by');
app.set('trust proxy', isProduction ? 1 : false);
app.use(helmet({
	contentSecurityPolicy: {
		directives: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'"],
			styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
			fontSrc: ["'self'", 'https://fonts.gstatic.com'],
			imgSrc: ["'self'", 'data:', 'blob:'],
			connectSrc: ["'self'", 'https://accounts.google.com'],
			objectSrc: ["'none'"],
			frameAncestors: ["'none'"]
		}
	},
	crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(session({
	name: 'edusmart.sid',
	secret: process.env.SESSION_SECRET || 'development-only-change-before-deploy-please',
	store: new SqliteSessionStore(),
	resave: false,
	saveUninitialized: false,
	cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const databasePromise = Promise.resolve({
	exec: async sql => rawDb.exec(sql),
	get: async (sql, ...params) => rawDb.prepare(sql).get(...params),
	all: async (sql, ...params) => rawDb.prepare(sql).all(...params),
	run: async (sql, ...params) => {
		const result = rawDb.prepare(sql).run(...params);
		return { changes: result.changes, lastID: result.lastInsertRowid };
	}
}).then(async db => {
	await db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
			password_hash TEXT, role TEXT NOT NULL CHECK(role IN ('SISWA','GURU','STAF','ADMIN')),
			identity_number TEXT NOT NULL UNIQUE, detail TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', google_id TEXT UNIQUE,
			status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','AKTIF','NONAKTIF')),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS users_status_role ON users(status, role);
		CREATE TABLE IF NOT EXISTS school_settings (
			id INTEGER PRIMARY KEY CHECK(id = 1), latitude REAL NOT NULL, longitude REAL NOT NULL,
			radius_meters INTEGER NOT NULL, open_time TEXT NOT NULL, close_time TEXT NOT NULL,
			late_after TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS posts (
			id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
			body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS post_likes (
			post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			PRIMARY KEY(post_id, user_id)
		);
		CREATE TABLE IF NOT EXISTS comments (
			id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
			author_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL,
			is_anonymous INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS assignments (
			id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL,
			subject TEXT NOT NULL, class_name TEXT NOT NULL, due_at TEXT NOT NULL,
			max_score REAL NOT NULL DEFAULT 100, created_by TEXT NOT NULL REFERENCES users(id),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS submissions (
			id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
			student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			answer_text TEXT NOT NULL DEFAULT '', score REAL CHECK(score IS NULL OR score >= 0),
			feedback TEXT NOT NULL DEFAULT '', submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(assignment_id,student_id)
		);
		CREATE TABLE IF NOT EXISTS attendance (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL,
			photo_name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
			accuracy REAL NOT NULL, captured_at TEXT NOT NULL,
			verification TEXT NOT NULL DEFAULT 'MENUNGGU', UNIQUE(user_id, day)
		);
		CREATE TABLE IF NOT EXISTS notifications (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
			title TEXT NOT NULL, message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		INSERT OR IGNORE INTO school_settings (id, latitude, longitude, radius_meters, open_time, close_time, late_after)
		VALUES (1, -6.2, 106.816666, 100, '06:30', '10:00', '07:15');
	`);
	const notificationColumns = await db.all('PRAGMA table_info(notifications)');
	if (!notificationColumns.some(column => column.name === 'is_read')) {
		await db.exec('ALTER TABLE notifications ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0');
	}
	const userColumns = await db.all('PRAGMA table_info(users)');
	if (!userColumns.some(column => column.name === 'bio')) {
		await db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
	}
	if (autoActivateAccounts) await db.run("UPDATE users SET status='AKTIF' WHERE status='PENDING'");
	return db;
}).catch(error => {
	console.error('Database gagal disiapkan:', error.message);
	throw error;
});

const registerSchema = z.object({
	name: z.string().trim().min(2).max(120),
	email: z.string().trim().email().max(120),
	password: z.string().min(8).max(128).regex(/[A-Za-z]/).regex(/[0-9]/),
	role: z.enum(['SISWA', 'GURU', 'STAF']),
	identityNumber: z.string().trim().min(3).max(30),
	detail: z.string().trim().min(2).max(80)
});
const loginSchema = z.object({ email: z.string().trim().email().max(120), password: z.string().min(1).max(128) });
const googleIntentSchema = registerSchema.omit({ password: true });
const accountStatusSchema = z.object({ status: z.enum(['AKTIF', 'NONAKTIF']) });
const postSchema = z.object({ title: z.string().trim().min(5).max(120), body: z.string().trim().min(10).max(2000) });
const commentSchema = z.object({ body: z.string().trim().min(1).max(500) });
const assignmentSchema = z.object({ title: z.string().trim().min(3).max(150), instructions: z.string().trim().min(5).max(5000), subject: z.string().trim().min(2).max(80), className: z.string().trim().min(2).max(60), dueAt: z.string().datetime(), maxScore: z.number().min(1).max(1000).default(100) });
const settingsSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radiusMeters: z.number().int().min(30).max(500), openTime: z.string().regex(/^\d{2}:\d{2}$/), closeTime: z.string().regex(/^\d{2}:\d{2}$/), lateAfter: z.string().regex(/^\d{2}:\d{2}$/) });
const attendanceDecisionSchema = z.object({ verification: z.enum(['DISETUJUI', 'DITOLAK']) });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });

function sameOrigin(req, res, next) {
	const origin = req.get('origin');
	if (!origin) return res.status(403).json({ error: 'Header Origin wajib untuk permintaan ini.' });
	try {
		const expectedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : `${req.protocol}://${req.get('host')}`;
		if (new URL(origin).origin !== expectedOrigin) return res.status(403).json({ error: 'Permintaan lintas situs ditolak.' });
	} catch {
		return res.status(403).json({ error: 'Origin tidak valid.' });
	}
	if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Permintaan lintas situs ditolak.' });
	next();
}

function publicUser(user) {
	return { id: user.id, name: user.full_name, email: user.email, role: user.role.toLowerCase(), status: user.status, detail: user.detail };
}

async function notifyAllAdmins(db, title, message) {
	const admins = await db.all("SELECT id FROM users WHERE role='ADMIN' AND status='AKTIF'");
	for (const admin of admins) {
		await db.run('INSERT INTO notifications (id,user_id,title,message) VALUES (?,?,?,?)', crypto.randomUUID(), admin.id, title, message);
	}
}

function haversineMeters(latitude1, longitude1, latitude2, longitude2) {
	const radians = value => value * Math.PI / 180;
	const latDelta = radians(latitude2 - latitude1);
	const lonDelta = radians(longitude2 - longitude1);
	const value = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(lonDelta / 2) ** 2;
	return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function getImageExtension(buffer, mimeType) {
	if (mimeType === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
	if (mimeType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
	if (mimeType === 'image/webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
	return null;
}

function configureGoogle() {
	if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return;
	passport.use(new GoogleStrategy({
		clientID: process.env.GOOGLE_CLIENT_ID,
		clientSecret: process.env.GOOGLE_CLIENT_SECRET,
		callbackURL: `${process.env.APP_URL || `http://localhost:${PORT}`}/auth/google/callback`,
		passReqToCallback: true
	}, async (req, accessToken, refreshToken, profile, done) => {
		try {
			const db = await databasePromise;
			const email = profile.emails?.[0]?.value?.trim().toLowerCase();
			if (!email || profile._json?.email_verified !== true) return done(null, false);
			let user = await db.get('SELECT * FROM users WHERE google_id = ? OR email = ? COLLATE NOCASE', profile.id, email);
			if (!user && req.session.googleRegistration) {
				const intent = req.session.googleRegistration;
				if (intent.email !== email) return done(null, false);
				const id = crypto.randomUUID();
				const status = autoActivateAccounts ? 'AKTIF' : 'PENDING';
				await db.run('INSERT INTO users (id, full_name, email, role, identity_number, detail, google_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, intent.name, email, intent.role, intent.identityNumber, intent.detail, profile.id, status);
				user = await db.get('SELECT * FROM users WHERE id = ?', id);
				await notifyAllAdmins(db, 'Pendaftaran akun baru', `${intent.name} (${intent.role}) mendaftar dengan Google${autoActivateAccounts ? ' dan sudah aktif otomatis.' : ' dan menunggu aktivasi.'}`);
			} else if (user && !user.google_id) {
				await db.run('UPDATE users SET google_id = ? WHERE id = ?', profile.id, user.id);
				user.google_id = profile.id;
			} else if (user && user.google_id !== profile.id) {
				return done(null, false);
			}
			if (!user) return done(null, false);
			req.session.googleRegistration = null;
			done(null, user);
		} catch (error) {
			done(error);
		}
	}));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
	try {
		const db = await databasePromise;
		done(null, await db.get('SELECT * FROM users WHERE id = ?', id) || false);
	} catch (error) {
		done(error);
	}
});
configureGoogle();
app.use(passport.initialize());
app.use(passport.session());

function requireActiveUser(req, res, next) {
	if (!req.isAuthenticated?.() || req.user?.status !== 'AKTIF') return res.status(401).json({ error: 'Silakan masuk dengan akun yang sudah aktif.' });
	next();
}

function requireAdmin(req, res, next) {
	if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Akses khusus admin.' });
	next();
}

function safeLogin(req, user) {
	return new Promise((resolve, reject) => req.logIn(user, error => error ? reject(error) : resolve()));
}

app.get('/api/health', (_, res) => res.json({ ok: true, app: 'EduSmart', googleLoginEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) }));
app.get('/api/auth/session', (req, res) => {
	if (req.isAuthenticated?.() && req.user.status === 'AKTIF') return res.json({ user: publicUser(req.user), googleLoginEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
	res.json({ user: null, googleLoginEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
});

app.post('/api/auth/register', sameOrigin, authLimiter, async (req, res, next) => {
	const parsed = registerSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Periksa data dan gunakan password minimal 8 karakter, berisi huruf serta angka.' });
	try {
		const data = parsed.data, db = await databasePromise;
		const hash = await bcrypt.hash(data.password, Number(process.env.BCRYPT_COST || 12));
		const id = crypto.randomUUID();
		const status = autoActivateAccounts ? 'AKTIF' : 'PENDING';
		await db.run('INSERT INTO users (id, full_name, email, password_hash, role, identity_number, detail, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, data.name, data.email.toLowerCase(), hash, data.role, data.identityNumber, data.detail, status);
		await notifyAllAdmins(db, 'Pendaftaran akun baru', `${data.name} (${data.role})${autoActivateAccounts ? ' sudah aktif otomatis.' : ' menunggu aktivasi admin.'}`);
		res.status(201).json({ autoActivated: autoActivateAccounts, message: autoActivateAccounts ? 'Pendaftaran berhasil. Akun Anda sudah aktif, silakan masuk.' : 'Pendaftaran berhasil. Akun menunggu aktivasi admin sekolah.' });
	} catch (error) {
		if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Email atau nomor induk sudah digunakan.' });
		next(error);
	}
});

app.post('/api/auth/login', sameOrigin, loginLimiter, async (req, res, next) => {
	const parsed = loginSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Email atau kata sandi tidak valid.' });
	try {
		const db = await databasePromise;
		const user = await db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', parsed.data.email);
		const matches = user?.password_hash ? await bcrypt.compare(parsed.data.password, user.password_hash) : false;
		if (!user || !matches) return res.status(401).json({ error: 'Email atau kata sandi salah.' });
		if (user.status !== 'AKTIF') return res.status(403).json({ error: 'Akun menunggu aktivasi admin atau telah dinonaktifkan.' });
		await safeLogin(req, user);
		res.json({ user: publicUser(user) });
	} catch (error) {
		next(error);
	}
});

app.post('/api/auth/logout', sameOrigin, (req, res, next) => {
	req.logout(error => {
		if (error) return next(error);
		req.session.destroy(sessionError => {
			if (sessionError) return next(sessionError);
			res.clearCookie('edusmart.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
			res.json({ ok: true });
		});
	});
});

app.post('/api/auth/google-intent', sameOrigin, authLimiter, (req, res) => {
	if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).json({ error: 'Login Google belum dikonfigurasi oleh pengelola sekolah.' });
	const parsed = googleIntentSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Lengkapi data pendaftaran sebelum melanjutkan ke Google.' });
	req.session.googleRegistration = { ...parsed.data, email: parsed.data.email.toLowerCase() };
	res.json({ url: '/auth/google' });
});

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
	app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'], state: true }));
	app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?auth=google-failed' }), (req, res) => {
		if (req.user.status !== 'AKTIF') return req.logout(() => res.redirect('/?auth=pending'));
		res.redirect('/');
	});
}

app.get('/api/admin/accounts', requireActiveUser, requireAdmin, async (_, res, next) => {
	try {
		const db = await databasePromise;
		const accounts = await db.all('SELECT id, full_name AS name, email, role, identity_number AS identityNumber, detail, status, created_at AS createdAt FROM users ORDER BY created_at DESC');
		res.json({ accounts });
	} catch (error) {
		next(error);
	}
});

app.patch('/api/admin/accounts/:id/status', sameOrigin, requireActiveUser, requireAdmin, async (req, res, next) => {
	const parsed = accountStatusSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Status akun tidak valid.' });
	try {
		const db = await databasePromise;
		const result = await db.run('UPDATE users SET status = ? WHERE id = ? AND role != ?', parsed.data.status, req.params.id, 'ADMIN');
		if (!result.changes) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
		res.json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.get('/api/profile/me', requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		const user = await db.get('SELECT id,full_name AS name,role,detail,bio FROM users WHERE id=?', req.user.id);
		const approvedAttendance = await db.get("SELECT COUNT(*) AS count FROM attendance WHERE user_id=? AND verification='DISETUJUI'", req.user.id);
		let assignmentCount = 0;
		if (req.user.role === 'ADMIN') assignmentCount = (await db.get('SELECT COUNT(*) AS count FROM assignments')).count;
		else if (req.user.role === 'GURU') assignmentCount = (await db.get('SELECT COUNT(*) AS count FROM assignments WHERE created_by=?', req.user.id)).count;
		else if (req.user.role === 'SISWA') assignmentCount = (await db.get('SELECT COUNT(*) AS count FROM assignments WHERE class_name=?', req.user.detail)).count;
		res.json({ user, assignmentCount, approvedAttendance: approvedAttendance.count });
	} catch (error) {
		next(error);
	}
});

app.put('/api/profile/me', sameOrigin, requireActiveUser, async (req, res, next) => {
	const parsed = z.object({ bio: z.string().trim().max(300) }).safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Bio maksimal 300 karakter.' });
	try {
		const db = await databasePromise;
		await db.run('UPDATE users SET bio=? WHERE id=?', parsed.data.bio, req.user.id);
		res.json({ bio: parsed.data.bio });
	} catch (error) {
		next(error);
	}
});

app.get('/api/search', requireActiveUser, async (req, res, next) => {
	const query = String(req.query.q || '').trim().slice(0, 80);
	const role = String(req.query.role || '').toUpperCase();
	if (query.length === 1) return res.status(422).json({ error: 'Masukkan minimal 2 karakter.' });
	if (role && !['SISWA', 'GURU', 'STAF', 'ADMIN'].includes(role)) return res.status(422).json({ error: 'Filter peran tidak valid.' });
	try {
		const db = await databasePromise;
		const escapedQuery = query.replace(/[%_]/g, '');
		const pattern = `%${escapedQuery}%`;
		const people = await db.all(`SELECT id,full_name AS name,role,detail,bio
			FROM users WHERE status='AKTIF'
			AND (?='' OR full_name LIKE ? COLLATE NOCASE OR detail LIKE ? COLLATE NOCASE)
			AND (?='' OR role=?)
			ORDER BY full_name COLLATE NOCASE LIMIT 50`, query ? escapedQuery : '', pattern, pattern, role, role);
		res.json({ people });
	} catch (error) {
		next(error);
	}
});

app.get('/api/search/:id/profile', requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		const person = await db.get("SELECT id,full_name AS name,role,detail,bio FROM users WHERE id=? AND status='AKTIF'", req.params.id);
		if (!person) return res.status(404).json({ error: 'Profil tidak ditemukan.' });
		let canSeeAcademicMetrics = person.id === req.user.id || req.user.role === 'ADMIN';
		if (!canSeeAcademicMetrics && req.user.role === 'GURU' && person.role === 'SISWA') {
			canSeeAcademicMetrics = Boolean(await db.get('SELECT 1 FROM assignments WHERE created_by=? AND class_name=? LIMIT 1', req.user.id, person.detail));
		}
		const approvedAttendance = await db.get("SELECT COUNT(*) AS count FROM attendance WHERE user_id=? AND verification='DISETUJUI'", person.id);
		let averageScore = null, rank = null;
		if (canSeeAcademicMetrics && person.role === 'SISWA') {
			const score = await db.get(`SELECT SUM(s.score) * 100.0 / NULLIF(SUM(a.max_score),0) AS average
				FROM submissions s JOIN assignments a ON a.id=s.assignment_id
				WHERE s.student_id=? AND s.score IS NOT NULL`, person.id);
			averageScore = score.average === null ? null : Math.round(score.average * 10) / 10;
			if (averageScore !== null) {
				const ranking = await db.get(`WITH averages AS (
					SELECT u.id, SUM(s.score) * 100.0 / NULLIF(SUM(a.max_score),0) AS average_score
					FROM users u LEFT JOIN submissions s ON s.student_id=u.id
					LEFT JOIN assignments a ON a.id=s.assignment_id
					WHERE u.status='AKTIF' AND u.role='SISWA' AND u.detail=?
					GROUP BY u.id
				), ranked AS (
					SELECT id, RANK() OVER (ORDER BY average_score DESC) AS class_rank
					FROM averages WHERE average_score IS NOT NULL
				)
				SELECT class_rank AS rank FROM ranked WHERE id=?`, person.detail, person.id);
				rank = ranking?.rank ?? null;
			}
		}
		res.json({ person, canSeeAcademicMetrics, averageScore, rank, approvedAttendance: canSeeAcademicMetrics ? approvedAttendance.count : null });
	} catch (error) {
		next(error);
	}
});

app.get('/api/notifications', requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		const notifications = await db.all('SELECT id,title,message,created_at AS createdAt,is_read AS isRead FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', req.user.id);
		res.json({ notifications });
	} catch (error) {
		next(error);
	}
});

app.patch('/api/notifications/read-all', sameOrigin, requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		await db.run('UPDATE notifications SET is_read=1 WHERE user_id=?', req.user.id);
		res.json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.patch('/api/notifications/:id/read', sameOrigin, requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		const result = await db.run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', req.params.id, req.user.id);
		if (!result.changes) return res.status(404).json({ error: 'Notifikasi tidak ditemukan.' });
		res.json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.get('/api/posts', requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		const rows = await db.all(`SELECT p.id,p.title,p.body,p.created_at AS createdAt,u.role AS authorRole,(p.author_id=?) AS isOwner,
			(SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS likes,
			EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=?) AS liked
			FROM posts p JOIN users u ON u.id=p.author_id ORDER BY p.created_at DESC LIMIT 50`, req.user.id, req.user.id);
		for (const post of rows) post.comments = await db.all(`SELECT c.id,c.body,c.created_at AS createdAt FROM comments c WHERE c.post_id=? ORDER BY c.created_at ASC`, post.id);
		res.json({ posts: rows });
	} catch (error) {
		next(error);
	}
});

app.post('/api/posts', sameOrigin, requireActiveUser, async (req, res, next) => {
	const parsed = postSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Judul atau isi topik tidak memenuhi batas karakter.' });
	try {
		const db = await databasePromise, id = crypto.randomUUID();
		await db.run('INSERT INTO posts (id, author_id, title, body) VALUES (?, ?, ?, ?)', id, req.user.id, parsed.data.title, parsed.data.body);
		res.status(201).json({ id });
	} catch (error) {
		next(error);
	}
});

app.post('/api/posts/:id/like', sameOrigin, requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		if (!await db.get('SELECT id FROM posts WHERE id=?', req.params.id)) return res.status(404).json({ error: 'Topik tidak ditemukan.' });
		const existing = await db.get('SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?', req.params.id, req.user.id);
		if (existing) await db.run('DELETE FROM post_likes WHERE post_id=? AND user_id=?', req.params.id, req.user.id);
		else await db.run('INSERT INTO post_likes (post_id,user_id) VALUES (?,?)', req.params.id, req.user.id);
		res.json({ liked: !existing });
	} catch (error) {
		next(error);
	}
});

app.post('/api/posts/:id/comments', sameOrigin, requireActiveUser, async (req, res, next) => {
	const parsed = commentSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Komentar wajib diisi dan maksimal 500 karakter.' });
	try {
		const db = await databasePromise;
		if (!await db.get('SELECT id FROM posts WHERE id=?', req.params.id)) return res.status(404).json({ error: 'Topik tidak ditemukan.' });
		await db.run('INSERT INTO comments (id,post_id,author_id,body,is_anonymous) VALUES (?,?,?,?,1)', crypto.randomUUID(), req.params.id, req.user.id, parsed.data.body);
		res.status(201).json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.delete('/api/posts/:id', sameOrigin, requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		const post = await db.get('SELECT author_id,created_at FROM posts WHERE id=?', req.params.id);
		if (!post) return res.status(404).json({ error: 'Topik tidak ditemukan.' });
		const age = Date.now() - new Date(`${post.created_at.replace(' ', 'T')}Z`).getTime();
		if (req.user.role !== 'ADMIN' && (post.author_id !== req.user.id || age > 24 * 60 * 60 * 1000)) return res.status(403).json({ error: 'Topik ini tidak dapat dihapus oleh akun Anda.' });
		await db.run('DELETE FROM posts WHERE id=?', req.params.id);
		res.json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.get('/api/assignments', requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		let assignments = [];
		if (req.user.role === 'ADMIN') assignments = await db.all('SELECT id,title,instructions AS description,subject,class_name AS class,due_at AS due,max_score AS maxScore FROM assignments ORDER BY due_at ASC');
		else if (req.user.role === 'GURU') assignments = await db.all('SELECT id,title,instructions AS description,subject,class_name AS class,due_at AS due,max_score AS maxScore FROM assignments WHERE created_by=? ORDER BY due_at ASC', req.user.id);
		else if (req.user.role === 'SISWA') assignments = await db.all('SELECT id,title,instructions AS description,subject,class_name AS class,due_at AS due,max_score AS maxScore FROM assignments WHERE class_name=? ORDER BY due_at ASC', req.user.detail);
		res.json({ assignments });
	} catch (error) {
		next(error);
	}
});

app.post('/api/assignments', sameOrigin, requireActiveUser, async (req, res, next) => {
	if (!['GURU', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Hanya guru yang dapat membuat tugas.' });
	const parsed = assignmentSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Data tugas tidak valid.' });
	try {
		const task = parsed.data, id = crypto.randomUUID(), db = await databasePromise;
		await db.run('INSERT INTO assignments (id,title,instructions,subject,class_name,due_at,max_score,created_by) VALUES (?,?,?,?,?,?,?,?)', id, task.title, task.instructions, task.subject, task.className, task.dueAt, task.maxScore, req.user.id);
		res.status(201).json({ id });
	} catch (error) {
		next(error);
	}
});

app.get('/api/attendance/settings', requireActiveUser, async (_, res, next) => {
	try {
		const db = await databasePromise;
		res.json({ settings: await db.get('SELECT latitude,longitude,radius_meters AS radiusMeters,open_time AS openTime,close_time AS closeTime,late_after AS lateAfter FROM school_settings WHERE id=1') });
	} catch (error) {
		next(error);
	}
});

app.put('/api/admin/attendance/settings', sameOrigin, requireActiveUser, requireAdmin, async (req, res, next) => {
	const parsed = settingsSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Pengaturan lokasi/jam tidak valid.' });
	try {
		const value = parsed.data, db = await databasePromise;
		await db.run('UPDATE school_settings SET latitude=?,longitude=?,radius_meters=?,open_time=?,close_time=?,late_after=? WHERE id=1', value.latitude, value.longitude, value.radiusMeters, value.openTime, value.closeTime, value.lateAfter);
		res.json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.post('/api/attendance/photo', sameOrigin, requireActiveUser, photoUpload.single('photo'), async (req, res, next) => {
	if (!req.file) return res.status(422).json({ error: 'Pilih foto kehadiran terlebih dahulu.' });
	const extension = getImageExtension(req.file.buffer, req.file.mimetype);
	if (!extension) return res.status(422).json({ error: 'Isi file bukan foto JPEG, PNG, atau WebP yang valid.' });
	const latitude = Number(req.body.latitude), longitude = Number(req.body.longitude), accuracy = Number(req.body.accuracy);
	if (![latitude, longitude, accuracy].every(Number.isFinite) || accuracy > 50 || accuracy < 0) return res.status(422).json({ error: 'Lokasi belum valid atau akurasinya lebih buruk dari 50 meter.' });
	try {
		const db = await databasePromise, settings = await db.get('SELECT * FROM school_settings WHERE id=1');
		const distance = haversineMeters(latitude, longitude, settings.latitude, settings.longitude);
		if (distance > settings.radius_meters) return res.status(403).json({ error: `Di luar radius sekolah (${Math.round(distance)} meter).` });
		const now = new Date(), localTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
		if (localTime < settings.open_time || localTime > settings.close_time) return res.status(403).json({ error: `Absen dibuka pukul ${settings.open_time}–${settings.close_time} WIB.` });
		const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
		if (await db.get('SELECT id FROM attendance WHERE user_id=? AND day=?', req.user.id, day)) return res.status(409).json({ error: 'Foto kehadiran hari ini sudah tercatat.' });
		const id = crypto.randomUUID(), photoName = `${id}${extension}`;
		await fs.promises.writeFile(path.join(photoDir, photoName), req.file.buffer, { flag: 'wx', mode: 0o600 });
		try {
			await db.run('INSERT INTO attendance (id,user_id,day,photo_name,latitude,longitude,accuracy,captured_at,verification) VALUES (?,?,?,?,?,?,?,?,?)', id, req.user.id, day, photoName, latitude, longitude, accuracy, now.toISOString(), 'MENUNGGU');
		} catch (error) {
			await fs.promises.unlink(path.join(photoDir, photoName)).catch(() => {});
			if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Foto kehadiran hari ini sudah tercatat.' });
			throw error;
		}
		res.status(201).json({ id, verification: 'MENUNGGU', capturedAt: now.toISOString() });
	} catch (error) {
		next(error);
	}
});

app.get('/api/attendance/mine', requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise;
		res.json({ attendance: await db.all('SELECT id,day,captured_at AS capturedAt,verification FROM attendance WHERE user_id=? ORDER BY captured_at DESC LIMIT 60', req.user.id) });
	} catch (error) {
		next(error);
	}
});

app.get('/api/attendance/:id/photo', requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise, record = await db.get('SELECT user_id,photo_name FROM attendance WHERE id=?', req.params.id);
		if (!record || (record.user_id !== req.user.id && req.user.role !== 'ADMIN')) return res.status(404).json({ error: 'Foto tidak ditemukan.' });
		res.set('Cache-Control', 'private, no-store');
		res.sendFile(path.join(photoDir, path.basename(record.photo_name)));
	} catch (error) {
		next(error);
	}
});

app.delete('/api/attendance/:id', sameOrigin, requireActiveUser, async (req, res, next) => {
	try {
		const db = await databasePromise, record = await db.get('SELECT user_id,photo_name,verification FROM attendance WHERE id=?', req.params.id);
		if (!record || record.user_id !== req.user.id || record.verification !== 'MENUNGGU') return res.status(404).json({ error: 'Foto tidak dapat dihapus.' });
		await db.run('DELETE FROM attendance WHERE id=?', req.params.id);
		await fs.promises.unlink(path.join(photoDir, path.basename(record.photo_name))).catch(() => {});
		res.json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.get('/api/admin/attendance', requireActiveUser, requireAdmin, async (_, res, next) => {
	try {
		const db = await databasePromise;
		res.json({ attendance: await db.all(`SELECT a.id,a.day,a.captured_at AS capturedAt,a.verification,u.full_name AS name,u.email,u.role
			FROM attendance a JOIN users u ON u.id=a.user_id ORDER BY a.captured_at DESC LIMIT 500`) });
	} catch (error) {
		next(error);
	}
});

app.patch('/api/admin/attendance/:id', sameOrigin, requireActiveUser, requireAdmin, async (req, res, next) => {
	const parsed = attendanceDecisionSchema.safeParse(req.body);
	if (!parsed.success) return res.status(422).json({ error: 'Keputusan tidak valid.' });
	try {
		const db = await databasePromise, result = await db.run('UPDATE attendance SET verification=? WHERE id=? AND verification=?', parsed.data.verification, req.params.id, 'MENUNGGU');
		if (!result.changes) return res.status(404).json({ error: 'Pengajuan tidak ditemukan atau sudah diputuskan.' });
		res.json({ ok: true });
	} catch (error) {
		next(error);
	}
});

app.use(express.static(publicDir, { index: 'index.html', maxAge: isProduction ? '1h' : 0 }));
app.use((error, req, res, next) => {
	console.error('Request gagal:', error.message);
	if (res.headersSent) return next(error);
	res.status(error instanceof multer.MulterError ? 413 : 500).json({ error: error instanceof multer.MulterError ? 'Foto maksimal 3 MB.' : 'Terjadi kesalahan pada server.' });
});

async function start() {
	const db = await databasePromise;
	const adminEmail = (process.env.SEED_ADMIN_EMAIL || (isProduction ? '' : 'admin@edusmart.example')).trim().toLowerCase();
	const adminPassword = process.env.SEED_ADMIN_PASSWORD || (isProduction ? '' : crypto.randomBytes(24).toString('base64url'));
	if (isProduction && (!adminEmail || !adminPassword || !process.env.SESSION_SECRET || !process.env.APP_URL)) {
		throw new Error('Production needs APP_URL, SESSION_SECRET, and initial admin credentials.');
	}
	const existing = adminEmail ? await db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', adminEmail) : null;
	if (!existing) {
		const id = crypto.randomUUID(), hash = await bcrypt.hash(adminPassword, Number(process.env.BCRYPT_COST || 12));
		await db.run('INSERT INTO users (id,full_name,email,password_hash,role,identity_number,detail,status) VALUES (?,?,?,?,?,?,?,?)', id, 'Admin Sekolah', adminEmail, hash, 'ADMIN', `ADMIN-${id.slice(0, 8)}`, 'Administrasi sekolah', 'AKTIF');
		if (process.env.SEED_ADMIN_PASSWORD) console.log(`Admin awal dibuat: ${adminEmail}`);
		else console.log(`Admin lokal pertama kali: ${adminEmail} | kata sandi sementara: ${adminPassword}`);
	}
	app.listen(PORT, () => console.log(`EduSmart berjalan di http://localhost:${PORT}`));
}

start().catch(error => {
	console.error('Server gagal dimulai:', error.message);
	process.exit(1);
});