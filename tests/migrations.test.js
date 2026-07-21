const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CURRENT_SCHEMA_VERSION,
  inferSchemaVersion,
  migrateData
} = require("../modules/migrations.js");

test("старый формат операций обновляется без потери данных", () => {
  const oldData = {
    settings: { opening: 15000, name: "Иван" },
    ops: [{ id: "1", type: "income", sum: 5000, cat: "Зарплата", acc: "Карта", date: "2025-01-10" }],
    debts: []
  };
  assert.equal(inferSchemaVersion(oldData), 1);
  const migrated = migrateData(oldData);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.operations.length, 1);
  assert.equal(migrated.operations[0].amount, 5000);
  assert.equal(migrated.operations[0].accountId, "account-main");
  assert.equal(migrated.accounts[0].openingBalance, 15000);
});

test("миграция добавляет новые защищённые настройки", () => {
  const migrated = migrateData({
    settings: { name: "Анна" },
    accounts: [{ id: "account-main", openingBalance: 0 }],
    operations: [],
    debts: [],
    transfers: [],
    recurring: []
  });
  assert.equal(migrated.settings.login, "Анна");
  assert.equal(migrated.settings.pinHash, "");
  assert.equal(migrated.settings.autoLockMinutes, 5);
  assert.equal(migrated.settings.avatar, "");
  assert.equal(migrated.settings.lockOnHide, true);
  assert.equal(migrated.settings.encryptedAtRest, false);
  assert.equal(migrated.settings.vaultPasswordWrap, null);
  assert.equal(migrated.settings.vaultPinWrap, null);
});

test("повторная миграция идемпотентна", () => {
  const once = migrateData({ settings: {}, operations: [], debts: [] });
  const twice = migrateData(once);
  assert.deepEqual(twice, once);
});
