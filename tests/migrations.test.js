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
  assert.deepEqual(migrated.cards, []);
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

test("миграция 10 -> 12 переносит card-счёт в самостоятельную дебетовую карту без выдуманного номера", () => {
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
  assert.equal(migrated.accounts[0].type, "debit_card");
  assert.equal(migrated.accounts[0].openingBalance, undefined);
  assert.deepEqual(migrated.cards, []);
  assert.equal(migrated.accounts[0].lastFourDigits, "");
  assert.equal(migrated.accounts[0].isMigrated, true);
  assert.equal(migrated.accounts[0].numberMissing, true);
  assert.equal(migrated.operations.find(item => item.id === "op-1").cardId, "");
  assert.equal(migrated.operations.find(item => item.id === "initial-balance:card-main").cardId, "");
  assert.equal(migrated.operations.find(item => item.id === "initial-balance:card-main").amount, 12000);
});

test("повторная миграция 10 -> 12 не дублирует initial_balance", () => {
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
  assert.deepEqual(once.cards, []);
});

test("cardId старых операций очищается при переходе к самостоятельным объектам", () => {
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
  assert.equal(migrated.operations.find(item => item.id === "card-op").cardId, "");
  assert.equal(migrated.operations.find(item => item.id === "cash-op").cardId, "");
});

test("миграция 11 -> 12 переносит primary-карту в account и сохраняет связи по accountId", () => {
  const migrated = migrateData({
    schemaVersion: 11,
    settings: { currency: "₽", openingBalance: 999999 },
    accounts: [
      { id: "main", name: "Старый счёт", type: "current", openingBalance: 2500, createdAt: "2026-02-01" },
      { id: "credit", name: "Кредитка", type: "credit", openingBalance: -35000, creditLimit: 90000, createdAt: "2026-02-02" },
      { id: "broker", name: "Брокерский остаток", type: "investment", openingBalance: 1000, createdAt: "2026-02-03" }
    ],
    cards: [
      { id: "card-main", accountId: "main", name: "Black", lastFourDigits: "3474", paymentSystem: "mir", cardType: "debit", isPrimary: true, isVirtual: true, color: "blue" },
      { id: "card-credit", accountId: "credit", name: "Platinum", lastFourDigits: "", paymentSystem: "visa", cardType: "credit", isPrimary: true, creditLimit: 100000 }
    ],
    operations: [
      { id: "buy", accountId: "credit", cardId: "card-credit", type: "expense", amount: 700, category: "Продукты", date: "2026-02-04" }
    ],
    transfers: [{ id: "pay", fromAccountId: "main", toAccountId: "credit", amount: 5000, date: "2026-02-05" }],
    recurring: [{ id: "rec", accountId: "missing", name: "Сервис", type: "expense", category: "Подписки", amount: 100, nextDate: "2026-03-01" }],
    debts: []
  });

  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrated.cards, []);
  assert.equal(migrated.accounts.length, 3);
  assert.equal(migrated.accounts[0].id, "main");
  assert.equal(migrated.accounts[0].type, "debit_card");
  assert.equal(migrated.accounts[0].lastFourDigits, "3474");
  assert.equal(migrated.accounts[0].paymentSystem, "mir");
  assert.equal(migrated.accounts[0].isVirtual, true);
  assert.equal(migrated.accounts[1].id, "credit");
  assert.equal(migrated.accounts[1].type, "credit_card");
  assert.equal(migrated.accounts[1].creditLimit, 100000);
  assert.equal(migrated.accounts[1].numberMissing, true);
  assert.equal(migrated.accounts[2].type, "wallet");
  assert.equal(migrated.accounts[2].legacyType, "investment");
  assert.equal(migrated.operations.find(item => item.id === "buy").accountId, "credit");
  assert.equal(migrated.operations.find(item => item.id === "buy").cardId, "");
  assert.equal(migrated.transfers[0].fromAccountId, "main");
  assert.equal(migrated.transfers[0].toAccountId, "credit");
  assert.equal(migrated.recurring[0].accountId, "main");
  assert.equal(migrated.settings.openingBalance, 0);
  assert.equal(migrated.operations.find(item => item.id === "initial-balance:main").amount, 2500);
  assert.equal(migrated.operations.find(item => item.id === "initial-balance:credit").amount, -35000);
});

test("миграция 11 -> 12 не удваивает существующий initial_balance", () => {
  const migrated = migrateData({
    schemaVersion: 11,
    settings: {},
    accounts: [{ id: "main", name: "Основная", type: "current", openingBalance: 15000 }],
    cards: [],
    operations: [{ id: "custom-initial", accountId: "main", type: "initial_balance", amount: 15000 }],
    transfers: [],
    recurring: [],
    debts: []
  });
  assert.equal(migrated.operations.filter(item => item.type === "initial_balance" && item.accountId === "main").length, 1);
  assert.equal(migrated.operations.find(item => item.type === "initial_balance").id, "initial-balance:main");
  assert.equal(migrated.operations.find(item => item.type === "initial_balance").amount, 15000);
  assert.deepEqual(migrateData(migrated), migrated);
});

test("повторная миграция идемпотентна", () => {
  const once = migrateData({ settings: {}, operations: [], debts: [] });
  const twice = migrateData(once);
  assert.deepEqual(twice, once);
});
