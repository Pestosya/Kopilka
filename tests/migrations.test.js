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
  assert.equal(migrated.operations.length, 2);
  assert.equal(migrated.operations.find(item => item.id === "1").amount, 5000);
  assert.equal(migrated.operations.find(item => item.id === "1").accountId, "account-main");
  assert.equal(migrated.accounts[0].openingBalance, undefined);
  assert.equal(migrated.operations.find(item => item.id === "initial-balance:account-main").amount, 15000);
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

test("миграция 10 -> 11 переносит card-счёт в счёт и legacy-карту без выдуманного номера", () => {
  const migrated = migrateData({
    schemaVersion: 10,
    settings: { currency: "₽" },
    accounts: [{ id: "card-main", name: "Основная карта", type: "card", openingBalance: 12000, createdAt: "2026-01-01" }],
    operations: [{ id: "op-1", accountId: "card-main", type: "expense", amount: 1000, category: "Продукты", date: "2026-01-02" }],
    transfers: [],
    recurring: [],
    debts: []
  });
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.accounts[0].id, "card-main");
  assert.equal(migrated.accounts[0].type, "current");
  assert.equal(migrated.accounts[0].openingBalance, undefined);
  assert.equal(migrated.cards.length, 1);
  assert.equal(migrated.cards[0].accountId, "card-main");
  assert.equal(migrated.cards[0].lastFourDigits, "");
  assert.equal(migrated.cards[0].isMigrated, true);
  assert.equal(migrated.cards[0].numberMissing, true);
  assert.equal(migrated.operations.find(item => item.id === "op-1").cardId, migrated.cards[0].id);
  assert.equal(migrated.operations.find(item => item.id === "initial-balance:card-main").cardId, "");
});

test("повторная миграция 10 -> 11 не дублирует initial_balance и карты", () => {
  const source = {
    schemaVersion: 10,
    settings: {},
    accounts: [{ id: "account-main", name: "Основная карта", type: "card", openingBalance: 15000 }],
    operations: [],
    transfers: [],
    recurring: [],
    debts: []
  };
  const once = migrateData(source);
  const twice = migrateData(once);
  assert.deepEqual(twice, once);
  assert.equal(once.operations.filter(item => item.type === "initial_balance").length, 1);
  assert.equal(once.cards.length, 1);
});

test("cardId старым операциям назначается только при одной мигрированной карте", () => {
  const migrated = migrateData({
    schemaVersion: 10,
    settings: {},
    accounts: [
      { id: "card-main", name: "Карта", type: "card", openingBalance: 0 },
      { id: "cash", name: "Наличные", type: "cash", openingBalance: 0 }
    ],
    operations: [
      { id: "card-op", accountId: "card-main", type: "income", amount: 100 },
      { id: "cash-op", accountId: "cash", type: "income", amount: 200 }
    ],
    transfers: [],
    recurring: [],
    debts: []
  });
  assert.ok(migrated.operations.find(item => item.id === "card-op").cardId);
  assert.equal(migrated.operations.find(item => item.id === "cash-op").cardId, "");
});

test("повторная миграция идемпотентна", () => {
  const once = migrateData({ settings: {}, operations: [], debts: [] });
  const twice = migrateData(once);
  assert.deepEqual(twice, once);
});
