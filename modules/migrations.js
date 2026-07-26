(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.KopilkaMigrations = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CURRENT_SCHEMA_VERSION = 12;
  const ACCOUNT_TYPES = new Set(["debit_card", "credit_card", "savings", "cash", "wallet"]);
  const CARD_TYPES = new Set(["debit", "credit"]);
  const PAYMENT_SYSTEMS = new Set(["mir", "visa", "mastercard", "unionpay", "other"]);
  const TRANSACTION_TYPES = new Set(["income", "expense", "refund", "transfer", "initial_balance", "balance_adjustment", "fee"]);

  function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function isoToday() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function initialBalanceOperationId(accountId) {
    return `initial-balance:${accountId}`;
  }

  function legacyOpeningBalance(item) {
    return Number(item?.openingBalance ?? item?.initialBalance ?? item?.balance ?? 0);
  }

  function hasLegacyOpeningBalance(item) {
    return Boolean(item) && (
      Object.prototype.hasOwnProperty.call(item, "openingBalance")
      || Object.prototype.hasOwnProperty.call(item, "initialBalance")
      || Object.prototype.hasOwnProperty.call(item, "balance")
    );
  }

  function normalizeAccountType(type) {
    if (type === "card" || type === "current") return "debit_card";
    if (type === "credit") return "credit_card";
    if (type === "deposit") return "savings";
    if (type === "investment" || type === "other") return "wallet";
    return ACCOUNT_TYPES.has(type) ? type : "debit_card";
  }

  function legacyTypeFor(item, normalizedType) {
    const original = item?.legacyType || item?.type || "";
    if ((original === "investment" || original === "other") && normalizedType === "wallet") return original;
    return item?.legacyType || "";
  }

  function normalizeOperationType(type) {
    return TRANSACTION_TYPES.has(type) ? type : (type === "income" ? "income" : "expense");
  }

  function explicitLastFourDigits(item) {
    const value = item?.lastFourDigits ?? item?.last4 ?? item?.cardLastFour ?? "";
    return /^[0-9]{4}$/.test(String(value)) ? String(value) : "";
  }

  function normalizePaymentSystem(value) {
    return PAYMENT_SYSTEMS.has(value) ? value : "other";
  }

  function normalizeCardType(value) {
    return CARD_TYPES.has(value) ? value : "debit";
  }

  function normalizeV11Account(item, index = 0, settings = {}) {
    const now = isoToday();
    const type = normalizeAccountType(item?.type);
    return {
      id: item?.id || `account-${index + 1}`,
      name: String(item?.name || (index === 0 ? "Основной счёт" : "Счёт")),
      type,
      bankName: item?.bankName || item?.bank || "",
      currency: item?.currency || settings.currency || "₽",
      includeInTotal: item?.includeInTotal !== false,
      includeInSafetyFund: item?.includeInSafetyFund === true,
      allowNegativeBalance: item?.allowNegativeBalance === true || type === "credit_card",
      hideBalance: item?.hideBalance === true,
      isArchived: item?.isArchived === true,
      color: item?.color || "",
      icon: item?.icon || "",
      lastFourDigits: explicitLastFourDigits(item),
      paymentSystem: normalizePaymentSystem(item?.paymentSystem),
      isVirtual: item?.isVirtual === true,
      expirationDate: item?.expirationDate || "",
      creditLimit: Math.max(0, Number(item?.creditLimit || 0)),
      minimumPayment: Math.max(0, Number(item?.minimumPayment || 0)),
      paymentDueDate: item?.paymentDueDate || "",
      interestRate: Math.max(0, Number(item?.interestRate || 0)),
      gracePaymentAmount: Math.max(0, Number(item?.gracePaymentAmount || 0)),
      legacyType: legacyTypeFor(item, type),
      isLegacy: item?.isLegacy === true,
      isMigrated: item?.isMigrated === true,
      numberMissing: item?.numberMissing === true || (type === "debit_card" || type === "credit_card") && !explicitLastFourDigits(item),
      createdAt: item?.createdAt || now,
      updatedAt: item?.updatedAt || item?.createdAt || now
    };
  }

  function normalizeV11Operation(item, fallbackAccountId = "", index = 0) {
    return {
      ...item,
      id: item?.id || `operation-${index + 1}`,
      accountId: item?.accountId || fallbackAccountId,
      cardId: "",
      type: normalizeOperationType(item?.type),
      amount: Number(item?.amount || 0),
      category: item?.category || (item?.type === "initial_balance" ? "Начальный остаток" : "Другое"),
      description: item?.description || item?.note || "",
      note: item?.note || item?.description || "",
      date: item?.date || isoToday(),
      createdAt: item?.createdAt || item?.date || isoToday()
    };
  }

  function normalizeV11Card(item, index = 0) {
    const now = isoToday();
    const lastFourDigits = explicitLastFourDigits(item);
    return {
      id: item?.id || `card-${index + 1}`,
      accountId: item?.accountId || "",
      name: item?.name || "Карта",
      lastFourDigits,
      paymentSystem: normalizePaymentSystem(item?.paymentSystem),
      cardType: normalizeCardType(item?.cardType),
      isVirtual: item?.isVirtual === true,
      expirationDate: item?.expirationDate || "",
      creditLimit: Math.max(0, Number(item?.creditLimit || 0)),
      isPrimary: item?.isPrimary !== false,
      isArchived: item?.isArchived === true,
      color: item?.color || "",
      isLegacy: item?.isLegacy === true,
      isMigrated: item?.isMigrated === true,
      numberMissing: item?.numberMissing === true || !lastFourDigits,
      createdAt: item?.createdAt || now,
      updatedAt: item?.updatedAt || item?.createdAt || now
    };
  }

  function initialBalanceOperation(account, item) {
    const date = account.createdAt || item?.createdAt || isoToday();
    return {
      id: initialBalanceOperationId(account.id),
      accountId: account.id,
      cardId: "",
      type: "initial_balance",
      amount: legacyOpeningBalance(item),
      category: "Начальный остаток",
      description: "Перенесено из старого стартового баланса",
      note: "Перенесено из старого стартового баланса",
      date,
      isInitialBalance: true,
      createdAt: date
    };
  }

  function ensureInitialBalances(data, legacyAccounts, accounts) {
    const existingInitialAccounts = new Set(
      data.operations
        .filter(operation => operation.type === "initial_balance")
        .map(operation => operation.accountId)
    );
    legacyAccounts.forEach((item, index) => {
      const account = accounts[index];
      if (!account || !hasLegacyOpeningBalance(item) || existingInitialAccounts.has(account.id)) return;
      data.operations.push(initialBalanceOperation(account, item));
      existingInitialAccounts.add(account.id);
    });
  }

  function normalizeInitialBalanceIds(operations) {
    const seen = new Set();
    return operations.filter(operation => {
      if (operation.type !== "initial_balance") return true;
      if (seen.has(operation.accountId)) return false;
      seen.add(operation.accountId);
      operation.id = initialBalanceOperationId(operation.accountId);
      operation.cardId = "";
      operation.isInitialBalance = true;
      return true;
    });
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
    },
    10(data) {
      data.settings ||= {};
      data.accounts = Array.isArray(data.accounts) ? data.accounts : [];
      data.operations = Array.isArray(data.operations) ? data.operations : [];
      data.transfers = Array.isArray(data.transfers) ? data.transfers : [];
      data.recurring = Array.isArray(data.recurring) ? data.recurring : [];
      data.debts = Array.isArray(data.debts) ? data.debts : [];

      const legacyAccounts = data.accounts.map(item => ({ ...item }));
      const legacyCardAccountIds = new Set(
        legacyAccounts.filter(item => item?.type === "card").map(item => item.id).filter(Boolean)
      );

      data.accounts = legacyAccounts.map((item, index) => normalizeV11Account(item, index, data.settings));
      if (!data.accounts.length) {
        data.accounts = [normalizeV11Account({ id: "account-main", name: "Основной счёт", type: "current" }, 0, data.settings)];
      }
      const accountIds = new Set(data.accounts.map(account => account.id));
      const fallbackAccountId = data.accounts[0].id;

      const cards = (Array.isArray(data.cards) ? data.cards : [])
        .map((item, index) => normalizeV11Card(item, index))
        .filter(card => accountIds.has(card.accountId));
      const cardIds = new Set(cards.map(card => card.id));

      legacyAccounts.forEach(item => {
        if (item?.type !== "card" || !accountIds.has(item.id)) return;
        const existingForAccount = cards.filter(card => card.accountId === item.id);
        if (existingForAccount.length) return;
        const lastFourDigits = explicitLastFourDigits(item);
        const card = normalizeV11Card({
          id: `card:${item.id}:legacy`,
          accountId: item.id,
          name: item.cardName || item.name || "Карта без номера",
          lastFourDigits,
          paymentSystem: item.paymentSystem || "other",
          cardType: item.cardType || "debit",
          isPrimary: true,
          isArchived: item.isArchived === true,
          color: item.color || "",
          isLegacy: true,
          isMigrated: true,
          numberMissing: !lastFourDigits,
          createdAt: item.createdAt || isoToday(),
          updatedAt: item.updatedAt || item.createdAt || isoToday()
        }, cards.length);
        if (!cardIds.has(card.id)) {
          cards.push(card);
          cardIds.add(card.id);
        }
      });

      data.cards = cards;
      const cardsByAccount = data.cards.reduce((map, card) => {
        (map[card.accountId] ||= []).push(card);
        return map;
      }, {});

      data.operations = data.operations.map((item, index) => {
        const operation = normalizeV11Operation(item, fallbackAccountId, index);
        if (!accountIds.has(operation.accountId)) operation.accountId = fallbackAccountId;
        if (!cardIds.has(operation.cardId)) operation.cardId = "";
        const accountCards = cardsByAccount[operation.accountId] || [];
        if (!operation.cardId
          && legacyCardAccountIds.has(operation.accountId)
          && accountCards.length === 1
          && (operation.type === "income" || operation.type === "expense" || operation.type === "fee")) {
          operation.cardId = accountCards[0].id;
        }
        operation.account = data.accounts.find(account => account.id === operation.accountId)?.name || "";
        return operation;
      });

      ensureInitialBalances(data, legacyAccounts, data.accounts);
      data.operations = normalizeInitialBalanceIds(data.operations);

      data.transfers = data.transfers
        .map((item, index) => ({
          id: item.id || `transfer-${index + 1}`,
          fromAccountId: item.fromAccountId || item.from,
          toAccountId: item.toAccountId || item.to,
          amount: Number(item.amount || 0),
          fee: Math.max(0, Number(item.fee || 0)),
          date: item.date || isoToday(),
          note: item.note || item.comment || "",
          comment: item.comment || item.note || ""
        }))
        .filter(item => item.amount > 0
          && item.fromAccountId !== item.toAccountId
          && accountIds.has(item.fromAccountId)
          && accountIds.has(item.toAccountId));

      data.settings.openingBalance = 0;
      return data;
    },
    11(data) {
      data.settings ||= {};
      data.accounts = Array.isArray(data.accounts) ? data.accounts : [];
      data.operations = Array.isArray(data.operations) ? data.operations : [];
      data.transfers = Array.isArray(data.transfers) ? data.transfers : [];
      data.recurring = Array.isArray(data.recurring) ? data.recurring : [];
      data.debts = Array.isArray(data.debts) ? data.debts : [];

      const cards = Array.isArray(data.cards) ? data.cards.map((item, index) => normalizeV11Card(item, index)) : [];
      const cardsByAccount = cards.reduce((map, card) => {
        (map[card.accountId] ||= []).push(card);
        return map;
      }, {});

      const legacyAccounts = data.accounts.map(item => ({ ...item }));
      data.accounts = legacyAccounts.map((item, index) => {
        const accountCards = (cardsByAccount[item?.id] || [])
          .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || String(a.createdAt).localeCompare(String(b.createdAt)));
        const primaryCard = accountCards[0] || null;
        const account = normalizeV11Account({
          ...item,
          ...(primaryCard ? {
            lastFourDigits: primaryCard.lastFourDigits,
            paymentSystem: primaryCard.paymentSystem,
            isVirtual: primaryCard.isVirtual,
            expirationDate: primaryCard.expirationDate,
            creditLimit: primaryCard.creditLimit,
            color: primaryCard.color || item?.color || "",
            isLegacy: primaryCard.isLegacy,
            isMigrated: primaryCard.isMigrated,
            numberMissing: primaryCard.numberMissing
          } : {})
        }, index, data.settings);
        if (primaryCard && ["current", "card", "credit", "debit_card", "credit_card"].includes(item?.type)) {
          account.type = primaryCard.cardType === "credit" || item?.type === "credit" ? "credit_card" : "debit_card";
          account.allowNegativeBalance = account.type === "credit_card" || item?.allowNegativeBalance === true;
          account.creditLimit = account.type === "credit_card" ? Math.max(0, Number(primaryCard.creditLimit || item?.creditLimit || 0)) : 0;
          account.numberMissing = primaryCard.numberMissing === true || !primaryCard.lastFourDigits;
        }
        return account;
      });

      if (!data.accounts.length) {
        data.accounts = [normalizeV11Account({ id: "account-main", name: "Основная карта", type: "debit_card" }, 0, data.settings)];
      }

      const accountIds = new Set(data.accounts.map(account => account.id));
      const fallbackAccountId = data.accounts[0].id;
      data.operations = data.operations.map((item, index) => {
        const operation = normalizeV11Operation(item, fallbackAccountId, index);
        if (!accountIds.has(operation.accountId)) operation.accountId = fallbackAccountId;
        operation.cardId = "";
        operation.account = data.accounts.find(account => account.id === operation.accountId)?.name || "";
        return operation;
      });
      ensureInitialBalances(data, legacyAccounts, data.accounts);
      data.operations = normalizeInitialBalanceIds(data.operations);
      data.transfers = data.transfers
        .map((item, index) => ({
          id: item.id || `transfer-${index + 1}`,
          fromAccountId: item.fromAccountId || item.from,
          toAccountId: item.toAccountId || item.to,
          amount: Number(item.amount || 0),
          fee: Math.max(0, Number(item.fee || 0)),
          date: item.date || isoToday(),
          note: item.note || item.comment || "",
          comment: item.comment || item.note || "",
          createdAt: item.createdAt || item.date || isoToday()
        }))
        .filter(item => item.amount > 0
          && item.fromAccountId !== item.toAccountId
          && accountIds.has(item.fromAccountId)
          && accountIds.has(item.toAccountId));
      data.recurring = data.recurring.map(item => ({
        ...item,
        accountId: accountIds.has(item.accountId) ? item.accountId : fallbackAccountId
      }));
      data.cards = [];
      data.settings.openingBalance = 0;
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
