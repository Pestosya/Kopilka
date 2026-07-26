const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PASSWORD_ITERATIONS,
  BACKUP_ITERATIONS,
  createSecretHash,
  verifySecret,
  isStrongPassword,
  needsHashUpgrade,
  encryptPayload,
  decryptPayload,
  encryptWithRawKey,
  decryptWithRawKey,
  wrapVaultKey,
  unwrapVaultKey,
  preserveVaultSecuritySettings
} = require("../modules/security.js");
const {
  CURRENT_SCHEMA_VERSION,
  migrateData
} = require("../modules/migrations.js");

test("настройки защиты используют усиленное число итераций", () => {
  assert.equal(PASSWORD_ITERATIONS, 600000);
  assert.equal(BACKUP_ITERATIONS, 600000);
  assert.equal(isStrongPassword("finance2026"), true);
  assert.equal(isStrongPassword("short"), false);
  assert.equal(needsHashUpgrade("pbkdf2$210000$salt$hash"), true);
  assert.equal(needsHashUpgrade("pbkdf2$600000$salt$hash"), false);
});

test("пароль хранится как PBKDF2-хеш и проверяется", async () => {
  const hash = await createSecretHash("correct-horse", 1000);
  assert.match(hash, /^pbkdf2\$/);
  assert.equal(await verifySecret("correct-horse", hash), true);
  assert.equal(await verifySecret("wrong", hash), false);
});

test("зашифрованная копия восстанавливается только правильным паролем", async () => {
  const payload = { app: "Копилка", data: { operations: [{ amount: 123 }] } };
  const encrypted = await encryptPayload(payload, "backup-password", 1000);
  assert.equal(encrypted.algorithm, "AES-GCM-256");
  assert.equal(encrypted.encrypted, true);
  assert.deepEqual(await decryptPayload(encrypted, "backup-password"), payload);
  await assert.rejects(() => decryptPayload(encrypted, "wrong-password"));
});

test("локальная база шифруется отдельным ключом, защищённым паролем", async () => {
  const key = new Uint8Array(32).fill(7);
  const payload = { operations: [{ amount: 999 }] };
  const encrypted = await encryptWithRawKey(payload, key);
  assert.equal(encrypted.format, "kopilka-encrypted-profile");
  assert.equal(JSON.stringify(encrypted).includes("operations"), false);
  assert.deepEqual(await decryptWithRawKey(encrypted, key), payload);
  await assert.rejects(() => decryptWithRawKey(encrypted, new Uint8Array(32).fill(8)));
  const wrapped = await wrapVaultKey(key, "vault-password", 1000);
  assert.deepEqual(await unwrapVaultKey(wrapped, "vault-password"), key);
  await assert.rejects(() => unwrapVaultKey(wrapped, "wrong-password"));
});

test("legacy encrypted profile сохраняет password wrap после миграции и автосохранения", async () => {
  const password = "LegacyPass123";
  const key = new Uint8Array(32).fill(13);
  const wrapper = await wrapVaultKey(key, password, 1000);
  const legacyProfile = {
    schemaVersion: 10,
    settings: {
      login: "legacy@example.com",
      name: "Legacy",
      encryptedAtRest: true,
      vaultPasswordWrap: null,
      vaultPinWrap: null,
      currency: "₽"
    },
    accounts: [{
      id: "legacy-card",
      name: "Старая карта",
      type: "card",
      openingBalance: 12000,
      createdAt: "2026-01-01"
    }],
    operations: [{
      id: "legacy-expense",
      accountId: "legacy-card",
      type: "expense",
      amount: 700,
      category: "Продукты",
      date: "2026-01-02"
    }],
    transfers: [],
    recurring: [],
    debts: []
  };

  const firstEnvelope = await encryptWithRawKey(legacyProfile, key);
  const openedKey = await unwrapVaultKey(wrapper, password);
  const decrypted = await decryptWithRawKey(firstEnvelope, openedKey);
  const migrated = preserveVaultSecuritySettings(migrateData(decrypted), wrapper);

  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.settings.encryptedAtRest, true);
  assert.equal(migrated.settings.vaultPinWrap, null);
  assert.deepEqual(migrated.settings.vaultPasswordWrap, wrapper);
  assert.deepEqual(migrated.cards, []);
  assert.equal(migrated.accounts[0].type, "debit_card");
  assert.equal(migrated.accounts[0].lastFourDigits, "");
  assert.equal(migrated.accounts[0].numberMissing, true);

  const autosavedEnvelope = await encryptWithRawKey(migrated, key);
  const autosavedRecord = {
    envelope: autosavedEnvelope,
    wrap: migrated.settings.vaultPasswordWrap
  };
  const serializedAutosave = JSON.stringify(autosavedRecord);
  assert.equal(serializedAutosave.includes(password), false);
  assert.equal(JSON.stringify(autosavedEnvelope).includes("legacy-expense"), false);

  const reopenedKey = await unwrapVaultKey(autosavedRecord.wrap, password);
  assert.deepEqual(reopenedKey, key);
  const reopened = await decryptWithRawKey(autosavedRecord.envelope, reopenedKey);
  assert.equal(reopened.settings.vaultPasswordWrap.format, "kopilka-encrypted-backup");
  assert.equal(reopened.operations.find(item => item.id === "initial-balance:legacy-card").amount, 12000);
  await assert.rejects(() => unwrapVaultKey(autosavedRecord.wrap, "wrong-password"));
});
