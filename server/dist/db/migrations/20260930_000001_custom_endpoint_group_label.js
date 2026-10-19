// Migration: optional group label for custom endpoints (#1176)
// Created: 2026-09-30
//
// DOWN: reversible
//
// All custom endpoints used to render under the single "Custom" group, which
// becomes unwieldy once more than a few relays are configured (#1176). An
// operator-set group label splits that group in the dashboard; NULL keeps the
// legacy single "Custom" group, so nothing changes until a label is set.
//
// Guarded like the baseline's column adds: catalog-sync re-runs migrations
// over a live schema, so ALTERs must be idempotent.
function hasColumn(db, table, column) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    return columns.some(col => col.name === column);
}
export function up(db) {
    if (!hasColumn(db, 'api_keys', 'group_label')) {
        db.prepare('ALTER TABLE api_keys ADD COLUMN group_label TEXT').run();
    }
}
export function down(db) {
    if (hasColumn(db, 'api_keys', 'group_label')) {
        db.prepare('ALTER TABLE api_keys DROP COLUMN group_label').run();
    }
}
//# sourceMappingURL=20260930_000001_custom_endpoint_group_label.js.map