(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.KopilkaMigrations = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CURRENT_SCHEMA_VERSION = 10;

  function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function inferSchemaVersion(data) {
    if (Number(data?.schemaVersion) > 0) return Number(data.schemaVersion);
    if (Array.isArray(data?.ops)) return 1;
    if (!Array.isArray(data?.accounts)) return 2;
    if (!Array.isArray(data?.recurring) || !Array.isArray(data?.transfers)) return 3;
    if (data?.settings?.login === undefined || data?.settings?.passwordHash === undefined) return 4;
    if (data?.settings?.pinHash === undefined || data?.settings?.biometricCredential === undefined) return 5;
    return 6;
  }

  const migrations = {
    1(data) {
      if (!Array.isArray(data.operations) && Array.isArray(data.ops)) {
        data.operations = data.ops.map(item => ({
          id: item.id,
          type: item.type === "income" ? "income" : "expense",
          amount: Number(item.sum || 0),
          category: item.cat || "Другое",
          account: item.acc || "",
          note: item.note || "",
          date: item.date || ""
        }));
      }
      if (!Array.isArray(data.debts)) data.debts = [];
      delete data.ops;
      return data;
    },
    2(data) {
      const openingBalance = Number(data.settings?.openingBalance ?? data.settings?.opening ?? 0);
      data.accounts = [{
        id: "account-main",
        name: "Основная карта",
        type: "card",
        openingBalance,
        createdAt: ""
      }];
      (data.operations || []).forEach(operation => {
        operation.accountId ||= "account-main";
      });
      return data;
    },
    3(data) {
      data.transfers ||= [];
      data.recurring ||= [];
      return data;
    },
    4(data) {
      data.settings ||= {};
      data.settings.login ??= data.settings.name || "";
      data.settings.passwordHash ??= "";
      return data;
    },
    5(data) {
      data.settings ||= {};
      data.settings.pinHash ??= "";
      data.settings.biometricCredential ??= null;
      data.settings.autoLockMinutes ??= 5;
      return data;
    },
    6(data) {
      data.categories ||= {};
      data.operations ||= [];
      data.debts ||= [];
      data.accounts ||= [];
      data.transfers ||= [];
      data.recurring ||= [];
      return data;
    },
    7(data) {
      data.settings ||= {};
      data.settings.avatar ??= "";
      return data;
    },
    8(data) {
      data.settings ||= {};
      data.settings.autoLockMinutes ??= 5;
      data.settings.lockOnHide ??= true;
      return data;
    },
    9(data) {
      data.settings ||= {};
      data.settings.encryptedAtRest ??= false;
      data.settings.vaultPasswordWrap ??= null;
      data.settings.vaultPinWrap ??= null;
      return data;
    }
  };

  function migrateData(source) {
    const data = clone(source);
    let version = Math.min(inferSchemaVersion(data), CURRENT_SCHEMA_VERSION);
    while (version < CURRENT_SCHEMA_VERSION) {
      const migrate = migrations[version];
      if (migrate) migrate(data);
      version += 1;
      data.schemaVersion = version;
    }
    data.schemaVersion = CURRENT_SCHEMA_VERSION;
    return data;
  }

  return { CURRENT_SCHEMA_VERSION, inferSchemaVersion, migrateData };
});
