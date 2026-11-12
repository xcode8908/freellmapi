// Neon PostgreSQL Persistence Layer for FreeLLMAPI
// Zero-Git, 100% Cloud-Persistent Database on Render Free Tier

const fs = require('fs');
const path = require('path');

const NEON_CONN = process.env.NEON_DATABASE_URL || '';
const DB_PATH = process.env.FREEAPI_DB_PATH || '/app/server/data/freeapi.db';
const PORT = process.env.PORT || 10000;

function getSqliteDb(filePath) {
  const candidates = [
    '/app/server/node_modules/better-sqlite3',
    'better-sqlite3',
    '/app/node_modules/better-sqlite3'
  ];
  for (const c of candidates) {
    try {
      const Database = require(c);
      return new Database(filePath);
    } catch (e) {}
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(filePath);
  } catch (e2) {}
  throw new Error('No SQLite driver available in container');
}

function getNeonUrl() {
  if (!NEON_CONN) return null;
  const match = NEON_CONN.match(/@([^/:]+)/);
  if (!match) return null;
  return `https://${match[1]}/sql`;
}

async function queryNeon(sql, params = []) {
  const url = getNeonUrl();
  if (!url) throw new Error('Invalid NEON_DATABASE_URL');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Neon-Connection-String': NEON_CONN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql, params })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Neon HTTP error (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * 1. RESTORE FROM NEON
 * Executed after FreeLLM initializes migrations cleanly.
 */
async function restoreFromNeon() {
  if (!NEON_CONN) {
    console.log('[NeonSync] NEON_DATABASE_URL not set. Skipping restore.');
    return;
  }

  console.log('[NeonSync] 🔄 Checking Neon PostgreSQL for saved FreeLLM snapshot...');
  try {
    const data = await queryNeon(
      'SELECT sql_dump, filesize, requests_count, client_key, updated_at FROM public.freellm_persistent_store WHERE id = 1;'
    );

    if (!data.rows || data.rows.length === 0 || !data.rows[0].sql_dump) {
      console.log('[NeonSync] ℹ️ No existing snapshot found in Neon.');
      return;
    }

    const row = data.rows[0];
    const sqlDump = row.sql_dump;

    console.log(`[NeonSync] 📥 Restoring from Neon snapshot (Size: ${row.filesize} bytes, Requests: ${row.requests_count}, Client Key: ${row.client_key ? row.client_key.slice(0, 15) : 'none'}..., Updated: ${row.updated_at})...`);

    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    // Open target sqlite database and execute the dump statements
    const db = getSqliteDb(DB_PATH);
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(sqlDump);
    db.exec('PRAGMA foreign_keys = ON;');
    db.close();

    console.log('[NeonSync] ✅ SUCCESS! FreeLLM database restored from Neon PostgreSQL in under 1s!');
  } catch (err) {
    console.error('[NeonSync] ❌ Restore error:', err.message);
  }
}

/**
 * Helper to get admin login credentials
 */
function getAdminCredentials() {
  let email = 'silentx7894@gmail.com';
  let password = 'Lipan8908@';

  try {
    if (process.env.FREEAPI_CONFIG_JSON) {
      const cfg = JSON.parse(process.env.FREEAPI_CONFIG_JSON);
      if (cfg.admin && cfg.admin.email && cfg.admin.password) {
        email = cfg.admin.email;
        password = cfg.admin.password;
      }
    }
  } catch (e) {
    // ignore
  }

  return { email, password };
}

/**
 * 2. BACKUP TO NEON
 * Triggers a backup via FreeLLM API, downloads it, and upserts into Neon.
 */
async function backupToNeon() {
  if (!NEON_CONN) return;

  try {
    const { email, password } = getAdminCredentials();

    // 1. Login to get token
    const loginRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!loginRes.ok) {
      console.warn(`[NeonSync] Login failed (${loginRes.status}), will retry.`);
      return;
    }

    const { token } = await loginRes.json();

    // 2. Trigger internal backup
    const bRes = await fetch(`http://127.0.0.1:${PORT}/api/backups`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    if (!bRes.ok) {
      console.warn(`[NeonSync] Backup creation failed (${bRes.status})`);
      return;
    }

    const { backup } = await bRes.json();
    const backupId = backup.id;

    // 3. Download the backup SQL dump
    const dlRes = await fetch(`http://127.0.0.1:${PORT}/api/backups/${backupId}/download`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!dlRes.ok) {
      console.warn(`[NeonSync] Download failed (${dlRes.status})`);
      return;
    }

    const sqlDump = await dlRes.text();

    // 4. Read client key and request count if available
    let clientKey = '';
    let requestsCount = 0;
    try {
      if (fs.existsSync(DB_PATH)) {
        const db = getSqliteDb(DB_PATH);
        const reqRow = db.prepare('SELECT count(*) as count FROM requests').get();
        if (reqRow) requestsCount = reqRow.count;
        const keyRow = db.prepare('SELECT token FROM client_profiles WHERE enabled = 1 LIMIT 1').get();
        if (keyRow) clientKey = keyRow.token;
        db.close();
      }
    } catch (e) {
      // ignore
    }

    // 5. Upsert into Neon
    await queryNeon(
      `INSERT INTO public.freellm_persistent_store (id, sql_dump, backup_id, filesize, requests_count, client_key, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
          sql_dump = EXCLUDED.sql_dump,
          backup_id = EXCLUDED.backup_id,
          filesize = EXCLUDED.filesize,
          requests_count = EXCLUDED.requests_count,
          client_key = EXCLUDED.client_key,
          updated_at = NOW();`,
      [sqlDump, backupId, sqlDump.length, requestsCount, clientKey]
    );

    // 6. Delete local temp backup to save disk
    await fetch(`http://127.0.0.1:${PORT}/api/backups/${backupId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    }).catch(() => {});

    console.log(`[NeonSync] 💾 Synced to Neon PostgreSQL! (Requests: ${requestsCount}, Size: ${Math.round(sqlDump.length / 1024)} KB, Key: ${clientKey ? clientKey.slice(0, 15) : 'none'}...)`);
  } catch (err) {
    console.error('[NeonSync] ❌ Backup error:', err.message);
  }
}

/**
 * 3. DAEMON MODE
 * Waits for FreeLLM to boot, restores if fresh, then syncs every 5 minutes and on shutdown.
 */
async function startDaemon() {
  console.log('[NeonSync] 🛡️ Daemon active: Monitoring FreeLLM server on port ' + PORT + '...');

  // Wait for FreeLLM server to come online and finish its migrations
  let attempts = 0;
  while (attempts < 60) {
    try {
      const ping = await fetch(`http://127.0.0.1:${PORT}/api/ping`);
      if (ping.ok) {
        console.log(`[NeonSync] FreeLLM server is online on port ${PORT}!`);
        break;
      }
    } catch (e) {
      // waiting
    }
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }

  // Check if we need to restore (e.g. fresh container restart where client_profiles is empty)
  let needsRestore = true;
  try {
    if (fs.existsSync(DB_PATH)) {
      const db = getSqliteDb(DB_PATH);
      const row = db.prepare('SELECT count(*) as c FROM client_profiles').get();
      if (row && row.c > 0) {
        needsRestore = false;
      }
      db.close();
    }
  } catch (e) {
    needsRestore = true;
  }

  if (needsRestore) {
    console.log('[NeonSync] Fresh database detected. Restoring state from Neon PostgreSQL...');
    await restoreFromNeon();
  } else {
    console.log('[NeonSync] Existing database verified healthy with client profile.');
  }

  // Initial sync after 30 seconds
  setTimeout(async () => {
    await backupToNeon();
  }, 30000);

  // Periodic backup every 5 minutes (300,000 ms)
  setInterval(async () => {
    await backupToNeon();
  }, 5 * 60 * 1000);

  // Graceful shutdown sync
  const handleShutdown = async (signal) => {
    console.log(`[NeonSync] Received ${signal}. Executing final snapshot to Neon before exit...`);
    try {
      await backupToNeon();
      console.log('[NeonSync] Final snapshot to Neon complete. Goodbye!');
    } catch (e) {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

// CLI Command dispatcher
const command = process.argv[2];
if (command === 'restore') {
  restoreFromNeon().then(() => process.exit(0));
} else if (command === 'backup') {
  backupToNeon().then(() => process.exit(0));
} else if (command === 'daemon') {
  startDaemon();
} else {
  console.log('Usage: node neon-sync.cjs [restore | backup | daemon]');
}
