// Migration: remove the retired GitHub Models provider
// Created: 2026-10-17
//
// DOWN: reversible (the removed rows are kept in settings)
//
// GitHub Models was retired on 30 July 2026 (#549). models.github.ai now
// answers every request with 200 "OK" in plain text, so leftover GitHub keys
// looked healthy, custom GitHub models joined the fallback chain, and every
// request routed there failed (#1557). The adapter is gone, so these rows can
// never serve again: remove the keys, models, embedding and media rows, model
// overrides, and the chain and profile entries that point at the models.
// Request history keeps its 'github' rows; that is a record, not config.
const SETTING_KEY = 'migration_github_removed_rows';
// Insert order for DOWN: parents before the rows that reference them.
const TABLES = ['api_keys', 'models', 'embedding_models', 'media_models', 'model_overrides', 'fallback_config', 'profile_models'];
function tableExists(db, table) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}
function selectRows(db, table) {
    if (!tableExists(db, table))
        return [];
    if (table === 'fallback_config' || table === 'profile_models') {
        return db.prepare(`
      SELECT * FROM ${table} WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'github')
    `).all();
    }
    return db.prepare(`SELECT * FROM ${table} WHERE platform = 'github'`).all();
}
// Encrypted key columns may be BLOBs; JSON keeps them as tagged base64.
function encode(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        out[k] = Buffer.isBuffer(v) ? { $buffer: v.toString('base64') } : v;
    }
    return out;
}
function decode(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        const tagged = v;
        out[k] = tagged && typeof tagged === 'object' && typeof tagged.$buffer === 'string'
            ? Buffer.from(tagged.$buffer, 'base64')
            : v;
    }
    return out;
}
export function up(db) {
    const removed = {};
    for (const table of TABLES)
        removed[table] = selectRows(db, table).map(encode);
    // Children first: chain and profile rows reference models(id).
    for (const table of ['fallback_config', 'profile_models']) {
        if (!tableExists(db, table))
            continue;
        db.prepare(`
      DELETE FROM ${table} WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'github')
    `).run();
    }
    for (const table of ['models', 'embedding_models', 'media_models', 'model_overrides', 'api_keys']) {
        if (!tableExists(db, table))
            continue;
        db.prepare(`DELETE FROM ${table} WHERE platform = 'github'`).run();
    }
    db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTING_KEY, JSON.stringify(removed));
}
export function down(db) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY);
    const removed = row ? JSON.parse(row.value) : {};
    for (const table of TABLES) {
        for (const raw of removed[table] ?? []) {
            const r = decode(raw);
            const cols = Object.keys(r);
            db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
                .run(...cols.map(c => r[c]));
        }
    }
    db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_KEY);
}
//# sourceMappingURL=20261017_000002_remove_github_provider.js.map