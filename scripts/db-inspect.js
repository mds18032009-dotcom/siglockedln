const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const databasePath = path.join(dataDir, 'edusmart.sqlite');
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  console.log(`Database: ${databasePath}`);
  console.log('\nTables:');
  console.table(tables);

  if (tables.some(table => table.name === 'users')) {
    console.log('\nAccounts:');
    console.table(db.prepare('SELECT full_name AS name, email, role, status, created_at AS createdAt FROM users ORDER BY created_at').all());
  }

  for (const table of ['posts', 'comments', 'assignments', 'attendance', 'notifications']) {
    if (!tables.some(item => item.name === table)) continue;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    console.log(`${table}: ${count} rows`);
  }

  if (tables.some(table => table.name === 'attendance')) {
    console.log('\nAttendance by verification state:');
    console.table(db.prepare('SELECT verification, COUNT(*) AS count FROM attendance GROUP BY verification ORDER BY verification').all());
  }
} finally {
  db.close();
}
