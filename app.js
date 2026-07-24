const STORAGE_KEY = "kopilka_finance_v2";
const LEGACY_KEY = "finance_cabinet_v1";
const PROFILE_REGISTRY_KEY = "kopilka_profiles_v1";
const ACTIVE_PROFILE_KEY = "kopilka_active_profile_v1";
const PROFILE_STORAGE_PREFIX = "kopilka_profile_v1:";
const LEGACY_LOCAL_KEYS = [STORAGE_KEY, LEGACY_KEY, PROFILE_REGISTRY_KEY, ACTIVE_PROFILE_KEY];
const API_BASE = "";
const AUTH_MODE_LOGIN = "login";
const AUTH_MODE_REGISTER = "register";
const { CURRENT_SCHEMA_VERSION, migrateData } = KopilkaMigrations;
const { roundMoney, calculateAccountBalance, simulateDebtStrategy } = KopilkaFinance;
const {
  randomBytes,
  bytesToBase64,
  base64ToBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  createSecretHash,
  verifySecret,
  isStrongPassword,
  needsHashUpgrade,
  encryptPayload,
  decryptPayload,
  encryptWithRawKey,
  decryptWithRawKey,
  wrapVaultKey,
  unwrapVaultKey
} = KopilkaSecurity;

const DEFAULT_STATE = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  settings: {
    login: "",
    passwordHash: "",
    pinHash: "",
    biometricCredential: null,
    autoLockMinutes: 5,
    lockOnHide: true,
    encryptedAtRest: false,
    vaultPasswordWrap: null,
    vaultPinWrap: null,
    name: "",
    email: "",
    avatar: "",
    profileCreated: false,
    currency: "₽",
    openingBalance: 0,
    reserveTarget: 300000,
    reserveSaved: 0,
    theme: "light"
  },
  categories: {
    income: ["Зарплата", "Подработка", "Подарок", "Возврат", "Продажа", "Другое"],
    expense: ["Продукты", "Транспорт", "Дом", "Здоровье", "Развлечения", "Подписки", "Одежда", "Образование", "Другое"]
  },
  accounts: [{
    id: "account-main",
    name: "Основная карта",
    type: "card",
    openingBalance: 0,
    createdAt: ""
  }],
  transfers: [],
  recurring: [],
  operations: [],
  debts: []
};

const categoryVisuals = {
  "Зарплата": ["₽", "mint"], "Подработка": ["↗", "lilac"], "Подарок": ["◇", "sunshine"],
  "Возврат": ["↩", "sky"], "Продажа": ["□", "mint"], "Продукты": ["◒", "coral"],
  "Транспорт": ["➜", "sky"], "Дом": ["⌂", "lilac"], "Здоровье": ["＋", "mint"],
  "Развлечения": ["☆", "sunshine"], "Подписки": ["▣", "lilac"], "Одежда": ["♢", "coral"],
  "Образование": ["⌁", "sky"], "Другое": ["•", "sunshine"]
};

const pageMeta = {
  dashboard: ["Ваш финансовый центр", "Добрый день!"],
  operations: ["Полная история денег", "Операции"],
  recurring: ["Финансы на автопилоте", "Регулярные"],
  accounts: ["Ваши деньги по местам", "Счета и карты"],
  debts: ["План спокойного погашения", "Долги"],
  calendar: ["Все даты под контролем", "Календарь платежей"],
  analytics: ["Цифры становятся понятнее", "Аналитика"],
  settings: ["Всё под вашим контролем", "Настройки"]
};

let activeProfileId = "";
let currentUser = null;
let remoteRevision = 0;
let authMode = AUTH_MODE_LOGIN;
let authErrorText = "";
let pendingEncryptedProfile = null;
let vaultKeyBytes = null;
let persistenceQueue = Promise.resolve();
let state = loadState();
let operationFilter = "all";
let privacyMode = false;
let installPrompt = null;
let toastTimer = null;
let appUnlocked = false;
let lastActivityAt = Date.now();
let hiddenAt = 0;
let failedUnlockAttempts = 0;
let pendingEncryptedBackup = null;
let frozenScrollY = 0;
let viewportFreezeOwner = "";
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const UNLOCK_ATTEMPT_LIMIT = 5;
const UNLOCK_LOCKOUT_MS = 30000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function freezeViewport(owner) {
  const root = document.documentElement;
  if (!root.classList.contains("viewport-locked")) {
    frozenScrollY = Math.max(0, window.scrollY || 0);
    document.body.style.top = `-${frozenScrollY}px`;
    root.classList.add("viewport-locked");
  }
  viewportFreezeOwner = owner;
}

function releaseViewport(owner) {
  if (!document.documentElement.classList.contains("viewport-locked")) return;
  if (viewportFreezeOwner && owner && viewportFreezeOwner !== owner) return;
  const scrollY = frozenScrollY;
  document.documentElement.classList.remove("viewport-locked");
  document.body.style.top = "";
  viewportFreezeOwner = "";
  frozenScrollY = 0;
  window.scrollTo(0, scrollY);
}

function isoToday() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (!value) return new Date();
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateToIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey(date = new Date()) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(date, offset) {
  const value = new Date(date);
  value.setDate(1);
  value.setMonth(value.getMonth() + offset);
  return value;
}

function formatDate(value, short = false) {
  if (!value) return "Без даты";
  return parseDate(value).toLocaleDateString("ru-RU", short
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "long", year: "numeric" });
}

function money(value, compact = false) {
  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: compact ? 0 : 2,
    minimumFractionDigits: 0
  }).format(Number(value) || 0)} ${state.settings.currency}`;
}

function plural(number, forms) {
  const n = Math.abs(Number(number)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function bankRound(value, debt) {
  const factor = debt?.rounding === "rubles" ? 1 : 100;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

function normalizeDebtRecord(item) {
  const balance = Number(item.balance ?? item.bal ?? 0);
  const firstPaymentDate = item.firstPaymentDate || item.firstDate || item.firstPayDate || item.date || "";
  const paymentsMade = Math.max(0, Number(item.paymentsMade || 0));
  return {
    id: item.id || uid(),
    kind: item.kind === "debt" ? "personal" : (item.kind || "credit"),
    name: item.name || "Обязательство",
    balance,
    originalBalance: Number(item.originalBalance ?? item.start ?? balance),
    payment: Number(item.payment ?? item.pay ?? 0),
    rate: Number(item.rate || 0),
    repaymentType: item.repaymentType || "annuity",
    rounding: item.rounding || "kopecks",
    monthlyFee: Number(item.monthlyFee || 0),
    paymentFeePercent: Number(item.paymentFeePercent || 0),
    penaltyRateDaily: Number(item.penaltyRateDaily || 0),
    termPayments: Math.max(0, Number(item.termPayments ?? item.term ?? 0)),
    paymentsMade,
    issueDate: item.issueDate || item.created || item.startDate || "",
    firstPaymentDate,
    firstPaymentAmount: Number(item.firstPaymentAmount ?? item.firstPay ?? 0),
    paymentHistory: Array.isArray(item.paymentHistory) ? item.paymentHistory : [],
    date: item.date || (firstPaymentDate ? addMonthsIso(firstPaymentDate, paymentsMade) : "")
  };
}

function normalizeAccount(item, index = 0) {
  const allowedTypes = ["card", "cash", "savings"];
  return {
    id: item?.id || `account-${index + 1}-${uid()}`,
    name: String(item?.name || (index === 0 ? "Основная карта" : "Счёт")),
    type: allowedTypes.includes(item?.type) ? item.type : "card",
    openingBalance: Number(item?.openingBalance ?? item?.balance ?? 0),
    createdAt: item?.createdAt || isoToday()
  };
}

function recurringDefaults(kind) {
  if (kind === "salary") return { type: "income", category: "Зарплата", name: "Зарплата" };
  if (kind === "subscription") return { type: "expense", category: "Подписки", name: "Подписка" };
  if (kind === "utilities") return { type: "expense", category: "Дом", name: "Коммунальные услуги" };
  return { type: "expense", category: "Другое", name: "Регулярная операция" };
}

function normalizeRecurringRecord(item, fallbackAccountId) {
  const defaults = recurringDefaults(item?.kind || "other");
  const nextDate = item?.nextDate || item?.date || isoToday();
  const date = parseDate(nextDate);
  return {
    id: item?.id || uid(),
    kind: ["salary", "subscription", "utilities", "other"].includes(item?.kind) ? item.kind : "other",
    name: String(item?.name || defaults.name),
    type: item?.type === "income" ? "income" : (item?.type === "expense" ? "expense" : defaults.type),
    category: item?.category || defaults.category,
    amount: Number(item?.amount || 0),
    accountId: item?.accountId || fallbackAccountId,
    frequency: ["weekly", "monthly", "yearly"].includes(item?.frequency) ? item.frequency : "monthly",
    nextDate,
    remindDays: Math.max(0, Number(item?.remindDays ?? 3)),
    autoPost: item?.autoPost !== false,
    active: item?.active !== false,
    anchorDay: Number(item?.anchorDay || date.getDate()),
    anchorMonth: Number(item?.anchorMonth ?? date.getMonth()),
    lastProcessedDate: item?.lastProcessedDate || "",
    lastNotifiedDate: item?.lastNotifiedDate || "",
    createdAt: item?.createdAt || isoToday()
  };
}

function hydrateState(data = {}) {
  const settings = { ...DEFAULT_STATE.settings, ...(data.settings || {}) };
  const operations = (Array.isArray(data.operations) ? data.operations : []).map(item => ({
    ...item,
    id: item.id || uid(),
    type: item.type === "income" ? "income" : "expense",
    amount: Number(item.amount || 0),
    category: item.category || "Другое",
    date: item.date || isoToday(),
    note: item.note || ""
  }));
  const savedAccounts = Array.isArray(data.accounts) ? data.accounts : [];
  let accounts;

  if (savedAccounts.length) {
    accounts = savedAccounts.map(normalizeAccount);
  } else {
    const legacyNames = [...new Set(operations.map(item => String(item.account || "").trim()).filter(Boolean))];
    accounts = (legacyNames.length ? legacyNames : ["Основная карта"]).map((name, index) => normalizeAccount({
      id: index === 0 ? "account-main" : "",
      name,
      type: index === 0 ? "card" : "cash",
      openingBalance: index === 0 ? Number(settings.openingBalance || 0) : 0
    }, index));
  }

  const accountIds = new Set(accounts.map(account => account.id));
  operations.forEach(operation => {
    const byLegacyName = accounts.find(account => account.name === String(operation.account || "").trim());
    operation.accountId = accountIds.has(operation.accountId)
      ? operation.accountId
      : (byLegacyName?.id || accounts[0].id);
    operation.account = accounts.find(account => account.id === operation.accountId)?.name || accounts[0].name;
  });

  const transfers = (Array.isArray(data.transfers) ? data.transfers : [])
    .map(item => ({
      id: item.id || uid(),
      fromAccountId: item.fromAccountId || item.from,
      toAccountId: item.toAccountId || item.to,
      amount: Number(item.amount || 0),
      date: item.date || isoToday(),
      note: item.note || ""
    }))
    .filter(item => item.amount > 0 && item.fromAccountId !== item.toAccountId
      && accountIds.has(item.fromAccountId) && accountIds.has(item.toAccountId));
  const recurring = (Array.isArray(data.recurring) ? data.recurring : [])
    .map(item => normalizeRecurringRecord(item, accounts[0].id))
    .map(item => ({ ...item, accountId: accountIds.has(item.accountId) ? item.accountId : accounts[0].id }))
    .filter(item => item.amount > 0);

  settings.openingBalance = Number(accounts[0]?.openingBalance || 0);
  if (data.settings?.profileCreated === undefined) {
    settings.profileCreated = Boolean(settings.login || settings.name || operations.length || (data.debts || []).length);
  }

  return {
    ...clone(DEFAULT_STATE),
    ...data,
    settings,
    categories: { ...DEFAULT_STATE.categories, ...(data.categories || {}) },
    accounts,
    transfers,
    recurring,
    operations,
    debts: (Array.isArray(data.debts) ? data.debts : []).map(normalizeDebtRecord),
    schemaVersion: CURRENT_SCHEMA_VERSION
  };
}

function monthlyInterestRate(debt) {
  return Math.max(0, Number(debt.rate || 0)) / 100 / 12;
}

function calculatedRegularPayment(debt) {
  if (Number(debt.payment || 0) > 0) return bankRound(debt.payment, debt);
  const balance = Math.max(0, Number(debt.balance || 0));
  const remaining = Math.max(1, Number(debt.termPayments || 0) - Number(debt.paymentsMade || 0));
  const rate = monthlyInterestRate(debt);
  if (debt.repaymentType === "differentiated") {
    return bankRound(balance / remaining + balance * rate, debt);
  }
  if (rate <= 0) return bankRound(balance / remaining, debt);
  const factor = Math.pow(1 + rate, remaining);
  return bankRound(balance * rate * factor / (factor - 1), debt);
}

function scheduledPaymentAmount(debt) {
  if (Number(debt.paymentsMade || 0) === 0 && Number(debt.firstPaymentAmount || 0) > 0) {
    return bankRound(debt.firstPaymentAmount, debt);
  }
  return calculatedRegularPayment(debt);
}

function commissionForPayment(debt, basePayment) {
  return bankRound(
    Math.max(0, Number(debt.monthlyFee || 0)) +
    Math.max(0, Number(basePayment || 0)) * Math.max(0, Number(debt.paymentFeePercent || 0)) / 100,
    debt
  );
}

function scheduledDateForPayment(debt) {
  const term = Number(debt.termPayments || 0);
  const made = Number(debt.paymentsMade || 0);
  if (term > 0 && made >= term) return "";
  const firstDate = debt.firstPaymentDate || debt.date;
  return firstDate ? addMonthsIso(firstDate, made) : "";
}

function overdueDays(debt) {
  const dueDate = scheduledDateForPayment(debt);
  if (!dueDate) return 0;
  return Math.max(0, Math.floor((parseDate(isoToday()) - parseDate(dueDate)) / 86400000));
}

function overduePenalty(debt) {
  const days = overdueDays(debt);
  return bankRound(
    Math.max(0, Number(debt.balance || 0)) * Math.max(0, Number(debt.penaltyRateDaily || 0)) / 100 * days,
    debt
  );
}

function recommendedPaymentAmount(debt) {
  return bankRound(scheduledPaymentAmount(debt) + overduePenalty(debt), debt);
}

function paymentBreakdown(debt, requestedAmount = recommendedPaymentAmount(debt)) {
  const balance = Math.max(0, Number(debt.balance || 0));
  const requested = Math.max(0, Number(requestedAmount || 0));
  const penaltyDue = overduePenalty(debt);
  const penaltyPaid = Math.min(requested, penaltyDue);
  const afterPenalty = Math.max(0, requested - penaltyPaid);
  const interestDue = bankRound(balance * monthlyInterestRate(debt), debt);
  const interestPaid = Math.min(afterPenalty, interestDue);
  const principal = Math.min(balance, Math.max(0, afterPenalty - interestPaid));
  const loanPayment = bankRound(penaltyPaid + interestPaid + principal, debt);
  const commission = commissionForPayment(debt, loanPayment);
  return {
    requested: bankRound(requested, debt),
    payment: loanPayment,
    total: bankRound(loanPayment + commission, debt),
    commission,
    penalty: bankRound(penaltyPaid, debt),
    penaltyDue,
    interest: bankRound(interestPaid, debt),
    interestDue,
    principal: bankRound(principal, debt),
    extra: bankRound(Math.max(0, requested - loanPayment), debt),
    newBalance: bankRound(Math.max(0, balance - principal), debt)
  };
}

function estimatedPaymentCount(debt) {
  let balance = Number(debt.balance || 0);
  let count = 0;
  while (balance > .01 && count < 600) {
    const simulated = { ...debt, balance, paymentsMade: Number(debt.paymentsMade || 0) + count };
    const split = paymentBreakdown(simulated);
    if (split.principal <= 0) return Infinity;
    balance = split.newBalance;
    count += 1;
  }
  return balance <= .01 ? count : Infinity;
}

function remainingPaymentCount(debt) {
  const term = Number(debt.termPayments || 0);
  if (term > 0) return Math.max(0, term - Number(debt.paymentsMade || 0));
  return estimatedPaymentCount(debt);
}

function nextPaymentDate(debt) {
  if (Number(debt.balance || 0) <= 0) return "";
  const remaining = remainingPaymentCount(debt);
  if (remaining === 0) return "";
  return scheduledDateForPayment(debt);
}

function remainingScheduleTotal(debt) {
  const count = remainingPaymentCount(debt);
  if (!Number.isFinite(count)) return null;
  let balance = Number(debt.balance || 0);
  let total = 0;
  for (let index = 0; index < Math.min(count, 600) && balance > .01; index += 1) {
    const simulated = { ...debt, balance, paymentsMade: Number(debt.paymentsMade || 0) + index };
    const split = paymentBreakdown(simulated);
    total += split.total;
    balance = split.newBalance;
    if (split.principal <= 0) return null;
  }
  return { total: bankRound(total, debt), balanceAfterSchedule: bankRound(balance, debt) };
}

function migrateLegacy(legacy) {
  return hydrateState(migrateData({
    settings: {
      profileCreated: true,
      currency: legacy.settings?.currency || "₽",
      openingBalance: Number(legacy.settings?.opening || 0),
      reserveTarget: Number(legacy.settings?.reserve || 300000)
    },
    operations: (legacy.ops || []).map(item => ({
      id: item.id || uid(),
      type: item.type === "income" ? "income" : "expense",
      amount: Number(item.sum || 0),
      category: item.cat || "Другое",
      account: item.acc || "",
      note: item.note || "",
      date: item.date || isoToday()
    })),
    debts: legacy.debts || []
  }));
}

function profileStorageKey(profileId) {
  return `${PROFILE_STORAGE_PREFIX}${profileId}`;
}

function purgeLegacyLocalAccounts() {
  try {
    LEGACY_LOCAL_KEYS.forEach(key => localStorage.removeItem(key));
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(PROFILE_STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch (error) {
    console.warn("Не удалось очистить старые локальные аккаунты", error);
  }
}

function profileSummary(profileId, profileState = state) {
  const login = currentUser?.login || profileState.settings.login || profileState.settings.name || "Пользователь";
  return {
    id: profileId || currentUser?.id || "",
    login,
    name: currentUser?.name || profileState.settings.name || login,
    avatar: currentUser?.avatar || profileState.settings.avatar || "",
    autoLockMinutes: Number(profileState.settings.autoLockMinutes || 5),
    lockOnHide: profileState.settings.lockOnHide !== false,
    theme: profileState.settings.theme || "light",
    encryptedAtRest: true,
    vaultPasswordWrap: profileState.settings.vaultPasswordWrap || null,
    updatedAt: new Date().toISOString()
  };
}

function lockedProfileState(summary = {}) {
  const lockedState = clone(DEFAULT_STATE);
  lockedState.settings = {
    ...lockedState.settings,
    login: summary.login || "",
    name: summary.name || summary.login || "",
    avatar: summary.avatar || "",
    autoLockMinutes: Number(summary.autoLockMinutes || 5),
    lockOnHide: summary.lockOnHide !== false,
    theme: summary.theme || "light",
    encryptedAtRest: true,
    vaultPasswordWrap: summary.vaultPasswordWrap || null,
    profileCreated: true
  };
  return lockedState;
}

function upsertCurrentProfile() {
  saveState();
}

function loadState() {
  purgeLegacyLocalAccounts();
  return clone(DEFAULT_STATE);
}

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== "string" && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(apiUrl(path), {
      ...options,
      headers,
      body,
      credentials: "include"
    });
  } catch (error) {
    const message = location.protocol === "file:"
      ? "Откройте приложение через серверный адрес. После перехода на серверные аккаунты режим file:// больше не подходит."
      : "Сервер авторизации недоступен. Проверьте, что backend запущен.";
    const requestError = new Error(message);
    requestError.code = "NETWORK_ERROR";
    throw requestError;
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      const parseError = new Error("Серверная часть не отвечает как API. Проверьте, что приложение запущено через Node.js backend, а не только как статические файлы.");
      parseError.code = "BAD_API_RESPONSE";
      throw parseError;
    }
  }
  if (!response.ok) {
    const error = new Error(data.message || "Сервер вернул ошибку");
    error.code = data.code || "SERVER_ERROR";
    error.payload = data;
    throw error;
  }
  return data;
}

function remoteVaultFromPayload(payload) {
  const vault = payload?.vault || null;
  if (!vault?.envelope || !vault?.wrap) return null;
  return vault;
}

function applyRemoteEnvelope(payload) {
  currentUser = payload?.user || null;
  activeProfileId = currentUser?.id || "";
  const vault = remoteVaultFromPayload(payload);
  remoteRevision = Number(vault?.revision || 0);
  if (currentUser && vault) {
    pendingEncryptedProfile = vault.envelope;
    vaultKeyBytes = null;
    state = lockedProfileState({
      id: currentUser.id,
      login: currentUser.login,
      name: currentUser.name,
      avatar: currentUser.avatar,
      encryptedAtRest: true,
      vaultPasswordWrap: vault.wrap
    });
    return true;
  }
  pendingEncryptedProfile = null;
  vaultKeyBytes = null;
  state = clone(DEFAULT_STATE);
  return false;
}

function prepareStateForRemote(profileState = state) {
  const snapshot = hydrateState(migrateData(profileState));
  snapshot.schemaVersion = CURRENT_SCHEMA_VERSION;
  if (currentUser?.id) {
    snapshot.settings.profileCreated = true;
    snapshot.settings.login = currentUser.login || snapshot.settings.login;
    snapshot.settings.name = snapshot.settings.name || currentUser.name || snapshot.settings.login;
    snapshot.settings.encryptedAtRest = true;
  }
  return snapshot;
}

function saveState() {
  state = prepareStateForRemote(state);
  if (!currentUser?.id || pendingEncryptedProfile || !vaultKeyBytes) return persistenceQueue;
  const snapshot = clone(state);
  const keySnapshot = new Uint8Array(vaultKeyBytes);
  const writeJob = persistenceQueue
    .catch(() => undefined)
    .then(async () => {
      const envelope = await encryptWithRawKey(snapshot, keySnapshot);
      const result = await apiRequest("/api/vault", {
        method: "PUT",
        body: {
          revision: remoteRevision,
          envelope,
          wrap: snapshot.settings.vaultPasswordWrap,
          profile: {
            name: snapshot.settings.name,
            avatar: snapshot.settings.avatar
          }
        }
      });
      remoteRevision = Number(result.vault?.revision || remoteRevision);
      pendingEncryptedProfile = null;
      if (currentUser) {
        currentUser.name = snapshot.settings.name;
        currentUser.avatar = snapshot.settings.avatar;
      }
      authErrorText = "";
      return result;
    });
  persistenceQueue = writeJob.catch(error => {
    console.warn("Не удалось синхронизировать данные с сервером", error);
    if (error.code === "VAULT_CONFLICT") {
      authErrorText = "Данные изменились на другом устройстве. Обновите страницу, чтобы получить свежую версию.";
      showToast(authErrorText);
      return;
    }
    authErrorText = error.message || "Не удалось сохранить данные на сервере";
    showToast(authErrorText);
  });
  return writeJob;
}

async function enableEncryptedStorage(password) {
  vaultKeyBytes = randomBytes(32);
  state.settings.encryptedAtRest = true;
  state.settings.vaultPasswordWrap = await wrapVaultKey(vaultKeyBytes, password);
  state.settings.vaultPinWrap = null;
  await saveState();
}

async function openEncryptedProfile(password) {
  if (!pendingEncryptedProfile) return;
  const wrapper = state.settings.vaultPasswordWrap;
  if (!wrapper) throw new Error("VAULT_KEY_MISSING");
  const key = await unwrapVaultKey(wrapper, password);
  const decrypted = await decryptWithRawKey(pendingEncryptedProfile, key);
  state = hydrateState(migrateData(decrypted));
  state = prepareStateForRemote(state);
  vaultKeyBytes = key;
  pendingEncryptedProfile = null;
  if (currentUser) {
    currentUser.name = state.settings.name || currentUser.login;
    currentUser.avatar = state.settings.avatar || "";
  }
  processRecurringOperations();
  renderAll();
}

function hasAppProtection() {
  return Boolean(
    pendingEncryptedProfile
    || state.settings.encryptedAtRest
    || state.settings.passwordHash
    || state.settings.pinHash
    || state.settings.biometricCredential?.id
  );
}

function unlockGuardKey() {
  return `kopilka_unlock_guard:${currentUser?.id || activeProfileId || "server"}`;
}

function readUnlockGuard() {
  try {
    const guard = JSON.parse(sessionStorage.getItem(unlockGuardKey()) || "{}");
    return {
      attempts: Math.max(0, Number(guard.attempts || 0)),
      blockedUntil: Math.max(0, Number(guard.blockedUntil || 0))
    };
  } catch (error) {
    return { attempts: failedUnlockAttempts, blockedUntil: 0 };
  }
}

function writeUnlockGuard(guard) {
  failedUnlockAttempts = guard.attempts;
  try {
    sessionStorage.setItem(unlockGuardKey(), JSON.stringify(guard));
  } catch (error) {
    // Ограничение остаётся в памяти, если хранилище вкладки недоступно.
  }
}

function resetUnlockGuard() {
  failedUnlockAttempts = 0;
  try {
    sessionStorage.removeItem(unlockGuardKey());
  } catch (error) {
    // Нечего очищать.
  }
}

function recordFailedUnlock() {
  const guard = readUnlockGuard();
  guard.attempts += 1;
  if (guard.attempts >= UNLOCK_ATTEMPT_LIMIT) {
    const level = Math.floor((guard.attempts - UNLOCK_ATTEMPT_LIMIT) / 2);
    const lockout = Math.min(5 * 60000, UNLOCK_LOCKOUT_MS * Math.pow(2, level));
    guard.blockedUntil = Date.now() + lockout;
  }
  writeUnlockGuard(guard);
  return guard;
}

function unlockApp() {
  appUnlocked = true;
  resetUnlockGuard();
  lastActivityAt = Date.now();
  document.querySelector("#appLock").hidden = true;
  document.querySelector("#lockError").textContent = "";
  document.querySelector("#unlockCode").value = "";
  document.body.style.overflow = "";
  releaseViewport("lock");
}

function renderLockProfiles() {
  const container = document.querySelector("#lockProfileSwitch");
  container.hidden = true;
  document.querySelector("#lockProfileList").innerHTML = "";
}

function lockApp() {
  if (!state.settings.profileCreated || !hasAppProtection()) return;
  appUnlocked = false;
  closeModal();
  hideOnboarding();
  const lock = document.querySelector("#appLock");
  lock.hidden = false;
  document.querySelector("#lockGreeting").textContent =
    pendingEncryptedProfile
      ? `${state.settings.login || state.settings.name || "Пользователь"}, введите пароль для расшифровки данных.`
      : `${state.settings.login || state.settings.name || "Пользователь"}, введите пароль или PIN-код.`;
  document.querySelector("#unlockMethodLabel").textContent =
    pendingEncryptedProfile ? "Пароль" : "Пароль или PIN";
  document.querySelector("#unlockCode").placeholder =
    pendingEncryptedProfile ? "Введите пароль" : "Введите код";
  document.querySelector("#biometricUnlockButton").hidden =
    !state.settings.biometricCredential?.id || Boolean(pendingEncryptedProfile);
  updateBiometricLockState();
  document.querySelector("#lockError").textContent = "";
  document.querySelector("#unlockCode").value = "";
  renderLockProfiles();
  document.body.style.overflow = "hidden";
  freezeViewport("lock");
  setTimeout(() => document.querySelector("#unlockCode").focus(), 80);
}

function syncAccessState() {
  if (!state.settings.profileCreated) {
    appUnlocked = true;
    document.querySelector("#appLock").hidden = true;
    syncOnboardingVisibility();
    return;
  }
  hideOnboarding();
  if (hasAppProtection()) lockApp();
  else unlockApp();
}

function concatBytes(...chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  chunks.forEach(chunk => {
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
}

function derToRawSignature(signature, size = 32) {
  const bytes = new Uint8Array(signature);
  if (bytes.length === size * 2) return bytes;
  if (bytes[0] !== 0x30) throw new Error("Неверный формат подписи");
  let offset = bytes[1] & 0x80 ? 2 + (bytes[1] & 0x7f) : 2;
  if (bytes[offset++] !== 0x02) throw new Error("Неверная подпись");
  const rLength = bytes[offset++];
  let r = bytes.slice(offset, offset + rLength);
  offset += rLength;
  if (bytes[offset++] !== 0x02) throw new Error("Неверная подпись");
  const sLength = bytes[offset++];
  let s = bytes.slice(offset, offset + sLength);
  while (r.length > size && r[0] === 0) r = r.slice(1);
  while (s.length > size && s[0] === 0) s = s.slice(1);
  const raw = new Uint8Array(size * 2);
  raw.set(r, size - r.length);
  raw.set(s, size * 2 - s.length);
  return raw;
}

async function biometricSupported() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) return false;
  if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
}

async function updateBiometricLockState() {
  const button = document.querySelector("#biometricUnlockButton");
  const hint = document.querySelector("#biometricLockHint");
  if (pendingEncryptedProfile) {
    button.hidden = true;
    hint.textContent = "После полного перезапуска сначала нужен пароль для расшифровки базы.";
    return;
  }
  if (!window.isSecureContext) {
    button.hidden = true;
    hint.textContent = "Биометрия доступна только на сайте с защищённым HTTPS-соединением.";
    return;
  }
  if (!state.settings.biometricCredential?.id) {
    button.hidden = true;
    hint.textContent = "";
    return;
  }
  const supported = await biometricSupported();
  if (document.querySelector("#appLock").hidden) return;
  button.hidden = !supported;
  hint.textContent = supported
    ? "Биометрия привязана к этому устройству и адресу сайта."
    : "Браузер или устройство сейчас не предоставляют биометрический вход.";
}

function biometricErrorMessage(error) {
  if (error?.name === "SecurityError") {
    return "Биометрия привязана к другому адресу сайта. Откройте настройки и подключите её заново.";
  }
  if (error?.name === "NotAllowedError") {
    return "Проверка Face ID или отпечатка отменена либо запрещена настройками устройства.";
  }
  return "Биометрия сейчас недоступна. Войдите по паролю или PIN-коду.";
}

async function registerBiometric() {
  if (!(await biometricSupported())) throw new Error("Биометрия недоступна на этом устройстве");
  const challenge = randomBytes(32);
  const userId = randomBytes(32);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Копилка" },
      user: {
        id: userId,
        name: state.settings.login || "kopilka-user",
        displayName: state.settings.name || state.settings.login || "Пользователь"
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        userVerification: "required"
      },
      timeout: 60000,
      attestation: "none"
    }
  });
  const publicKey = credential?.response?.getPublicKey?.();
  if (!credential || !publicKey) throw new Error("Браузер не передал ключ биометрии");
  state.settings.biometricCredential = {
    id: bytesToBase64Url(new Uint8Array(credential.rawId)),
    publicKey: bytesToBase64(new Uint8Array(publicKey)),
    algorithm: credential.response.getPublicKeyAlgorithm?.() || -7
  };
  saveState();
}

async function authenticateBiometric() {
  const saved = state.settings.biometricCredential;
  if (!saved?.id || !(await biometricSupported())) return false;
  const challenge = randomBytes(32);
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: "public-key", id: base64UrlToBytes(saved.id) }],
      userVerification: "required",
      timeout: 60000
    }
  });
  if (!assertion) return false;
  const clientData = JSON.parse(new TextDecoder().decode(assertion.response.clientDataJSON));
  if (clientData.type !== "webauthn.get"
    || clientData.challenge !== bytesToBase64Url(challenge)
    || clientData.origin !== location.origin) return false;
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", assertion.response.clientDataJSON));
  const signedData = concatBytes(new Uint8Array(assertion.response.authenticatorData), clientHash);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(saved.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    derToRawSignature(assertion.response.signature),
    signedData
  );
}

function accountById(id) {
  return state.accounts.find(account => account.id === id);
}

function accountName(id) {
  return accountById(id)?.name || "Основной счёт";
}

function accountTypeName(type) {
  return type === "cash" ? "Наличные" : type === "savings" ? "Накопительный счёт" : "Банковская карта";
}

function accountIcon(type) {
  return type === "cash" ? "₽" : type === "savings" ? "◇" : "▣";
}

function accountBalance(id) {
  const account = accountById(id);
  return calculateAccountBalance(account, state.operations, state.transfers);
}

function totalAccountsBalance() {
  return roundMoney(state.accounts.reduce((sum, account) => sum + accountBalance(account.id), 0));
}

function daysUntil(value) {
  return Math.round((parseDate(value) - parseDate(isoToday())) / 86400000);
}

function nextRecurringDate(item, fromDate = item.nextDate) {
  const date = parseDate(fromDate);
  if (item.frequency === "weekly") {
    date.setDate(date.getDate() + 7);
  } else if (item.frequency === "yearly") {
    const year = date.getFullYear() + 1;
    const month = Number(item.anchorMonth ?? date.getMonth());
    const lastDay = new Date(year, month + 1, 0).getDate();
    return dateToIso(new Date(year, month, Math.min(Number(item.anchorDay || date.getDate()), lastDay)));
  } else {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const lastDay = new Date(year, month + 1, 0).getDate();
    return dateToIso(new Date(year, month, Math.min(Number(item.anchorDay || date.getDate()), lastDay)));
  }
  return dateToIso(date);
}

function recurringFrequencyName(frequency) {
  return frequency === "weekly" ? "Каждую неделю" : frequency === "yearly" ? "Каждый год" : "Каждый месяц";
}

function recurringKindName(kind) {
  return kind === "salary" ? "Зарплата" : kind === "subscription" ? "Подписка" : kind === "utilities" ? "Коммунальные" : "Регулярная";
}

function reminderTimingName(days) {
  const value = Number(days || 0);
  return value === 0 ? "В день операции" : `За ${value} ${plural(value, ["день", "дня", "дней"])}`;
}

function recurringIcon(kind) {
  return kind === "salary" ? "₽" : kind === "subscription" ? "▣" : kind === "utilities" ? "⌂" : "↻";
}

function recurringMonthlyAmount(item) {
  return KopilkaFinance.recurringMonthlyAmount(item);
}

function createRecurringOperation(item, scheduledDate, manual = false) {
  if (state.operations.some(operation =>
    operation.recurringId === item.id && operation.recurrenceDate === scheduledDate
  )) return false;
  state.operations.push({
    id: uid(),
    type: item.type,
    amount: Number(item.amount || 0),
    category: item.category,
    date: manual && scheduledDate > isoToday() ? isoToday() : scheduledDate,
    accountId: item.accountId,
    account: accountName(item.accountId),
    note: `${manual ? "По расписанию" : "Автоматически"}: ${item.name}`,
    recurringId: item.id,
    recurrenceDate: scheduledDate
  });
  return true;
}

function processRecurringOperations() {
  let changed = false;
  state.recurring.forEach(item => {
    if (!item.active || !item.autoPost || !item.nextDate) return;
    let guard = 0;
    while (item.nextDate <= isoToday() && guard < 120) {
      const scheduledDate = item.nextDate;
      if (createRecurringOperation(item, scheduledDate)) changed = true;
      item.lastProcessedDate = scheduledDate;
      item.nextDate = nextRecurringDate(item, scheduledDate);
      item.lastNotifiedDate = "";
      changed = true;
      guard += 1;
    }
  });
  if (changed) saveState();
  return changed;
}

function recurringReminders() {
  return state.recurring
    .filter(item => item.active && item.nextDate && daysUntil(item.nextDate) <= Number(item.remindDays || 0))
    .sort((a, b) => String(a.nextDate).localeCompare(String(b.nextDate)));
}

function totals() {
  const currentMonth = monthKey();
  const previousMonth = monthKey(shiftMonth(new Date(), -1));
  let allIncome = 0;
  let allExpense = 0;
  let monthIncome = 0;
  let monthExpense = 0;
  let previousNet = 0;
  let incomeCount = 0;
  let expenseCount = 0;

  state.operations.forEach(operation => {
    const amount = Number(operation.amount || 0);
    const sign = operation.type === "income" ? 1 : -1;
    if (operation.type === "income") allIncome += amount;
    else allExpense += amount;
    if (String(operation.date).slice(0, 7) === currentMonth) {
      if (operation.type === "income") {
        monthIncome += amount;
        incomeCount += 1;
      } else {
        monthExpense += amount;
        expenseCount += 1;
      }
    }
    if (String(operation.date).slice(0, 7) === previousMonth) previousNet += sign * amount;
  });

  const debtTotal = state.debts.reduce((sum, debt) => sum + Number(debt.balance || 0), 0);
  const debtMonthly = state.debts.reduce(
    (sum, debt) => sum + (nextPaymentDate(debt) ? paymentBreakdown(debt).total : 0),
    0
  );
  const recurringMonthly = state.recurring
    .filter(item => item.active && item.type === "expense")
    .reduce((sum, item) => sum + recurringMonthlyAmount(item), 0);
  const balance = totalAccountsBalance();
  const net = monthIncome - monthExpense;
  const free = balance - debtMonthly - recurringMonthly - Number(state.settings.reserveSaved || 0);
  const savingRate = monthIncome > 0 ? Math.max(-100, Math.min(100, Math.round(net / monthIncome * 100))) : 0;
  const trend = previousNet === 0 ? 0 : Math.round((net - previousNet) / Math.abs(previousNet) * 100);

  return { balance, monthIncome, monthExpense, debtTotal, debtMonthly, recurringMonthly, free, savingRate, trend, incomeCount, expenseCount };
}

function getHealthScore(summary) {
  let score = 48;
  if (summary.monthIncome > 0) score += 12;
  if (summary.savingRate >= 20) score += 20;
  else if (summary.savingRate > 0) score += 10;
  else if (summary.monthExpense > summary.monthIncome) score -= 15;
  if (summary.free > 0) score += 10;
  else if (summary.free < 0) score -= 15;
  if (summary.debtTotal === 0) score += 10;
  else if (summary.debtMonthly > summary.monthIncome * .35 && summary.monthIncome > 0) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function visualFor(category, type) {
  return categoryVisuals[category] || [type === "income" ? "↗" : "↘", type === "income" ? "mint" : "coral"];
}

function renderDashboard() {
  const summary = totals();
  const score = getHealthScore(summary);
  const name = state.settings.name.trim();
  if (document.querySelector("#dashboard").classList.contains("active")) {
    document.querySelector("#pageTitle").textContent = name ? `Добрый день, ${name}!` : "Добрый день!";
  }
  document.querySelector("#balanceValue").textContent = money(summary.balance);
  document.querySelector("#heroIncome").textContent = `+ ${money(summary.monthIncome)}`;
  document.querySelector("#heroExpense").textContent = `− ${money(summary.monthExpense)}`;
  document.querySelector("#balanceTrend").innerHTML = `<span>${summary.trend >= 0 ? "↑" : "↓"} ${Math.abs(summary.trend)}%</span> к прошлому месяцу`;
  document.querySelector("#statIncome").textContent = money(summary.monthIncome);
  document.querySelector("#statExpense").textContent = money(summary.monthExpense);
  document.querySelector("#statDebt").textContent = money(summary.debtTotal);
  document.querySelector("#statReserve").textContent = money(state.settings.reserveSaved);
  document.querySelector("#incomeCount").textContent = `${summary.incomeCount} ${plural(summary.incomeCount, ["операция", "операции", "операций"])}`;
  document.querySelector("#expenseCount").textContent = `${summary.expenseCount} ${plural(summary.expenseCount, ["операция", "операции", "операций"])}`;
  document.querySelector("#debtCountMini").textContent = state.debts.length
    ? `${state.debts.length} ${plural(state.debts.length, ["обязательство", "обязательства", "обязательств"])}`
    : "нет активных";
  document.querySelector("#savingRate").textContent = `${summary.savingRate}%`;
  document.querySelector("#savingHint").textContent = summary.monthIncome
    ? summary.savingRate >= 20 ? "Отличный результат за месяц" : "Цель — сохранять хотя бы 20%"
    : "Нет данных за месяц";
  document.querySelector("#freeMoney").textContent = money(summary.free);
  document.querySelector("#healthScore").textContent = score;
  document.querySelector("#scoreRing").style.setProperty("--score", `${score * 3.6}deg`);
  document.querySelector("#coachNote").textContent = coachMessage(summary);

  renderRecentTransactions();
  renderUpcomingPayments();
  renderReserveProgress();
}

function coachMessage(summary) {
  if (!state.operations.length) return "Добавьте первые операции — и здесь появится персональная подсказка.";
  if (summary.free < 0) return `После обязательных платежей не хватает ${money(Math.abs(summary.free))}. Стоит сократить необязательные расходы.`;
  if (summary.monthExpense > summary.monthIncome && summary.monthIncome > 0) return "Расходы обгоняют доходы. Посмотрите аналитику: там видно, какая категория выросла сильнее.";
  if (summary.savingRate >= 20) return "Отличный темп! Вы сохраняете не меньше 20% дохода — это крепкая финансовая привычка.";
  if (summary.debtTotal > 0) return "Свободный остаток можно частично направить на долг с самой высокой ставкой.";
  return "Финансы выглядят устойчиво. Следующий хороший шаг — регулярно пополнять подушку безопасности.";
}

function renderReserveProgress() {
  const target = Number(state.settings.reserveTarget || 0);
  const saved = Number(state.settings.reserveSaved || 0);
  const percent = target > 0 ? Math.min(100, Math.round(saved / target * 100)) : 0;
  document.querySelector("#sideGoalPercent").textContent = `${percent}%`;
  document.querySelector("#sideGoalBar").style.width = `${percent}%`;
  document.querySelector("#sideGoalText").textContent = target > 0
    ? `${money(saved, true)} из ${money(target, true)}`
    : "Добавьте цель в настройках";
}

function renderRecentTransactions() {
  const target = document.querySelector("#recentTransactions");
  const operations = [...state.operations].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  if (!operations.length) {
    target.innerHTML = `<div class="empty-state"><span>↕</span>Здесь появятся ваши доходы и расходы</div>`;
    return;
  }
  target.innerHTML = operations.map(operation => {
    const [icon, color] = visualFor(operation.category, operation.type);
    return `<div class="transaction-item">
      <span class="stat-icon ${color}">${icon}</span>
      <div class="transaction-copy"><b>${escapeHtml(operation.category)}</b><small>${escapeHtml(operation.note || accountName(operation.accountId))} · ${escapeHtml(accountName(operation.accountId))} · ${formatDate(operation.date, true)}</small></div>
      <strong class="transaction-amount ${operation.type} sensitive">${operation.type === "income" ? "+" : "−"} ${money(operation.amount)}</strong>
    </div>`;
  }).join("");
}

function upcomingDebts() {
  const today = parseDate(isoToday());
  const limit = new Date(today);
  limit.setDate(limit.getDate() + 30);
  return state.debts
    .map(debt => ({ ...debt, nextDate: nextPaymentDate(debt), overdue: overdueDays(debt) }))
    .filter(debt => debt.nextDate && (debt.overdue > 0 || parseDate(debt.nextDate) <= limit))
    .sort((a, b) => String(a.nextDate).localeCompare(String(b.nextDate)));
}

function renderUpcomingPayments() {
  const target = document.querySelector("#upcomingPayments");
  const limit = new Date(parseDate(isoToday()));
  limit.setDate(limit.getDate() + 30);
  const recurringItems = state.recurring
    .filter(item => item.active && item.type === "expense" && item.nextDate && parseDate(item.nextDate) <= limit)
    .map(item => ({ ...item, source: "recurring", overdue: Math.max(0, -daysUntil(item.nextDate)) }));
  const items = [
    ...upcomingDebts().map(item => ({ ...item, source: "debt" })),
    ...recurringItems
  ].sort((a, b) => String(a.nextDate).localeCompare(String(b.nextDate))).slice(0, 4);
  document.querySelector("#todayBadge").textContent = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  if (!items.length) {
    target.innerHTML = `<div class="empty-state"><span>✓</span>В ближайшие 30 дней платежей нет</div>`;
    return;
  }
  target.innerHTML = items.map(item => `<div class="payment-item">
    <span class="date-tile">${parseDate(item.nextDate).getDate()}</span>
    <div><b>${escapeHtml(item.name)}</b><small>${item.overdue ? `Просрочка ${item.overdue} дн.` : formatDate(item.nextDate, true)} · ${item.source === "recurring" ? "Регулярный платёж" : debtTypeName(item.kind)}</small></div>
    <strong class="sensitive">${money(item.source === "recurring" ? item.amount : paymentBreakdown(item).total)}</strong>
  </div>`).join("");
}

function filteredOperations() {
  const query = document.querySelector("#operationSearch").value.trim().toLowerCase();
  return [...state.operations]
    .filter(operation => operationFilter === "all" || operation.type === operationFilter)
    .filter(operation => !query || `${operation.category} ${accountName(operation.accountId)} ${operation.note}`.toLowerCase().includes(query))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function renderOperations() {
  const operations = filteredOperations();
  document.querySelector("#operationCount").textContent = `${operations.length} ${plural(operations.length, ["операция", "операции", "операций"])}`;
  const target = document.querySelector("#operationRows");
  if (!operations.length) {
    target.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span>⌕</span>Подходящих операций пока нет</div></td></tr>`;
    return;
  }
  target.innerHTML = operations.map(operation => {
    const [icon, color] = visualFor(operation.category, operation.type);
    return `<tr>
      <td><div class="row-title"><span class="stat-icon ${color}">${icon}</span><div><b>${escapeHtml(operation.note || operation.category)}</b><small>${operation.type === "income" ? "Доход" : "Расход"}</small></div></div></td>
      <td>${escapeHtml(operation.category)}</td>
      <td>${formatDate(operation.date, true)}</td>
      <td>${escapeHtml(accountName(operation.accountId))}</td>
      <td class="${operation.type === "income" ? "amount-income" : "amount-expense"} sensitive">${operation.type === "income" ? "+" : "−"} ${money(operation.amount)}</td>
      <td><button class="row-menu" data-edit-operation="${operation.id}" aria-label="Изменить">✎</button><button class="row-menu" data-delete-operation="${operation.id}" aria-label="Удалить">×</button></td>
    </tr>`;
  }).join("");
}

function renderAccounts() {
  const accountCount = state.accounts.length;
  document.querySelector("#accountsTotal").textContent = money(totalAccountsBalance());
  document.querySelector("#accountsCount").textContent =
    `${accountCount} ${plural(accountCount, ["счёт", "счёта", "счетов"])}`;
  document.querySelector("#accountCards").innerHTML = state.accounts.map(account => {
    const balance = accountBalance(account.id);
    const operationCount = state.operations.filter(operation => operation.accountId === account.id).length;
    return `<article class="account-card ${account.type}">
      <div class="account-card-head">
        <span class="account-card-icon">${accountIcon(account.type)}</span>
        <div>
          <button class="account-card-menu" data-edit-account="${account.id}" aria-label="Изменить счёт">✎</button>
          <button class="account-card-menu" data-delete-account="${account.id}" aria-label="Удалить счёт">×</button>
        </div>
      </div>
      <div class="account-card-name">${escapeHtml(account.name)}</div>
      <strong class="account-card-balance sensitive">${money(balance)}</strong>
      <div class="account-card-foot"><span>${accountTypeName(account.type)}</span><span>${operationCount} ${plural(operationCount, ["операция", "операции", "операций"])}</span></div>
    </article>`;
  }).join("");

  const transfers = [...state.transfers].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  document.querySelector("#transferCount").textContent =
    `${transfers.length} ${plural(transfers.length, ["перевод", "перевода", "переводов"])}`;
  document.querySelector("#transferList").innerHTML = transfers.length
    ? transfers.map(transfer => `<div class="transfer-item">
        <span class="transfer-icon">⇄</span>
        <div class="transfer-copy">
          <b>${escapeHtml(accountName(transfer.fromAccountId))} → ${escapeHtml(accountName(transfer.toAccountId))}</b>
          <small>${formatDate(transfer.date, true)}${transfer.note ? ` · ${escapeHtml(transfer.note)}` : ""}</small>
        </div>
        <strong class="sensitive">${money(transfer.amount)}</strong>
        <button class="row-menu" data-delete-transfer="${transfer.id}" aria-label="Удалить перевод">×</button>
      </div>`).join("")
    : `<div class="empty-state"><span>⇄</span>Переводы между счетами появятся здесь</div>`;
}

function renderRecurring() {
  const active = state.recurring.filter(item => item.active);
  const upcoming = [...active].sort((a, b) => String(a.nextDate).localeCompare(String(b.nextDate)))[0];
  const monthlyExpenses = active
    .filter(item => item.type === "expense")
    .reduce((sum, item) => sum + recurringMonthlyAmount(item), 0);
  document.querySelector("#recurringNext").textContent = upcoming ? formatDate(upcoming.nextDate, true) : "—";
  document.querySelector("#recurringMonthly").textContent = money(monthlyExpenses);
  document.querySelector("#recurringCount").textContent =
    `${state.recurring.length} ${plural(state.recurring.length, ["операция", "операции", "операций"])}`;

  const reminders = recurringReminders();
  document.querySelector("#reminderCount").textContent =
    `${reminders.length} ${plural(reminders.length, ["напоминание", "напоминания", "напоминаний"])}`;
  const badge = document.querySelector("#profileReminderBadge");
  badge.textContent = reminders.length;
  badge.hidden = reminders.length === 0;

  document.querySelector("#reminderList").innerHTML = reminders.length
    ? reminders.map(item => {
        const days = daysUntil(item.nextDate);
        const dateLabel = days < 0
          ? `Просрочено на ${Math.abs(days)} ${plural(Math.abs(days), ["день", "дня", "дней"])}`
          : days === 0 ? "Сегодня" : `Через ${days} ${plural(days, ["день", "дня", "дней"])}`;
        return `<div class="reminder-item ${days < 0 ? "overdue" : ""}">
          <span class="reminder-item-icon">${days < 0 ? "!" : "♢"}</span>
          <div class="reminder-item-copy">
            <b>${escapeHtml(item.name)} · <span class="sensitive">${money(item.amount)}</span></b>
            <small>${dateLabel} · ${escapeHtml(accountName(item.accountId))}${item.autoPost ? " · выполнится автоматически" : ""}</small>
          </div>
          <button class="button secondary small" data-post-recurring="${item.id}">Учесть сейчас</button>
        </div>`;
      }).join("")
    : `<div class="empty-state"><span>✓</span>На ближайшие дни напоминаний нет</div>`;

  document.querySelector("#recurringList").innerHTML = state.recurring.length
    ? [...state.recurring].sort((a, b) => String(a.nextDate).localeCompare(String(b.nextDate))).map(item => `
      <article class="recurring-card ${item.type} ${item.active ? "" : "paused"}">
        <div class="recurring-card-top">
          <span class="recurring-card-icon">${recurringIcon(item.kind)}</span>
          <div class="recurring-card-title">
            <b>${escapeHtml(item.name)}</b>
            <small>${recurringKindName(item.kind)} · ${escapeHtml(item.category)}${item.active ? "" : " · на паузе"}</small>
          </div>
          <button class="row-menu" data-edit-recurring="${item.id}" aria-label="Изменить расписание">✎</button>
        </div>
        <strong class="recurring-card-amount sensitive">${item.type === "income" ? "+" : "−"} ${money(item.amount)}</strong>
        <div class="recurring-card-meta">
          <span>Следующая дата<b>${formatDate(item.nextDate, true)}</b></span>
          <span>Повтор<b>${recurringFrequencyName(item.frequency)}</b></span>
          <span>Счёт<b>${escapeHtml(accountName(item.accountId))}</b></span>
          <span>Напоминание<b>${reminderTimingName(item.remindDays)}</b></span>
        </div>
        <div class="recurring-card-actions">
          <button class="button secondary small" data-post-recurring="${item.id}">Учесть сейчас</button>
          <button class="button secondary small" data-toggle-recurring="${item.id}">${item.active ? "Пауза" : "Возобновить"}</button>
          <button class="button danger small" data-delete-recurring="${item.id}">×</button>
        </div>
      </article>`).join("")
    : `<article class="card empty-state"><span>↻</span>Добавьте зарплату, подписку или коммунальный платёж — приложение возьмёт расписание на себя</article>`;

  const notificationButton = document.querySelector("#notificationButton");
  if (!("Notification" in window)) {
    notificationButton.textContent = "Уведомления не поддерживаются";
    notificationButton.disabled = true;
  } else if (Notification.permission === "granted") {
    notificationButton.textContent = "✓ Уведомления включены";
  } else if (Notification.permission === "denied") {
    notificationButton.textContent = "Уведомления заблокированы";
  } else {
    notificationButton.textContent = "♢ Включить уведомления";
  }
}

function debtTypeName(kind) {
  return kind === "micro" ? "Микрозайм" : kind === "personal" || kind === "debt" ? "Личный долг" : "Кредит";
}

function debtColor(kind) {
  return kind === "micro" ? "coral" : kind === "personal" || kind === "debt" ? "sunshine" : "lilac";
}

function repaymentTypeName(type) {
  return type === "differentiated" ? "дифференцированный" : "аннуитетный";
}

function renderDebts() {
  const summary = totals();
  document.querySelector("#debtTotal").textContent = money(summary.debtTotal);
  document.querySelector("#debtMonthly").textContent = `${money(summary.debtMonthly)} в месяц`;
  const target = document.querySelector("#debtList");
  if (!state.debts.length) {
    target.innerHTML = `<article class="card empty-state"><span>◎</span>Добавьте кредит или долг — приложение поможет держать платежи в фокусе</article>`;
    return;
  }
  target.innerHTML = [...state.debts].sort((a, b) => String(nextPaymentDate(a)).localeCompare(String(nextPaymentDate(b)))).map(debt => {
    const remaining = remainingPaymentCount(debt);
    const paid = Number(debt.paymentsMade || 0);
    const term = Number(debt.termPayments || 0);
    const percent = term > 0
      ? Math.max(0, Math.min(100, Math.round(paid / term * 100)))
      : Number(debt.originalBalance) > 0
        ? Math.max(0, Math.min(100, Math.round((1 - debt.balance / debt.originalBalance) * 100)))
        : 0;
    const nextDate = nextPaymentDate(debt);
    const payment = recommendedPaymentAmount(debt);
    const split = paymentBreakdown(debt, payment);
    const lateDays = overdueDays(debt);
    const forecast = remainingScheduleTotal(debt);
    const remainingLabel = Number.isFinite(remaining)
      ? `${remaining} ${plural(remaining, ["платёж", "платежа", "платежей"])}`
      : "не рассчитывается";
    const scheduleWarning = forecast?.balanceAfterSchedule > .01
      ? ` После графика останется долг ${money(forecast.balanceAfterSchedule)} — проверьте сумму платежа.`
      : "";
    return `<article class="debt-card ${lateDays ? "overdue" : ""}">
      <div class="debt-card-top">
        <span class="stat-icon ${debtColor(debt.kind)}">◎</span>
        <div><b>${escapeHtml(debt.name)}</b><small>${debtTypeName(debt.kind)} · ${repaymentTypeName(debt.repaymentType)} · ${Number(debt.rate || 0)}% годовых</small>${lateDays ? `<span class="overdue-badge">Просрочка ${lateDays} ${plural(lateDays, ["день", "дня", "дней"])}</span>` : ""}</div>
        <strong class="sensitive">${money(debt.balance)}</strong>
      </div>
      <div class="debt-meta">
        <span>Кредит взят<b>${formatDate(debt.issueDate, true)}</b></span>
        <span>Первый платёж<b>${formatDate(debt.firstPaymentDate, true)}</b></span>
        <span>Ближайший платёж<b>${nextDate ? formatDate(nextDate, true) : "График завершён"}</b></span>
        <span>Осталось вносить<b>${remainingLabel}</b></span>
      </div>
      <div class="payment-split">
        <span>Всего к оплате<b class="sensitive">${money(split.total)}</b></span>
        <span>Комиссия<b class="sensitive">${money(split.commission)}</b></span>
        <span>Пени<b class="sensitive">${money(split.penalty)}</b></span>
        <span>В проценты<b class="sensitive">${money(split.interest)}</b></span>
        <span>В тело кредита<b class="sensitive">${money(split.principal)}</b></span>
      </div>
      <div class="debt-progress-copy"><span>Внесено ${paid} из ${term || "—"}</span><span>${percent}% графика</span></div>
      <div class="progress"><i style="width:${percent}%"></i></div>
      <div class="debt-forecast">По оставшемуся графику: <b class="sensitive">${forecast ? money(forecast.total) : "нужна большая сумма платежа"}</b>.${scheduleWarning}</div>
      <div class="debt-actions">
        <button class="button primary small" data-pay-debt="${debt.id}">Внести платёж</button>
        <button class="button secondary small" data-edit-debt="${debt.id}">Изменить</button>
        <button class="button danger small" data-delete-debt="${debt.id}">×</button>
      </div>
    </article>`;
  }).join("");
}

function futureDebtSchedule(debt) {
  const nextDate = nextPaymentDate(debt);
  if (!nextDate) return [];
  const remaining = remainingPaymentCount(debt);
  const count = Number.isFinite(remaining) ? Math.min(remaining, 240) : 120;
  const events = [];
  let balance = Number(debt.balance || 0);
  for (let index = 0; index < count && balance > .01; index += 1) {
    const simulated = {
      ...debt,
      balance,
      paymentsMade: Number(debt.paymentsMade || 0) + index
    };
    const split = paymentBreakdown(simulated);
    if (split.payment <= 0) break;
    events.push({
      id: `${debt.id}-${index}`,
      source: "debt",
      debtId: debt.id,
      name: debt.name,
      kind: debt.kind,
      date: addMonthsIso(nextDate, index),
      number: Number(debt.paymentsMade || 0) + index + 1,
      payment: split.total,
      commission: split.commission,
      penalty: split.penalty,
      interest: split.interest,
      principal: split.principal
    });
    balance = split.newBalance;
    if (split.principal <= 0) break;
  }
  return events;
}

function futureRecurringSchedule(item, selectedMonth) {
  if (!item.active || item.type !== "expense" || !item.nextDate) return [];
  const events = [];
  let date = item.nextDate;
  let guard = 0;
  while (date.slice(0, 7) <= selectedMonth && guard < 240) {
    if (date.slice(0, 7) === selectedMonth) {
      events.push({
        id: `${item.id}-${date}`,
        source: "recurring",
        recurringId: item.id,
        name: item.name,
        kind: "recurring",
        date,
        payment: Number(item.amount || 0),
        frequency: item.frequency,
        accountId: item.accountId
      });
    }
    date = nextRecurringDate(item, date);
    guard += 1;
  }
  return events;
}

function calendarEventsForMonth(date = calendarCursor) {
  const selectedMonth = monthKey(date);
  return [
    ...state.debts.flatMap(futureDebtSchedule).filter(event => event.date.slice(0, 7) === selectedMonth),
    ...state.recurring.flatMap(item => futureRecurringSchedule(item, selectedMonth))
  ]
    .sort((a, b) => a.date.localeCompare(b.date));
}

function calendarKindClass(kind) {
  return kind === "recurring" ? "recurring" : kind === "micro" ? "micro" : kind === "personal" || kind === "debt" ? "personal" : "credit";
}

function renderCalendar() {
  const events = calendarEventsForMonth();
  const monthName = calendarCursor.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  const total = events.reduce((sum, event) => sum + event.payment, 0);
  document.querySelector("#calendarTitle").textContent = monthName;
  document.querySelector("#calendarSummary").textContent = events.length
    ? `${events.length} ${plural(events.length, ["платёж", "платежа", "платежей"])} на сумму ${money(total)}`
    : "В выбранном месяце платежей нет";
  document.querySelector("#calendarTotal").textContent = money(total);

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstDay = new Date(year, month, 1);
  const offset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const rows = Math.max(5, Math.ceil((offset + daysInMonth) / 7));
  const cells = rows * 7;
  const gridStart = new Date(year, month, 1 - offset);
  const eventsByDate = {};
  events.forEach(event => (eventsByDate[event.date] ||= []).push(event));

  document.querySelector("#calendarGrid").innerHTML = Array.from({ length: cells }, (_, index) => {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + index);
    const dateKey = dateToIso(cellDate);
    const dayEvents = eventsByDate[dateKey] || [];
    const outside = cellDate.getMonth() !== month;
    const today = dateKey === isoToday();
    const classes = ["calendar-day", outside ? "outside" : "", today ? "today" : "", dayEvents.length ? "has-payment" : ""].filter(Boolean).join(" ");
    const chips = dayEvents.slice(0, 2).map(event =>
      `<div class="calendar-chip ${calendarKindClass(event.kind)}" title="${escapeHtml(event.name)} — ${money(event.payment)}">${escapeHtml(event.name)} · ${money(event.payment, true)}</div>`
    ).join("");
    const more = dayEvents.length > 2 ? `<div class="calendar-chip more">+ ещё ${dayEvents.length - 2}</div>` : "";
    return `<div class="${classes}">
      <div class="calendar-day-head"><b>${cellDate.getDate()}</b>${dayEvents.length ? "<i></i>" : ""}</div>
      ${chips}${more}
    </div>`;
  }).join("");

  document.querySelector("#calendarEventList").innerHTML = events.length
    ? events.map(event => {
        const date = parseDate(event.date);
        if (event.source === "recurring") {
          return `<div class="calendar-event">
            <span class="calendar-event-date"><b>${date.getDate()}</b><small>${date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "")}</small></span>
            <div class="calendar-event-copy"><b>${escapeHtml(event.name)}</b><small>${recurringFrequencyName(event.frequency)} · ${escapeHtml(accountName(event.accountId))}</small></div>
            <strong class="sensitive">${money(event.payment)}<small>Регулярный платёж</small></strong>
          </div>`;
        }
        return `<div class="calendar-event">
          <span class="calendar-event-date"><b>${date.getDate()}</b><small>${date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "")}</small></span>
          <div class="calendar-event-copy"><b>${escapeHtml(event.name)}</b><small>№${event.number} · % ${money(event.interest)} · тело ${money(event.principal)}${event.commission ? ` · комиссия ${money(event.commission)}` : ""}${event.penalty ? ` · пени ${money(event.penalty)}` : ""}</small></div>
          <strong class="sensitive">${money(event.payment)}<small>${debtTypeName(event.kind)}</small></strong>
        </div>`;
      }).join("")
    : `<div class="empty-state"><span>▦</span>На этот месяц платежей не запланировано</div>`;
}

function monthBuckets() {
  const months = [];
  for (let index = -5; index <= 0; index += 1) {
    const date = shiftMonth(new Date(), index);
    months.push({
      key: monthKey(date),
      label: date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", ""),
      income: 0,
      expense: 0
    });
  }
  state.operations.forEach(operation => {
    const bucket = months.find(month => month.key === String(operation.date).slice(0, 7));
    if (bucket) bucket[operation.type] += Number(operation.amount || 0);
  });
  return months;
}

function monthOperationTotals(key, predicate = () => true) {
  return state.operations
    .filter(operation => String(operation.date).slice(0, 7) === key && predicate(operation))
    .reduce((result, operation) => {
      result[operation.type] += Number(operation.amount || 0);
      return result;
    }, { income: 0, expense: 0 });
}

function recurringAmountForMonth(item, key) {
  if (!item.active || !item.nextDate) return 0;
  let date = item.nextDate;
  let amount = 0;
  let guard = 0;
  while (date.slice(0, 7) <= key && guard < 240) {
    if (date.slice(0, 7) === key) amount += Number(item.amount || 0);
    date = nextRecurringDate(item, date);
    guard += 1;
  }
  return amount;
}

function variableMonthlyAverages() {
  const totals = [];
  for (let offset = -3; offset <= -1; offset += 1) {
    const key = monthKey(shiftMonth(new Date(), offset));
    totals.push(monthOperationTotals(key, operation =>
      !operation.recurringId && !String(operation.note || "").startsWith("Платёж по:")
    ));
  }
  return {
    income: totals.reduce((sum, item) => sum + item.income, 0) / totals.length,
    expense: totals.reduce((sum, item) => sum + item.expense, 0) / totals.length
  };
}

function balanceForecast() {
  const averages = variableMonthlyAverages();
  let balance = totalAccountsBalance();
  const points = [];
  for (let offset = 1; offset <= 6; offset += 1) {
    const date = shiftMonth(new Date(), offset);
    const key = monthKey(date);
    const recurringIncome = state.recurring
      .filter(item => item.type === "income")
      .reduce((sum, item) => sum + recurringAmountForMonth(item, key), 0);
    const recurringExpense = state.recurring
      .filter(item => item.type === "expense")
      .reduce((sum, item) => sum + recurringAmountForMonth(item, key), 0);
    const debtPayments = state.debts
      .flatMap(futureDebtSchedule)
      .filter(event => event.date.slice(0, 7) === key)
      .reduce((sum, event) => sum + Number(event.payment || 0), 0);
    balance = roundMoney(balance + averages.income - averages.expense + recurringIncome - recurringExpense - debtPayments);
    points.push({
      key,
      label: date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", ""),
      balance,
      recurringIncome,
      recurringExpense,
      debtPayments
    });
  }
  return { points, averages };
}

function capitalHistory() {
  const openingBalance = state.accounts.reduce((sum, account) => sum + Number(account.openingBalance || 0), 0);
  const points = [];
  for (let offset = -5; offset <= 0; offset += 1) {
    const date = shiftMonth(new Date(), offset);
    const key = monthKey(date);
    const accountValue = openingBalance + state.operations
      .filter(operation => String(operation.date).slice(0, 7) <= key)
      .reduce((sum, operation) =>
        sum + (operation.type === "income" ? 1 : -1) * Number(operation.amount || 0), 0);
    const debtValue = state.debts.reduce((sum, debt) => {
      const principalPaidLater = (debt.paymentHistory || [])
        .filter(payment => String(payment.date).slice(0, 7) > key)
        .reduce((paid, payment) => paid + Number(payment.principal || 0), 0);
      return sum + Number(debt.balance || 0) + principalPaidLater;
    }, 0);
    points.push({
      key,
      label: date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", ""),
      value: roundMoney(accountValue - debtValue)
    });
  }
  return points;
}

function comparisonDelta(current, previous) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round((current - previous) / Math.abs(previous) * 100);
}

function renderComparison() {
  const currentKey = monthKey();
  const previousKey = monthKey(shiftMonth(new Date(), -1));
  const current = monthOperationTotals(currentKey);
  const previous = monthOperationTotals(previousKey);
  const currentNet = current.income - current.expense;
  const previousNet = previous.income - previous.expense;
  const rows = [
    { value: current.income, previous: previous.income, valueId: "compareIncome", deltaId: "compareIncomeDelta", positiveGood: true },
    { value: current.expense, previous: previous.expense, valueId: "compareExpense", deltaId: "compareExpenseDelta", positiveGood: false },
    { value: currentNet, previous: previousNet, valueId: "compareNet", deltaId: "compareNetDelta", positiveGood: true }
  ];
  rows.forEach(row => {
    const delta = comparisonDelta(row.value, row.previous);
    const deltaElement = document.querySelector(`#${row.deltaId}`);
    document.querySelector(`#${row.valueId}`).textContent = money(row.value);
    deltaElement.textContent = `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta)}%`;
    deltaElement.classList.toggle("negative", row.positiveGood ? delta < 0 : delta > 0);
  });
}

function renderBalanceForecast() {
  const forecast = balanceForecast();
  const values = forecast.points.map(point => point.balance);
  const maximum = Math.max(1, ...values.map(value => Math.abs(value)));
  document.querySelector("#balanceForecastChart").innerHTML = forecast.points.map(point => `
    <div class="forecast-point ${point.balance < 0 ? "negative" : ""}" title="${point.key}: ${money(point.balance)}">
      <b class="sensitive">${money(point.balance, true)}</b>
      <i style="height:${Math.max(5, Math.abs(point.balance) / maximum * 82)}%"></i>
      <small>${point.label}</small>
    </div>`).join("");
  const summary = totals();
  const currentNetWorth = summary.balance - summary.debtTotal;
  const finalBalance = forecast.points[forecast.points.length - 1]?.balance ?? summary.balance;
  const change = summary.balance === 0 ? (finalBalance === 0 ? 0 : 100)
    : Math.round((finalBalance - summary.balance) / Math.abs(summary.balance) * 100);
  document.querySelector("#currentNetWorth").textContent = money(currentNetWorth);
  document.querySelector("#forecastBalance").textContent = money(finalBalance);
  const changeElement = document.querySelector("#forecastChange");
  changeElement.textContent = `${change >= 0 ? "↑" : "↓"} ${Math.abs(change)}%`;
  changeElement.style.color = change >= 0 ? "#c8ffe9" : "#ffd0ca";
  document.querySelector("#forecastSummary").textContent = state.operations.length
    ? `Средний нерегулярный денежный поток: ${money(forecast.averages.income - forecast.averages.expense)} в месяц.`
    : "Добавьте несколько месяцев операций — прогноз станет точнее.";
}

function renderCapitalHistory() {
  const points = capitalHistory();
  const maximum = Math.max(1, ...points.map(point => Math.abs(point.value)));
  document.querySelector("#capitalChart").innerHTML = points.map(point => `
    <div class="capital-point ${point.value < 0 ? "negative" : ""}" title="${point.key}: ${money(point.value)}">
      <b class="sensitive">${money(point.value, true)}</b>
      <i style="height:${Math.max(5, Math.abs(point.value) / maximum * 82)}%"></i>
      <small>${point.label}</small>
    </div>`).join("");
}

function renderDebtStrategies() {
  const target = document.querySelector("#strategyResults");
  if (!state.debts.length) {
    target.innerHTML = `<div class="empty-state"><span>✓</span>Активных долгов нет — стратегия погашения не требуется</div>`;
    return;
  }
  const extra = Math.max(0, Number(document.querySelector("#strategyExtraPayment").value || 0));
  const debts = state.debts.map(debt => ({
    id: debt.id,
    name: debt.name,
    balance: debt.balance,
    rate: debt.rate,
    payment: calculatedRegularPayment(debt)
  }));
  const snowball = simulateDebtStrategy(debts, "snowball", extra);
  const avalanche = simulateDebtStrategy(debts, "avalanche", extra);
  const recommended = avalanche.totalInterest <= snowball.totalInterest ? "avalanche" : "snowball";
  target.innerHTML = [snowball, avalanche].map(result => {
    const isSnowball = result.strategy === "snowball";
    const order = result.priorityOrder.map(item => escapeHtml(item.name)).join(" → ") || "Недостаточно данных";
    return `<div class="strategy-option ${recommended === result.strategy ? "recommended" : ""}">
      <div class="strategy-option-head">
        <b>${isSnowball ? "Снежный ком" : "Лавина"}</b>
        ${recommended === result.strategy ? `<span class="strategy-badge">Меньше процентов</span>` : ""}
      </div>
      <div class="strategy-metrics">
        <span>До полного закрытия<b>${result.complete ? `${result.months} ${plural(result.months, ["месяц", "месяца", "месяцев"])}` : "Более 50 лет"}</b></span>
        <span>Проценты за период<b class="sensitive">${money(result.totalInterest)}</b></span>
      </div>
      <div class="strategy-order"><b>Приоритет доплаты:</b> ${order}</div>
    </div>`;
  }).join("");
}

function renderAnalytics() {
  const months = monthBuckets();
  const maximum = Math.max(1, ...months.flatMap(month => [month.income, month.expense]));
  document.querySelector("#monthlyChart").innerHTML = months.map(month => `<div class="bar-month">
    <div class="bars" title="${month.label}: доходы ${money(month.income)}, расходы ${money(month.expense)}">
      <i class="income-bar" style="height:${Math.max(1, month.income / maximum * 100)}%"></i>
      <i class="expense-bar" style="height:${Math.max(1, month.expense / maximum * 100)}%"></i>
    </div>
    <small>${month.label}</small>
  </div>`).join("");

  const currentMonth = monthKey();
  const categories = {};
  state.operations
    .filter(operation => operation.type === "expense" && String(operation.date).slice(0, 7) === currentMonth)
    .forEach(operation => { categories[operation.category] = (categories[operation.category] || 0) + Number(operation.amount || 0); });
  const entries = Object.entries(categories).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  const colors = ["#6c5ce7", "#ff735f", "#20b987", "#4d9de0", "#f7b731", "#a18cf2", "#ee8a78"];
  document.querySelector("#categoryChart").innerHTML = entries.length
    ? entries.map(([category, amount], index) => `<div class="category-row">
        <span>${escapeHtml(category)}</span><b class="sensitive">${money(amount)}</b>
        <div class="progress"><i style="width:${Math.round(amount / total * 100)}%;--bar-color:${colors[index]}"></i></div>
      </div>`).join("")
    : `<div class="empty-state"><span>⌁</span>Добавьте расходы — здесь появится их структура</div>`;
  renderBalanceForecast();
  renderComparison();
  renderCapitalHistory();
  renderDebtStrategies();
}

function renderSettings() {
  document.querySelector("#userName").value = state.settings.name;
  document.querySelector("#userEmail").value = state.settings.email || "";
  document.querySelector("#openingBalance").value = Number(state.accounts[0]?.openingBalance || 0);
  document.querySelector("#reserveTarget").value = state.settings.reserveTarget;
  document.querySelector("#reserveSaved").value = state.settings.reserveSaved;
  document.querySelector("#currency").value = state.settings.currency;
  document.querySelector("#autoLockMinutes").value = String(state.settings.autoLockMinutes || 5);
  document.querySelector("#lockOnHide").checked = state.settings.lockOnHide !== false;
  const lockMinutes = Number(state.settings.autoLockMinutes || 5);
  document.querySelector("#securityAutoLockHint").textContent =
    `Автоблокировка через ${lockMinutes} ${plural(lockMinutes, ["минуту", "минуты", "минут"])} бездействия`
    + (state.settings.lockOnHide !== false ? " и через 15 секунд в фоне." : ".");
  document.querySelector("#schemaVersionText").textContent =
    `Версия ${CURRENT_SCHEMA_VERSION} · старые данные обновляются автоматически`;
  const hasPassword = Boolean(state.settings.passwordHash);
  const hasPin = Boolean(state.settings.pinHash);
  const hasBiometric = Boolean(state.settings.biometricCredential?.id);
  document.querySelector("#passwordStatusDot").classList.toggle("active", hasPassword);
  document.querySelector("#passwordStatusText").textContent = hasPassword ? "Включён" : "Задайте на стартовом экране";
  document.querySelector("#pinStatusDot").classList.toggle("active", hasPin);
  document.querySelector("#pinStatusText").textContent = hasPin
    ? "Включён · после перезапуска нужен пароль"
    : "Не настроен";
  document.querySelector("#biometricStatusDot").classList.toggle("active", hasBiometric);
  document.querySelector("#biometricStatusText").textContent = hasBiometric ? "Включена" : "Не настроена";
  const encryptedAtRest = Boolean(state.settings.encryptedAtRest);
  document.querySelector("#storageEncryptionStatusDot").classList.toggle("active", encryptedAtRest);
  document.querySelector("#storageEncryptionStatusText").textContent = encryptedAtRest
    ? "Суммы и записи зашифрованы AES‑256"
    : "Включится после серверного входа";
  document.querySelector("#removePinButton").hidden = !hasPin;
  document.querySelector("#removeBiometricButton").hidden = !hasBiometric;
  document.querySelector("#biometricSetupButton").textContent =
    hasBiometric ? "◉ Перенастроить биометрию" : "◉ Настроить биометрию";
  if (!window.isSecureContext) {
    document.querySelector("#biometricSetupButton").disabled = true;
    document.querySelector("#biometricStatusText").textContent = "Нужен HTTPS";
  } else if (!window.PublicKeyCredential || !navigator.credentials) {
    document.querySelector("#biometricSetupButton").disabled = true;
    document.querySelector("#biometricStatusText").textContent = "Не поддерживается браузером";
  } else {
    const renderedProfileId = activeProfileId;
    biometricSupported().then(supported => {
      if (activeProfileId !== renderedProfileId) return;
      document.querySelector("#biometricSetupButton").disabled = !supported;
      if (!supported) {
        document.querySelector("#biometricStatusText").textContent = "Недоступна на этом устройстве";
      }
    });
  }
}

function profileInitial(profile = state.settings) {
  return String(profile.name || profile.login || "П").trim().charAt(0).toUpperCase() || "П";
}

function profileAvatarMarkup(profile = state.settings) {
  const avatar = String(profile.avatar || "");
  return avatar.startsWith("data:image/")
    ? `<img src="${escapeHtml(avatar)}" alt="">`
    : escapeHtml(profileInitial(profile));
}

function closeProfileMenu() {
  const menu = document.querySelector("#profileMenu");
  const button = document.querySelector("#profileMenuButton");
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function closeDesktopAddMenu() {
  const menu = document.querySelector("#desktopAddMenu");
  const button = document.querySelector("#desktopQuickAdd");
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function renderProfileMenu() {
  const displayName = state.settings.name || currentUser?.name || state.settings.login || currentUser?.login || "Пользователь";
  const login = state.settings.login || currentUser?.login || displayName;
  const avatar = profileAvatarMarkup(state.settings);
  document.querySelector("#profileTriggerName").textContent = displayName;
  document.querySelector("#profileTriggerAvatar").innerHTML = avatar;
  document.querySelector("#profileMenuAvatar").innerHTML = avatar;
  document.querySelector("#profileMenuName").textContent = displayName;
  document.querySelector("#profileMenuLogin").textContent = `@${login}`;
  document.querySelector("#profileThemeIcon").textContent = state.settings.theme === "dark" ? "☀" : "☾";
  document.querySelector("#profileThemeLabel").textContent =
    state.settings.theme === "dark" ? "Светлая тема" : "Тёмная тема";

  document.querySelector("#profileList").innerHTML = currentUser
    ? `<div class="profile-account active">
        <span class="profile-account-avatar">${avatar}</span>
        <span class="profile-account-copy"><b>${escapeHtml(displayName)}</b><small>серверный аккаунт @${escapeHtml(login)}</small></span>
        <span class="profile-account-check">✓</span>
      </div>`
    : `<div class="profile-account">
        <span class="profile-account-avatar">?</span>
        <span class="profile-account-copy"><b>Вход не выполнен</b><small>подключитесь к серверу</small></span>
        <span class="profile-account-check">!</span>
      </div>`;
}

async function switchProfile() {
  closeProfileMenu();
  await logoutRemote();
}

function switchLockedProfile() {
  return;
}

async function startNewProfile() {
  closeProfileMenu();
  await logoutRemote();
}

function cancelOnboarding() {
  if (currentUser || state.settings.profileCreated) hideOnboarding();
}

function resizeProfilePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать фотографию"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Файл не похож на изображение"));
      image.onload = () => {
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const context = canvas.getContext("2d");
        context.drawImage(
          image,
          (image.naturalWidth - size) / 2,
          (image.naturalHeight - size) / 2,
          size,
          size,
          0,
          0,
          256,
          256
        );
        resolve(canvas.toDataURL("image/jpeg", .84));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function fillOnboarding() {
  const hasProfile = Boolean(currentUser || state.settings.profileCreated);
  authMode = AUTH_MODE_LOGIN;
  document.querySelector("#onboardingLogin").value = hasProfile ? "" : (state.settings.login || "");
  document.querySelector("#onboardingPassword").value = "";
  document.querySelector("#onboardingTitle").textContent = "Войдите в личный кабинет";
  document.querySelector("#onboardingIntro").textContent =
    "Введите логин и пароль. Данные подтянутся с сервера на любом вашем устройстве.";
  document.querySelector("#onboardingSubmit").innerHTML = `Войти <span>→</span>`;
  document.querySelector("#onboardingSubmit").dataset.authAction = AUTH_MODE_LOGIN;
  document.querySelector("#existingAccountButton").hidden = false;
  document.querySelector("#existingAccountButton").textContent = "Создать новый аккаунт";
  document.querySelector("#existingAccountButton").dataset.authAction = AUTH_MODE_REGISTER;
  document.querySelector("#onboardingClose").hidden = !hasProfile;
  document.querySelector("#onboardingLocalNote").hidden = false;
  document.querySelector("#onboardingLocalNote").textContent =
    authErrorText || "Старые локальные кабинеты отключены: вход и синхронизация теперь идут через сервер.";
}

function showOnboarding() {
  fillOnboarding();
  document.querySelector("#onboarding").hidden = false;
  document.body.style.overflow = "hidden";
  freezeViewport("onboarding");
}

function hideOnboarding() {
  document.querySelector("#onboarding").hidden = true;
  document.body.style.overflow = "";
  releaseViewport("onboarding");
}

function syncOnboardingVisibility() {
  if (state.settings.profileCreated) hideOnboarding();
  else showOnboarding();
}

function resetToSignedOutState(message = "") {
  currentUser = null;
  activeProfileId = "";
  remoteRevision = 0;
  pendingEncryptedProfile = null;
  vaultKeyBytes = null;
  appUnlocked = true;
  authMode = AUTH_MODE_LOGIN;
  authErrorText = message;
  state = clone(DEFAULT_STATE);
  purgeLegacyLocalAccounts();
}

async function createEncryptedInitialVault(login, password) {
  const initialState = hydrateState(clone(DEFAULT_STATE));
  initialState.settings.login = login;
  initialState.settings.name = login;
  initialState.settings.passwordHash = await createSecretHash(password);
  initialState.settings.profileCreated = true;
  initialState.settings.encryptedAtRest = true;
  vaultKeyBytes = randomBytes(32);
  initialState.settings.vaultPasswordWrap = await wrapVaultKey(vaultKeyBytes, password);
  const envelope = await encryptWithRawKey(initialState, vaultKeyBytes);
  return { initialState, envelope, wrap: initialState.settings.vaultPasswordWrap };
}

async function registerRemoteAccount(login, password) {
  const { initialState, envelope, wrap } = await createEncryptedInitialVault(login, password);
  const result = await apiRequest("/api/auth/register", {
    method: "POST",
    body: {
      login,
      password,
      envelope,
      wrap,
      profile: { name: login, avatar: "" }
    }
  });
  currentUser = result.user;
  activeProfileId = currentUser.id;
  remoteRevision = Number(result.vault?.revision || 1);
  state = prepareStateForRemote(initialState);
  pendingEncryptedProfile = null;
  authErrorText = "";
  renderAll();
  hideOnboarding();
  unlockApp();
  showPage("dashboard");
  showToast("Серверный аккаунт создан");
}

async function loginRemoteAccount(login, password) {
  const result = await apiRequest("/api/auth/login", {
    method: "POST",
    body: { login, password }
  });
  if (!applyRemoteEnvelope(result)) throw new Error("В аккаунте нет зашифрованной базы");
  await openEncryptedProfile(password);
  authErrorText = "";
  hideOnboarding();
  unlockApp();
  showPage("dashboard");
  await saveState();
  showToast("Данные синхронизированы с сервера");
}

async function restoreRemoteSession() {
  try {
    const result = await apiRequest("/api/session");
    if (!result.authenticated) {
      resetToSignedOutState("");
      return false;
    }
    applyRemoteEnvelope(result);
    authErrorText = "";
    return true;
  } catch (error) {
    resetToSignedOutState(error.message || "Сервер авторизации недоступен");
    return false;
  }
}

async function pullRemoteVault(silent = true) {
  if (!currentUser?.id || !vaultKeyBytes) return false;
  try {
    const result = await apiRequest("/api/vault");
    const vault = remoteVaultFromPayload(result);
    if (!vault || Number(vault.revision || 0) <= remoteRevision) return false;
    const decrypted = await decryptWithRawKey(vault.envelope, vaultKeyBytes);
    remoteRevision = Number(vault.revision || remoteRevision);
    state = prepareStateForRemote(decrypted);
    pendingEncryptedProfile = null;
    processRecurringOperations();
    renderAll();
    if (!silent) showToast("Данные обновлены с сервера");
    return true;
  } catch (error) {
    if (!silent) showToast(error.message || "Не удалось получить данные с сервера");
    return false;
  }
}

async function logoutRemote() {
  await saveState().catch(() => undefined);
  await apiRequest("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  closeProfileMenu();
  resetToSignedOutState("");
  document.querySelector("#appLock").hidden = true;
  releaseViewport("lock");
  renderAll();
  showPage("dashboard");
  showOnboarding();
}

function renderAll() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.querySelector("#amountCurrency").textContent = state.settings.currency;
  renderProfileMenu();
  renderDashboard();
  renderOperations();
  renderRecurring();
  renderAccounts();
  renderDebts();
  renderCalendar();
  renderAnalytics();
  renderSettings();
  document.body.classList.toggle("privacy-mode", privacyMode);
}

function showPage(pageId) {
  if (!pageMeta[pageId]) return;
  document.querySelectorAll(".page").forEach(page => page.classList.toggle("active", page.id === pageId));
  document.querySelectorAll("[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === pageId));
  document.querySelector("#mobilePayments").classList.toggle("active", ["recurring", "debts", "calendar"].includes(pageId));
  document.querySelector("#mobileMore").classList.toggle("active", ["accounts", "analytics"].includes(pageId));
  document.querySelector("#eyebrow").textContent = pageMeta[pageId][0];
  document.querySelector("#pageTitle").textContent = pageId === "dashboard" && state.settings.name.trim()
    ? `Добрый день, ${state.settings.name.trim()}!`
    : pageMeta[pageId][1];
  history.replaceState(null, "", `#${pageId}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (pageId === "calendar") renderCalendar();
  if (pageId === "analytics") renderAnalytics();
  if (pageId === "recurring") renderRecurring();
}

function fillCategorySelect(type) {
  const select = document.querySelector("#operationCategory");
  select.innerHTML = state.categories[type].map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
}

function fillRecurringCategory(type, selected = "") {
  const select = document.querySelector("#recurringCategory");
  select.innerHTML = state.categories[type].map(category =>
    `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`
  ).join("");
  if (selected && state.categories[type].includes(selected)) select.value = selected;
}

function fillAccountSelect(select, selectedId = "") {
  const current = selectedId || select.value || state.accounts[0]?.id || "";
  select.innerHTML = state.accounts.map(account =>
    `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${money(accountBalance(account.id))}</option>`
  ).join("");
  select.value = accountById(current) ? current : (state.accounts[0]?.id || "");
}

function fillAccountSelects() {
  fillAccountSelect(document.querySelector("#operationAccount"));
  fillAccountSelect(document.querySelector("#transferFrom"));
  fillAccountSelect(document.querySelector("#transferTo"));
  const paymentAccount = document.querySelector("#paymentAccount");
  if (paymentAccount) fillAccountSelect(paymentAccount);
}

function hideModalForms() {
  ["operationForm", "debtForm", "paymentForm", "accountForm", "transferForm", "recurringForm", "backupForm"].forEach(id => {
    document.querySelector(`#${id}`).hidden = true;
  });
}

function openBackupModal(mode) {
  const isExport = mode === "export";
  hideModalForms();
  document.querySelector("#modalKicker").textContent = "ЗАЩИЩЁННАЯ КОПИЯ";
  document.querySelector("#modalTitle").textContent = isExport ? "Зашифровать резервную копию" : "Открыть резервную копию";
  document.querySelector("#backupForm").hidden = false;
  document.querySelector("#backupMode").value = mode;
  document.querySelector("#backupDescription").textContent = isExport
    ? "Придумайте отдельный пароль для файла. Он понадобится при восстановлении данных."
    : "Введите пароль, которым была зашифрована эта резервная копия.";
  document.querySelector("#backupPassword").value = "";
  document.querySelector("#backupPasswordConfirm").value = "";
  document.querySelector("#backupConfirmLabel").hidden = !isExport;
  document.querySelector("#backupPasswordConfirm").required = isExport;
  document.querySelector("#backupSubmitButton").textContent = isExport ? "Зашифровать и скачать" : "Расшифровать и восстановить";
  openModal();
  setTimeout(() => document.querySelector("#backupPassword").focus(), 100);
}

function openRecurringModal(item = null) {
  const defaults = recurringDefaults(item?.kind || "salary");
  const type = item?.type || defaults.type;
  hideModalForms();
  document.querySelector("#modalKicker").textContent = "РАСПИСАНИЕ";
  document.querySelector("#modalTitle").textContent = item ? "Изменить регулярную операцию" : "Добавить регулярную операцию";
  document.querySelector("#recurringForm").hidden = false;
  document.querySelector("#recurringId").value = item?.id || "";
  document.querySelector("#recurringKind").value = item?.kind || "salary";
  document.querySelector("#recurringName").value = item?.name || defaults.name;
  document.querySelector("#recurringType").value = type;
  fillRecurringCategory(type, item?.category || defaults.category);
  document.querySelector("#recurringAmount").value = item?.amount || "";
  fillAccountSelect(document.querySelector("#recurringAccount"), item?.accountId);
  document.querySelector("#recurringFrequency").value = item?.frequency || "monthly";
  document.querySelector("#recurringNextDate").value = item?.nextDate || isoToday();
  document.querySelector("#recurringRemindDays").value = String(item?.remindDays ?? 3);
  document.querySelector("#recurringAutoPost").checked = item?.autoPost !== false;
  openModal();
  setTimeout(() => document.querySelector("#recurringName").focus(), 100);
}

function openOperationModal(type, operation = null) {
  const isIncome = type === "income";
  document.querySelector("#modalKicker").textContent = isIncome ? "НОВЫЙ ДОХОД" : "НОВЫЙ РАСХОД";
  document.querySelector("#modalTitle").textContent = operation ? "Изменить операцию" : (isIncome ? "Добавить доход" : "Добавить расход");
  hideModalForms();
  document.querySelector("#operationForm").hidden = false;
  document.querySelector("#operationId").value = operation?.id || "";
  document.querySelector("#operationType").value = type;
  document.querySelector("#operationAmount").value = operation?.amount || "";
  document.querySelector("#amountSign").textContent = isIncome ? "+" : "−";
  document.querySelector("#amountSign").style.color = isIncome ? "var(--mint)" : "var(--coral)";
  document.querySelector("#operationDate").value = operation?.date || isoToday();
  fillAccountSelect(document.querySelector("#operationAccount"), operation?.accountId);
  document.querySelector("#operationNote").value = operation?.note || "";
  fillCategorySelect(type);
  if (operation) document.querySelector("#operationCategory").value = operation.category;
  openModal();
  setTimeout(() => document.querySelector("#operationAmount").focus(), 100);
}

function setAccountType(type) {
  document.querySelector("#accountType").value = type;
  document.querySelectorAll("[data-account-type]").forEach(button => {
    button.classList.toggle("active", button.dataset.accountType === type);
  });
}

function openAccountModal(account = null) {
  hideModalForms();
  document.querySelector("#modalKicker").textContent = "СЧЁТ";
  document.querySelector("#modalTitle").textContent = account ? "Изменить счёт" : "Добавить счёт";
  document.querySelector("#accountForm").hidden = false;
  document.querySelector("#accountId").value = account?.id || "";
  document.querySelector("#accountName").value = account?.name || "";
  document.querySelector("#accountOpeningBalance").value = Number(account?.openingBalance || 0);
  setAccountType(account?.type || "card");
  openModal();
  setTimeout(() => document.querySelector("#accountName").focus(), 100);
}

function renderTransferPreview() {
  const fromId = document.querySelector("#transferFrom").value;
  const toId = document.querySelector("#transferTo").value;
  const amount = Number(document.querySelector("#transferAmount").value || 0);
  const preview = document.querySelector("#transferPreview");
  if (!fromId || !toId || fromId === toId) {
    preview.textContent = "Выберите два разных счёта";
    return;
  }
  const balance = accountBalance(fromId);
  preview.innerHTML = `Доступно на счёте «${escapeHtml(accountName(fromId))}»: <b class="sensitive">${money(balance)}</b>`
    + (amount > balance ? `<br><span class="amount-expense">Не хватает ${money(amount - balance)}</span>` : "");
}

function openTransferModal() {
  if (state.accounts.length < 2) {
    showToast("Для перевода добавьте второй счёт");
    openAccountModal();
    return;
  }
  hideModalForms();
  document.querySelector("#modalKicker").textContent = "МЕЖДУ СЧЕТАМИ";
  document.querySelector("#modalTitle").textContent = "Новый перевод";
  document.querySelector("#transferForm").hidden = false;
  fillAccountSelect(document.querySelector("#transferFrom"), state.accounts[0].id);
  fillAccountSelect(document.querySelector("#transferTo"), state.accounts[1].id);
  document.querySelector("#transferAmount").value = "";
  document.querySelector("#transferDate").value = isoToday();
  document.querySelector("#transferNote").value = "";
  renderTransferPreview();
  openModal();
}

function debtDraftFromForm() {
  return normalizeDebtRecord({
    id: document.querySelector("#debtId").value || "preview",
    kind: document.querySelector("#debtKind").value,
    name: document.querySelector("#debtName").value.trim(),
    balance: Number(document.querySelector("#debtBalance").value || 0),
    payment: Number(document.querySelector("#debtPayment").value || 0),
    rate: Number(document.querySelector("#debtRate").value || 0),
    repaymentType: document.querySelector("#debtRepaymentType").value,
    rounding: document.querySelector("#debtRounding").value,
    monthlyFee: Number(document.querySelector("#debtMonthlyFee").value || 0),
    paymentFeePercent: Number(document.querySelector("#debtPaymentFeePercent").value || 0),
    penaltyRateDaily: Number(document.querySelector("#debtPenaltyRateDaily").value || 0),
    termPayments: Number(document.querySelector("#debtTermPayments").value || 0),
    paymentsMade: Number(document.querySelector("#debtPaymentsMade").value || 0),
    issueDate: document.querySelector("#debtIssueDate").value,
    firstPaymentDate: document.querySelector("#debtFirstPaymentDate").value,
    firstPaymentAmount: Number(document.querySelector("#debtFirstPaymentAmount").value || 0)
  });
}

function renderDebtPreview() {
  const debt = debtDraftFromForm();
  const split = paymentBreakdown(debt);
  const remaining = remainingPaymentCount(debt);
  document.querySelector("#previewPayment").textContent = money(split.total);
  document.querySelector("#previewCommission").textContent = money(split.commission);
  document.querySelector("#previewPenalty").textContent = money(split.penalty);
  document.querySelector("#previewInterest").textContent = money(split.interest);
  document.querySelector("#previewPrincipal").textContent = money(split.principal);
  document.querySelector("#previewRemaining").textContent = Number.isFinite(remaining)
    ? `${remaining} ${plural(remaining, ["платёж", "платежа", "платежей"])}`
    : "платёж не покрывает проценты";
}

function openDebtModal(debt = null) {
  const normalized = debt ? normalizeDebtRecord(debt) : null;
  document.querySelector("#modalKicker").textContent = "ОБЯЗАТЕЛЬСТВО";
  document.querySelector("#modalTitle").textContent = normalized ? "Изменить долг" : "Добавить долг";
  hideModalForms();
  document.querySelector("#debtForm").hidden = false;
  document.querySelector("#debtId").value = normalized?.id || "";
  document.querySelector("#debtKind").value = normalized?.kind || "credit";
  document.querySelector("#debtName").value = normalized?.name || "";
  document.querySelector("#debtRepaymentType").value = normalized?.repaymentType || "annuity";
  document.querySelector("#debtRounding").value = normalized?.rounding || "kopecks";
  document.querySelector("#debtBalance").value = normalized?.balance || "";
  document.querySelector("#debtTermPayments").value = normalized?.termPayments || "";
  document.querySelector("#debtPaymentsMade").value = normalized?.paymentsMade || 0;
  document.querySelector("#debtIssueDate").value = normalized?.issueDate || isoToday();
  document.querySelector("#debtFirstPaymentDate").value = normalized?.firstPaymentDate || addMonthsIso(isoToday(), 1);
  document.querySelector("#debtFirstPaymentAmount").value = normalized?.firstPaymentAmount || normalized?.payment || "";
  document.querySelector("#debtPayment").value = normalized?.payment || "";
  document.querySelector("#debtRate").value = normalized?.rate || "";
  document.querySelector("#debtMonthlyFee").value = normalized?.monthlyFee || 0;
  document.querySelector("#debtPaymentFeePercent").value = normalized?.paymentFeePercent || 0;
  document.querySelector("#debtPenaltyRateDaily").value = normalized?.penaltyRateDaily || 0;
  renderDebtPreview();
  openModal();
}

function openModal() {
  const backdrop = document.querySelector("#modalBackdrop");
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  const backdrop = document.querySelector("#modalBackdrop");
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

async function sendUpcomingNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reminders = recurringReminders().filter(item => item.lastNotifiedDate !== item.nextDate);
  if (!reminders.length) return;
  let registration = null;
  if ("serviceWorker" in navigator) {
    registration = await navigator.serviceWorker.getRegistration().catch(() => null);
  }
  for (const item of reminders) {
    const days = daysUntil(item.nextDate);
    const when = days < 0 ? `Просрочено на ${Math.abs(days)} дн.` : days === 0 ? "Сегодня" : `Через ${days} дн.`;
    const notificationTitle = appUnlocked ? item.name : "Напоминание «Копилки»";
    const options = {
      body: appUnlocked
        ? `${when}: ${money(item.amount)} · ${accountName(item.accountId)}`
        : "Откройте приложение, чтобы посмотреть запланированную операцию.",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: `recurring-${item.id}-${item.nextDate}`,
      data: { url: "./index.html#recurring" }
    };
    try {
      if (registration?.showNotification) await registration.showNotification(notificationTitle, options);
      else new Notification(notificationTitle, options);
      item.lastNotifiedDate = item.nextDate;
    } catch (error) {
      console.warn("Не удалось показать уведомление", error);
    }
  }
  saveState();
}

function addMonthsIso(value, count = 1) {
  const date = parseDate(value);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + Number(count || 0));
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function paymentDebt() {
  return state.debts.find(item => item.id === document.querySelector("#paymentDebtId").value);
}

function paymentFormValues() {
  const earlyEnabled = document.querySelector("#earlyRepaymentEnabled").checked;
  return {
    regular: Number(document.querySelector("#paymentAmount").value || 0),
    early: earlyEnabled ? Number(document.querySelector("#earlyRepaymentAmount").value || 0) : 0,
    strategy: document.querySelector("#earlyRepaymentStrategy").value
  };
}

function debtAfterPayment(debt, split, earlyAmount, strategy) {
  const updated = { ...debt, balance: split.newBalance, paymentsMade: Number(debt.paymentsMade || 0) + 1 };
  if (earlyAmount <= 0 || updated.balance <= 0) return updated;
  if (strategy === "payment") {
    updated.payment = 0;
    updated.firstPaymentAmount = 0;
    return updated;
  }
  if (debt.repaymentType === "differentiated") {
    const periodsBefore = Math.max(1, Number(debt.termPayments || 0) - Number(debt.paymentsMade || 0));
    const principalQuota = Math.max(.01, Number(debt.balance || 0) / periodsBefore);
    updated.termPayments = updated.paymentsMade + Math.ceil(updated.balance / principalQuota);
    updated.payment = 0;
    updated.firstPaymentAmount = 0;
    return updated;
  }
  const regularPayment = calculatedRegularPayment({ ...debt, firstPaymentAmount: 0 });
  updated.payment = regularPayment;
  updated.firstPaymentAmount = 0;
  const recalculatedCount = estimatedPaymentCount(updated);
  if (Number.isFinite(recalculatedCount)) {
    updated.termPayments = updated.paymentsMade + recalculatedCount;
  }
  return updated;
}

function renderPaymentPreview() {
  const debt = paymentDebt();
  if (!debt) return;
  const values = paymentFormValues();
  const split = paymentBreakdown(debt, values.regular + values.early);
  const updated = debtAfterPayment(debt, split, values.early, values.strategy);
  const remaining = Math.max(0, Number(updated.termPayments || 0) - Number(updated.paymentsMade || 0));
  document.querySelector("#paymentTotal").textContent = money(split.total);
  document.querySelector("#paymentCommission").textContent = money(split.commission);
  document.querySelector("#paymentPenalty").textContent = money(split.penalty);
  document.querySelector("#paymentInterest").textContent = money(split.interest);
  document.querySelector("#paymentPrincipal").textContent = money(split.principal);
  document.querySelector("#paymentNewBalance").textContent = money(split.newBalance);
  document.querySelector("#paymentRemainingCount").textContent =
    `${remaining} ${plural(remaining, ["платёж", "платежа", "платежей"])}`;
  const warning = document.querySelector("#paymentWarning");
  if (values.regular + values.early > 0 && split.principal <= 0 && Number(debt.balance) > 0) {
    warning.textContent = "Платёж не покрывает пени и проценты, поэтому основной долг не уменьшится.";
    warning.hidden = false;
  } else if (split.extra > 0) {
    warning.textContent = `${money(split.extra)} превышает остаток с процентами и не будет учтено.`;
    warning.hidden = false;
  } else if (overdueDays(debt) > 0) {
    warning.textContent = `Просрочка ${overdueDays(debt)} ${plural(overdueDays(debt), ["день", "дня", "дней"])}. Начисленные пени включены в расчёт.`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }
}

function openPaymentModal(id) {
  const debt = state.debts.find(item => item.id === id);
  if (!debt) return;
  const plannedAmount = recommendedPaymentAmount(debt);
  const plannedSplit = paymentBreakdown(debt, plannedAmount);
  document.querySelector("#modalKicker").textContent = "ПЛАТЁЖ ПО КРЕДИТУ";
  document.querySelector("#modalTitle").textContent = debt.name;
  hideModalForms();
  document.querySelector("#paymentForm").hidden = false;
  document.querySelector("#paymentDebtId").value = debt.id;
  document.querySelector("#paymentCurrentBalance").textContent = money(debt.balance);
  document.querySelector("#paymentScheduledAmount").textContent = money(plannedSplit.total);
  document.querySelector("#paymentAmount").value = plannedAmount;
  fillAccountSelect(document.querySelector("#paymentAccount"));
  document.querySelector("#earlyRepaymentEnabled").checked = false;
  document.querySelector("#earlyRepaymentAmount").value = 0;
  document.querySelector("#earlyRepaymentStrategy").value = "term";
  document.querySelector("#earlyRepaymentFields").hidden = true;
  renderPaymentPreview();
  openModal();
}

function applyPayment(debt, regularAmount, earlyAmount, strategy, accountId) {
  const split = paymentBreakdown(debt, regularAmount + earlyAmount);
  const updated = debtAfterPayment(debt, split, earlyAmount, strategy);
  debt.balance = updated.balance;
  debt.paymentsMade = updated.paymentsMade;
  debt.termPayments = updated.termPayments;
  debt.payment = updated.payment;
  debt.firstPaymentAmount = updated.firstPaymentAmount;
  debt.date = nextPaymentDate(debt);
  debt.paymentHistory = [...(debt.paymentHistory || []), {
    date: isoToday(),
    total: split.total,
    regularAmount: bankRound(regularAmount, debt),
    earlyAmount: bankRound(earlyAmount, debt),
    strategy: earlyAmount > 0 ? strategy : "",
    commission: split.commission,
    penalty: split.penalty,
    interest: split.interest,
    principal: split.principal,
    balance: split.newBalance
  }];
  state.operations.push({
    id: uid(), type: "expense", amount: split.total, category: "Другое",
    accountId,
    account: accountName(accountId),
    note: `Платёж по: ${debt.name}. Пени: ${money(split.penalty)}, комиссия: ${money(split.commission)}, проценты: ${money(split.interest)}, тело: ${money(split.principal)}${earlyAmount > 0 ? `, досрочно: ${money(earlyAmount)}` : ""}`,
    date: isoToday()
  });
  if (debt.balance === 0) state.debts = state.debts.filter(item => item.id !== debt.id);
  saveState();
  closeModal();
  renderAll();
  showToast(debt.balance === 0 ? "Кредит полностью закрыт — отлично!" : earlyAmount > 0 ? "Платёж и досрочное погашение учтены" : "Платёж учтён и разделён");
}

async function encryptBackup(password) {
  const envelope = await encryptPayload({
    app: "Копилка",
    version: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: state
  }, password);
  return JSON.stringify(envelope);
}

async function decryptBackup(backup, password) {
  return decryptPayload(backup, password);
}

async function exportData(password) {
  const content = await encryptBackup(password);
  const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `kopilka-${isoToday()}.kopilka`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast("Зашифрованная копия скачана");
}

function restoreImportedData(data) {
  const protectedSettings = {
    login: state.settings.login,
    passwordHash: state.settings.passwordHash,
    pinHash: state.settings.pinHash,
    biometricCredential: state.settings.biometricCredential,
    encryptedAtRest: state.settings.encryptedAtRest,
    vaultPasswordWrap: state.settings.vaultPasswordWrap,
    vaultPinWrap: state.settings.vaultPinWrap,
    profileCreated: true
  };
  data = migrateData(data);
  if (Array.isArray(data.ops) && Array.isArray(data.debts)) {
    state = migrateLegacy(data);
  } else {
    if (!Array.isArray(data.operations) || !Array.isArray(data.debts)) throw new Error("Неверный формат");
    state = hydrateState(data);
  }
  state.settings = { ...state.settings, ...protectedSettings };
  processRecurringOperations();
  saveState();
  renderAll();
  closeModal();
  syncAccessState();
  showToast("Данные успешно восстановлены");
}

function importData(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    showToast("Файл слишком большой. Максимальный размер — 10 МБ");
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => showToast("Не удалось прочитать файл");
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (parsed.encrypted && parsed.format === "kopilka-encrypted-backup") {
        pendingEncryptedBackup = parsed;
        openBackupModal("import");
        return;
      }
      const data = parsed.data || parsed;
      restoreImportedData(data);
    } catch (error) {
      showToast("Не удалось прочитать файл");
    }
  };
  reader.readAsText(file);
}

document.addEventListener("click", event => {
  const desktopAddToggle = event.target.closest("#desktopQuickAdd");
  const desktopAddMenu = document.querySelector("#desktopAddMenu");
  if (desktopAddToggle) {
    desktopAddMenu.hidden = !desktopAddMenu.hidden;
    desktopAddToggle.setAttribute("aria-expanded", String(!desktopAddMenu.hidden));
  } else if (!event.target.closest("#desktopAddMenu")) {
    closeDesktopAddMenu();
  }

  const profileToggle = event.target.closest("#profileMenuButton");
  const profileMenu = document.querySelector("#profileMenu");
  if (profileToggle) {
    profileMenu.hidden = !profileMenu.hidden;
    profileToggle.setAttribute("aria-expanded", String(!profileMenu.hidden));
  } else if (!event.target.closest("#profileMenu")) {
    closeProfileMenu();
  }

  const profileAccount = event.target.closest("[data-profile-id]");
  if (profileAccount) switchProfile(profileAccount.dataset.profileId);

  const lockedProfile = event.target.closest("[data-lock-profile-id]");
  if (lockedProfile) switchLockedProfile(lockedProfile.dataset.lockProfileId);

  const quickAddButton = event.target.closest("#mobileQuickAdd");
  const mobileAddMenu = document.querySelector("#mobileAddMenu");
  const mobilePaymentsButton = event.target.closest("#mobilePayments");
  const mobilePaymentsMenu = document.querySelector("#mobilePaymentsMenu");
  const mobileMoreButton = event.target.closest("#mobileMore");
  const mobileMoreMenu = document.querySelector("#mobileMoreMenu");
  if (quickAddButton) {
    mobileAddMenu.hidden = !mobileAddMenu.hidden;
    quickAddButton.setAttribute("aria-expanded", String(!mobileAddMenu.hidden));
    mobilePaymentsMenu.hidden = true;
    mobileMoreMenu.hidden = true;
  } else if (!event.target.closest("#mobileAddMenu")) {
    mobileAddMenu.hidden = true;
    document.querySelector("#mobileQuickAdd").setAttribute("aria-expanded", "false");
  }
  if (mobilePaymentsButton) {
    mobilePaymentsMenu.hidden = !mobilePaymentsMenu.hidden;
    mobilePaymentsButton.setAttribute("aria-expanded", String(!mobilePaymentsMenu.hidden));
    mobileMoreMenu.hidden = true;
  } else if (!event.target.closest("#mobilePaymentsMenu")) {
    mobilePaymentsMenu.hidden = true;
    document.querySelector("#mobilePayments").setAttribute("aria-expanded", "false");
  }
  if (mobileMoreButton) {
    mobileMoreMenu.hidden = !mobileMoreMenu.hidden;
    mobileMoreButton.setAttribute("aria-expanded", String(!mobileMoreMenu.hidden));
    mobilePaymentsMenu.hidden = true;
  } else if (!event.target.closest("#mobileMoreMenu")) {
    mobileMoreMenu.hidden = true;
    document.querySelector("#mobileMore").setAttribute("aria-expanded", "false");
  }

  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    mobileAddMenu.hidden = true;
    mobilePaymentsMenu.hidden = true;
    mobileMoreMenu.hidden = true;
    document.querySelector("#mobileQuickAdd").setAttribute("aria-expanded", "false");
    document.querySelector("#mobilePayments").setAttribute("aria-expanded", "false");
    document.querySelector("#mobileMore").setAttribute("aria-expanded", "false");
    closeDesktopAddMenu();
    showPage(pageButton.dataset.page);
  }

  const goButton = event.target.closest("[data-go]");
  if (goButton) showPage(goButton.dataset.go);

  const modalButton = event.target.closest("[data-open-modal]");
  if (modalButton) {
    mobileAddMenu.hidden = true;
    mobilePaymentsMenu.hidden = true;
    mobileMoreMenu.hidden = true;
    document.querySelector("#mobileQuickAdd").setAttribute("aria-expanded", "false");
    closeDesktopAddMenu();
    const modalType = modalButton.dataset.openModal;
    if (modalType === "debt") openDebtModal();
    else if (modalType === "account") openAccountModal();
    else if (modalType === "transfer") openTransferModal();
    else if (modalType === "recurring") openRecurringModal();
    else openOperationModal(modalType);
  }

  const editOperation = event.target.closest("[data-edit-operation]");
  if (editOperation) {
    const operation = state.operations.find(item => item.id === editOperation.dataset.editOperation);
    if (operation) openOperationModal(operation.type, operation);
  }

  const deleteOperation = event.target.closest("[data-delete-operation]");
  if (deleteOperation && confirm("Удалить эту операцию?")) {
    state.operations = state.operations.filter(item => item.id !== deleteOperation.dataset.deleteOperation);
    saveState();
    renderAll();
    showToast("Операция удалена");
  }

  const editAccount = event.target.closest("[data-edit-account]");
  if (editAccount) openAccountModal(accountById(editAccount.dataset.editAccount));

  const deleteAccount = event.target.closest("[data-delete-account]");
  if (deleteAccount) {
    const id = deleteAccount.dataset.deleteAccount;
    const isUsed = state.operations.some(operation => operation.accountId === id)
      || state.recurring.some(item => item.accountId === id)
      || state.transfers.some(transfer => transfer.fromAccountId === id || transfer.toAccountId === id);
    if (state.accounts.length === 1) {
      showToast("Нужен хотя бы один счёт");
    } else if (isUsed) {
      showToast("Счёт используется в операциях, переводах или расписании");
    } else if (confirm("Удалить этот счёт?")) {
      state.accounts = state.accounts.filter(account => account.id !== id);
      state.settings.openingBalance = Number(state.accounts[0]?.openingBalance || 0);
      saveState();
      renderAll();
      showToast("Счёт удалён");
    }
  }

  const deleteTransfer = event.target.closest("[data-delete-transfer]");
  if (deleteTransfer && confirm("Удалить этот перевод?")) {
    state.transfers = state.transfers.filter(transfer => transfer.id !== deleteTransfer.dataset.deleteTransfer);
    saveState();
    renderAll();
    showToast("Перевод удалён");
  }

  const editRecurring = event.target.closest("[data-edit-recurring]");
  if (editRecurring) {
    const item = state.recurring.find(entry => entry.id === editRecurring.dataset.editRecurring);
    if (item) openRecurringModal(item);
  }

  const toggleRecurring = event.target.closest("[data-toggle-recurring]");
  if (toggleRecurring) {
    const item = state.recurring.find(entry => entry.id === toggleRecurring.dataset.toggleRecurring);
    if (item) {
      item.active = !item.active;
      if (item.active) processRecurringOperations();
      saveState();
      renderAll();
      showToast(item.active ? "Расписание возобновлено" : "Расписание поставлено на паузу");
    }
  }

  const postRecurring = event.target.closest("[data-post-recurring]");
  if (postRecurring) {
    const item = state.recurring.find(entry => entry.id === postRecurring.dataset.postRecurring);
    if (item) {
      const scheduledDate = item.nextDate;
      createRecurringOperation(item, scheduledDate, true);
      item.lastProcessedDate = scheduledDate;
      item.nextDate = nextRecurringDate(item, scheduledDate);
      item.lastNotifiedDate = "";
      saveState();
      renderAll();
      showToast("Операция учтена, следующая дата рассчитана");
    }
  }

  const deleteRecurring = event.target.closest("[data-delete-recurring]");
  if (deleteRecurring && confirm("Удалить это расписание? Уже созданные операции останутся в истории.")) {
    state.recurring = state.recurring.filter(item => item.id !== deleteRecurring.dataset.deleteRecurring);
    saveState();
    renderAll();
    showToast("Расписание удалено");
  }

  const editDebt = event.target.closest("[data-edit-debt]");
  if (editDebt) openDebtModal(state.debts.find(item => item.id === editDebt.dataset.editDebt));

  const deleteDebt = event.target.closest("[data-delete-debt]");
  if (deleteDebt && confirm("Удалить это обязательство?")) {
    state.debts = state.debts.filter(item => item.id !== deleteDebt.dataset.deleteDebt);
    saveState();
    renderAll();
    showToast("Обязательство удалено");
  }

  const payDebt = event.target.closest("[data-pay-debt]");
  if (payDebt) openPaymentModal(payDebt.dataset.payDebt);
});

document.querySelector("#operationFilter").addEventListener("click", event => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  operationFilter = button.dataset.filter;
  document.querySelectorAll("#operationFilter button").forEach(item => item.classList.toggle("active", item === button));
  renderOperations();
});

document.querySelector("#operationSearch").addEventListener("input", renderOperations);
document.querySelector("#calendarPrev").addEventListener("click", () => {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
  renderCalendar();
});
document.querySelector("#calendarNext").addEventListener("click", () => {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
  renderCalendar();
});
document.querySelector("#calendarToday").addEventListener("click", () => {
  const now = new Date();
  calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  renderCalendar();
});
document.querySelector("#modalClose").addEventListener("click", closeModal);
document.querySelector("#modalBackdrop").addEventListener("click", event => {
  if (event.target.id === "modalBackdrop") closeModal();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeModal();
    closeDesktopAddMenu();
    closeProfileMenu();
    document.querySelector("#mobileAddMenu").hidden = true;
    document.querySelector("#mobilePaymentsMenu").hidden = true;
    document.querySelector("#mobileMoreMenu").hidden = true;
    document.querySelector("#mobileQuickAdd").setAttribute("aria-expanded", "false");
    document.querySelector("#mobilePayments").setAttribute("aria-expanded", "false");
    document.querySelector("#mobileMore").setAttribute("aria-expanded", "false");
  }
});

document.querySelector("#operationForm").addEventListener("submit", event => {
  event.preventDefault();
  const accountId = document.querySelector("#operationAccount").value;
  const operation = {
    id: document.querySelector("#operationId").value || uid(),
    type: document.querySelector("#operationType").value,
    amount: Number(document.querySelector("#operationAmount").value),
    category: document.querySelector("#operationCategory").value,
    date: document.querySelector("#operationDate").value,
    accountId,
    account: accountName(accountId),
    note: document.querySelector("#operationNote").value.trim()
  };
  const index = state.operations.findIndex(item => item.id === operation.id);
  if (index >= 0) state.operations[index] = operation;
  else state.operations.push(operation);
  saveState();
  closeModal();
  renderAll();
  showToast(operation.type === "income" ? "Доход добавлен" : "Расход добавлен");
});

document.querySelector("#recurringKind").addEventListener("change", event => {
  const defaults = recurringDefaults(event.target.value);
  document.querySelector("#recurringName").value = defaults.name;
  document.querySelector("#recurringType").value = defaults.type;
  fillRecurringCategory(defaults.type, defaults.category);
});

document.querySelector("#recurringType").addEventListener("change", event => {
  fillRecurringCategory(event.target.value);
});

document.querySelector("#recurringForm").addEventListener("submit", event => {
  event.preventDefault();
  const id = document.querySelector("#recurringId").value || uid();
  const existing = state.recurring.find(item => item.id === id);
  const nextDate = document.querySelector("#recurringNextDate").value;
  const nextDateValue = parseDate(nextDate);
  const item = normalizeRecurringRecord({
    id,
    kind: document.querySelector("#recurringKind").value,
    name: document.querySelector("#recurringName").value.trim(),
    type: document.querySelector("#recurringType").value,
    category: document.querySelector("#recurringCategory").value,
    amount: Number(document.querySelector("#recurringAmount").value || 0),
    accountId: document.querySelector("#recurringAccount").value,
    frequency: document.querySelector("#recurringFrequency").value,
    nextDate,
    remindDays: Number(document.querySelector("#recurringRemindDays").value || 0),
    autoPost: document.querySelector("#recurringAutoPost").checked,
    active: existing?.active !== false,
    anchorDay: nextDateValue.getDate(),
    anchorMonth: nextDateValue.getMonth(),
    lastProcessedDate: existing?.lastProcessedDate || "",
    lastNotifiedDate: "",
    createdAt: existing?.createdAt || isoToday()
  }, state.accounts[0].id);
  const index = state.recurring.findIndex(entry => entry.id === id);
  if (index >= 0) state.recurring[index] = item;
  else state.recurring.push(item);
  processRecurringOperations();
  saveState();
  closeModal();
  renderAll();
  sendUpcomingNotifications();
  showToast(existing ? "Расписание обновлено" : "Регулярная операция добавлена");
});

document.querySelector("#accountTypePicker").addEventListener("click", event => {
  const button = event.target.closest("[data-account-type]");
  if (button) setAccountType(button.dataset.accountType);
});

document.querySelector("#accountForm").addEventListener("submit", event => {
  event.preventDefault();
  const id = document.querySelector("#accountId").value || uid();
  const existing = accountById(id);
  const account = normalizeAccount({
    id,
    name: document.querySelector("#accountName").value.trim(),
    type: document.querySelector("#accountType").value,
    openingBalance: Number(document.querySelector("#accountOpeningBalance").value || 0),
    createdAt: existing?.createdAt || isoToday()
  });
  const index = state.accounts.findIndex(item => item.id === id);
  if (index >= 0) state.accounts[index] = account;
  else state.accounts.push(account);
  state.operations.forEach(operation => {
    if (operation.accountId === id) operation.account = account.name;
  });
  state.settings.openingBalance = Number(state.accounts[0]?.openingBalance || 0);
  saveState();
  closeModal();
  renderAll();
  showToast(existing ? "Счёт обновлён" : "Счёт добавлен");
});

["transferFrom", "transferTo", "transferAmount"].forEach(id => {
  document.querySelector(`#${id}`).addEventListener("input", renderTransferPreview);
  document.querySelector(`#${id}`).addEventListener("change", renderTransferPreview);
});

document.querySelector("#transferForm").addEventListener("submit", event => {
  event.preventDefault();
  const fromAccountId = document.querySelector("#transferFrom").value;
  const toAccountId = document.querySelector("#transferTo").value;
  const amount = Number(document.querySelector("#transferAmount").value || 0);
  if (fromAccountId === toAccountId) {
    showToast("Выберите два разных счёта");
    return;
  }
  if (amount <= 0) {
    showToast("Введите сумму больше нуля");
    return;
  }
  if (amount > accountBalance(fromAccountId)) {
    showToast("На счёте недостаточно денег");
    return;
  }
  state.transfers.push({
    id: uid(),
    fromAccountId,
    toAccountId,
    amount: roundMoney(amount),
    date: document.querySelector("#transferDate").value,
    note: document.querySelector("#transferNote").value.trim()
  });
  saveState();
  closeModal();
  renderAll();
  showToast("Перевод выполнен");
});

document.querySelector("#debtForm").addEventListener("submit", event => {
  event.preventDefault();
  const existing = state.debts.find(item => item.id === document.querySelector("#debtId").value);
  const debt = debtDraftFromForm();
  debt.id = document.querySelector("#debtId").value || uid();
  debt.originalBalance = existing?.originalBalance || debt.balance;
  if (parseDate(debt.firstPaymentDate) < parseDate(debt.issueDate)) {
    showToast("Первый платёж не может быть раньше даты взятия кредита");
    return;
  }
  if (debt.paymentsMade > debt.termPayments) {
    showToast("Внесённых платежей не может быть больше общего количества");
    return;
  }
  debt.date = nextPaymentDate(debt);
  const index = state.debts.findIndex(item => item.id === debt.id);
  if (index >= 0) state.debts[index] = debt;
  else state.debts.push(debt);
  saveState();
  closeModal();
  renderAll();
  showToast("Обязательство сохранено");
});

document.querySelector("#debtForm").addEventListener("input", renderDebtPreview);
document.querySelector("#strategyExtraPayment").addEventListener("input", renderDebtStrategies);

document.querySelector("#paymentAmount").addEventListener("input", renderPaymentPreview);
document.querySelector("#earlyRepaymentEnabled").addEventListener("change", event => {
  document.querySelector("#earlyRepaymentFields").hidden = !event.target.checked;
  renderPaymentPreview();
});
document.querySelector("#earlyRepaymentAmount").addEventListener("input", renderPaymentPreview);
document.querySelector("#earlyRepaymentStrategy").addEventListener("change", renderPaymentPreview);

document.querySelector("#paymentForm").addEventListener("submit", event => {
  event.preventDefault();
  const debt = paymentDebt();
  const values = paymentFormValues();
  if (!debt || values.regular + values.early <= 0) {
    showToast("Введите сумму больше нуля");
    return;
  }
  const accountId = document.querySelector("#paymentAccount").value;
  const total = paymentBreakdown(debt, values.regular + values.early).total;
  if (total > accountBalance(accountId)) {
    showToast("На выбранном счёте недостаточно денег");
    return;
  }
  applyPayment(debt, values.regular, values.early, values.strategy, accountId);
});

document.querySelector("#unlockForm").addEventListener("submit", async event => {
  event.preventDefault();
  const guard = readUnlockGuard();
  if (guard.blockedUntil > Date.now()) {
    const seconds = Math.ceil((guard.blockedUntil - Date.now()) / 1000);
    document.querySelector("#lockError").textContent = `Слишком много попыток. Повторите через ${seconds} сек.`;
    return;
  }
  const code = document.querySelector("#unlockCode").value;
  const submitButton = document.querySelector("#unlockForm button");
  submitButton.disabled = true;
  if (pendingEncryptedProfile) {
    try {
      await openEncryptedProfile(code);
      if (needsHashUpgrade(state.settings.passwordHash)) {
        state.settings.passwordHash = await createSecretHash(code);
        await saveState();
      }
      submitButton.disabled = false;
      unlockApp();
      showToast("Кабинет открыт и расшифрован");
      return;
    } catch (error) {
      const failedGuard = recordFailedUnlock();
      const lockoutSeconds = Math.max(0, Math.ceil((failedGuard.blockedUntil - Date.now()) / 1000));
      document.querySelector("#lockError").textContent = failedGuard.blockedUntil > Date.now()
        ? `Слишком много попыток. Вход заблокирован на ${lockoutSeconds} сек.`
        : `Не удалось расшифровать базу. Осталось попыток: ${Math.max(0, UNLOCK_ATTEMPT_LIMIT - failedGuard.attempts)}.`;
      document.querySelector("#unlockCode").value = "";
      await new Promise(resolve => setTimeout(resolve, Math.min(1800, failedGuard.attempts * 300)));
      submitButton.disabled = false;
      document.querySelector("#unlockCode").focus();
      return;
    }
  }
  let passwordMatches = false;
  let pinMatches = false;
  try {
    passwordMatches = await verifySecret(code, state.settings.passwordHash);
    if (!passwordMatches) {
      pinMatches = await verifySecret(code, state.settings.pinHash);
    }
  } catch (error) {
    passwordMatches = false;
    pinMatches = false;
  }
  if (passwordMatches || pinMatches) {
    try {
      let securityChanged = false;
      if (!state.settings.encryptedAtRest) {
        if (!passwordMatches) {
          document.querySelector("#lockError").textContent =
            "Для первого включения шифрования войдите по паролю.";
          submitButton.disabled = false;
          return;
        }
        await enableEncryptedStorage(code);
      }
      if (passwordMatches && needsHashUpgrade(state.settings.passwordHash)) {
        state.settings.passwordHash = await createSecretHash(code);
        securityChanged = true;
      } else if (pinMatches && needsHashUpgrade(state.settings.pinHash)) {
        state.settings.pinHash = await createSecretHash(code);
        securityChanged = true;
      }
      if (securityChanged) await saveState();
      submitButton.disabled = false;
      unlockApp();
      showToast("Кабинет открыт");
      return;
    } catch (error) {
      submitButton.disabled = false;
      document.querySelector("#lockError").textContent =
        "Не удалось расшифровать данные. Проверьте пароль или целостность хранилища.";
      return;
    }
  }
  const failedGuard = recordFailedUnlock();
  const lockoutSeconds = Math.max(0, Math.ceil((failedGuard.blockedUntil - Date.now()) / 1000));
  document.querySelector("#lockError").textContent = failedGuard.blockedUntil > Date.now()
    ? `Слишком много попыток. Вход заблокирован на ${lockoutSeconds} сек.`
    : `Неверный пароль или PIN-код. Осталось попыток: ${Math.max(0, UNLOCK_ATTEMPT_LIMIT - failedGuard.attempts)}.`;
  document.querySelector("#unlockCode").value = "";
  await new Promise(resolve => setTimeout(resolve, Math.min(1800, failedGuard.attempts * 300)));
  submitButton.disabled = false;
  document.querySelector("#unlockCode").focus();
});

document.querySelector("#biometricUnlockButton").addEventListener("click", async () => {
  try {
    if (pendingEncryptedProfile) {
      document.querySelector("#lockError").textContent =
        "После перезапуска сначала войдите по паролю или PIN-коду.";
      return;
    }
    if (await authenticateBiometric()) {
      unlockApp();
      showToast("Вход подтверждён");
    } else {
      document.querySelector("#lockError").textContent = "Не удалось подтвердить вход";
    }
  } catch (error) {
    document.querySelector("#lockError").textContent = biometricErrorMessage(error);
  }
});

document.querySelector("#pinForm").addEventListener("submit", async event => {
  event.preventDefault();
  const pin = document.querySelector("#securityPin").value;
  const confirmation = document.querySelector("#securityPinConfirm").value;
  if (!/^\d{4,6}$/.test(pin)) {
    showToast("PIN должен содержать от 4 до 6 цифр");
    return;
  }
  if (pin !== confirmation) {
    showToast("PIN-коды не совпадают");
    return;
  }
  state.settings.pinHash = await createSecretHash(pin);
  state.settings.vaultPinWrap = null;
  document.querySelector("#securityPin").value = "";
  document.querySelector("#securityPinConfirm").value = "";
  await saveState();
  renderSettings();
  showToast("PIN-код включён");
});

document.querySelector("#removePinButton").addEventListener("click", () => {
  if (!confirm("Удалить PIN-код? Вход по паролю останется доступен.")) return;
  state.settings.pinHash = "";
  state.settings.vaultPinWrap = null;
  saveState();
  renderSettings();
  showToast("PIN-код удалён");
});

document.querySelector("#biometricSetupButton").addEventListener("click", async () => {
  try {
    await registerBiometric();
    renderSettings();
    showToast("Биометрический вход включён");
  } catch (error) {
    showToast(error?.name === "NotAllowedError"
      ? "Настройка биометрии отменена"
      : (error?.message || "Не удалось включить биометрию"));
  }
});

document.querySelector("#removeBiometricButton").addEventListener("click", () => {
  if (!confirm("Отключить биометрический вход на этом устройстве?")) return;
  state.settings.biometricCredential = null;
  saveState();
  renderSettings();
  showToast("Биометрический вход отключён");
});

document.querySelector("#lockNowButton").addEventListener("click", lockApp);
document.querySelector("#profileLogoutButton").addEventListener("click", logoutRemote);
document.querySelector("#profileSettingsButton").addEventListener("click", () => {
  closeProfileMenu();
  showPage("settings");
});
document.querySelector("#profileRemindersButton").addEventListener("click", () => {
  closeProfileMenu();
  showPage("recurring");
});
document.querySelector("#addProfileButton").addEventListener("click", startNewProfile);
document.querySelector("#profileAvatarButton").addEventListener("click", () => {
  document.querySelector("#profileAvatarInput").click();
});
document.querySelector("#profileAvatarInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
    showToast("Выберите изображение размером до 5 МБ");
    return;
  }
  try {
    state.settings.avatar = await resizeProfilePhoto(file);
    saveState();
    renderProfileMenu();
    showToast("Фотография обновлена");
  } catch (error) {
    showToast(error.message || "Не удалось сохранить фотографию");
  }
});

document.querySelector("#backupForm").addEventListener("submit", async event => {
  event.preventDefault();
  const mode = document.querySelector("#backupMode").value;
  const password = document.querySelector("#backupPassword").value;
  if (mode === "export") {
    if (!isStrongPassword(password)) {
      showToast("Пароль должен содержать минимум 8 символов, буквы и цифры");
      return;
    }
    if (password !== document.querySelector("#backupPasswordConfirm").value) {
      showToast("Пароли резервной копии не совпадают");
      return;
    }
    try {
      await exportData(password);
      closeModal();
    } catch (error) {
      showToast("Не удалось зашифровать резервную копию");
    }
    return;
  }
  try {
    const decrypted = await decryptBackup(pendingEncryptedBackup, password);
    pendingEncryptedBackup = null;
    restoreImportedData(decrypted.data || decrypted);
  } catch (error) {
    showToast("Неверный пароль или повреждённая резервная копия");
  }
});

document.querySelector("#settingsForm").addEventListener("submit", event => {
  event.preventDefault();
  state.settings.name = document.querySelector("#userName").value.trim();
  state.settings.email = document.querySelector("#userEmail").value.trim();
  state.settings.profileCreated = true;
  state.settings.openingBalance = Number(document.querySelector("#openingBalance").value || 0);
  state.accounts[0].openingBalance = state.settings.openingBalance;
  state.settings.reserveTarget = Number(document.querySelector("#reserveTarget").value || 0);
  state.settings.reserveSaved = Number(document.querySelector("#reserveSaved").value || 0);
  state.settings.currency = document.querySelector("#currency").value;
  saveState();
  renderAll();
  showToast("Настройки сохранены");
});

async function handleOnboardingAuth(action = AUTH_MODE_LOGIN) {
  const submitButton = document.querySelector("#onboardingSubmit");
  const createButton = document.querySelector("#existingAccountButton");
  if (submitButton.disabled || createButton.disabled) return;
  const login = document.querySelector("#onboardingLogin").value.trim();
  const password = document.querySelector("#onboardingPassword").value;
  if (!login) {
    showToast("Введите логин");
    return;
  }
  if (!isStrongPassword(password)) {
    showToast("Пароль должен содержать минимум 8 символов, буквы и цифры");
    return;
  }
  const buttons = [...document.querySelectorAll("#onboardingForm button")];
  buttons.forEach(button => { button.disabled = true; });
  authErrorText = "";
  document.querySelector("#onboardingLocalNote").textContent = action === AUTH_MODE_REGISTER
    ? "Создаём зашифрованный сейф и серверный аккаунт. На телефоне это может занять несколько секунд."
    : "Проверяем логин и расшифровываем зашифрованный сейф.";
  submitButton.innerHTML = action === AUTH_MODE_REGISTER ? "Создаём… <span>→</span>" : "Входим… <span>→</span>";
  createButton.textContent = action === AUTH_MODE_REGISTER ? "Создаём защищённый аккаунт…" : "Создать новый аккаунт";
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    if (action === AUTH_MODE_REGISTER) await registerRemoteAccount(login, password);
    else await loginRemoteAccount(login, password);
  } catch (error) {
    authErrorText = error.message || "Не удалось выполнить вход";
    fillOnboarding();
    showToast(authErrorText);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    if (!document.querySelector("#onboarding").hidden) fillOnboarding();
  }
}

document.querySelector("#onboardingSubmit").addEventListener("click", () => {
  authMode = AUTH_MODE_LOGIN;
});

document.querySelector("#existingAccountButton").addEventListener("click", () => {
  authMode = AUTH_MODE_REGISTER;
  handleOnboardingAuth(AUTH_MODE_REGISTER);
});

document.querySelector("#onboardingForm").addEventListener("submit", async event => {
  event.preventDefault();
  await handleOnboardingAuth(event.submitter?.dataset.authAction || authMode || AUTH_MODE_LOGIN);
});

document.querySelector("#onboardingClose").addEventListener("click", cancelOnboarding);
document.querySelector("#showOnboardingButton").addEventListener("click", logoutRemote);

document.querySelector("#autoLockMinutes").addEventListener("change", event => {
  state.settings.autoLockMinutes = Math.max(1, Number(event.target.value || 5));
  saveState();
  renderSettings();
  showToast("Время автоблокировки обновлено");
});

document.querySelector("#lockOnHide").addEventListener("change", event => {
  state.settings.lockOnHide = event.target.checked;
  saveState();
  renderSettings();
  showToast(event.target.checked ? "Блокировка в фоне включена" : "Блокировка в фоне отключена");
});

document.querySelector("#profileThemeButton").addEventListener("click", () => {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  saveState();
  renderAll();
  closeProfileMenu();
});

document.querySelector("#privacyToggle").addEventListener("click", () => {
  privacyMode = !privacyMode;
  document.body.classList.toggle("privacy-mode", privacyMode);
  document.querySelector("#privacyToggle").textContent = privacyMode ? "◌" : "◉";
});

document.querySelector("#notificationButton").addEventListener("click", async () => {
  if (!("Notification" in window)) {
    showToast("Этот браузер не поддерживает системные уведомления");
    return;
  }
  if (Notification.permission === "denied") {
    showToast("Разрешите уведомления в настройках браузера");
    return;
  }
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  renderRecurring();
  if (permission === "granted") {
    await sendUpcomingNotifications();
    showToast("Напоминания включены");
  } else {
    showToast("Уведомления не включены");
  }
});

document.querySelector("#exportButton").addEventListener("click", () => openBackupModal("export"));
document.querySelector("#importInput").addEventListener("change", event => {
  importData(event.target.files[0]);
  event.target.value = "";
});
document.querySelector("#resetButton").addEventListener("click", () => {
  if (!confirm("Очистить финансовые данные в этом серверном аккаунте?")) return;
  if (!confirm("Это действие нельзя отменить. Продолжить?")) return;
  const protectedSettings = {
    login: state.settings.login,
    passwordHash: state.settings.passwordHash,
    pinHash: state.settings.pinHash,
    biometricCredential: state.settings.biometricCredential,
    autoLockMinutes: state.settings.autoLockMinutes,
    lockOnHide: state.settings.lockOnHide,
    encryptedAtRest: true,
    vaultPasswordWrap: state.settings.vaultPasswordWrap,
    vaultPinWrap: state.settings.vaultPinWrap,
    name: state.settings.name,
    avatar: state.settings.avatar,
    profileCreated: true,
    currency: state.settings.currency,
    theme: state.settings.theme
  };
  state = hydrateState(clone(DEFAULT_STATE));
  state.settings = { ...state.settings, ...protectedSettings };
  purgeLegacyLocalAccounts();
  saveState();
  renderAll();
  syncAccessState();
  showToast("Финансовые данные очищены и отправлены на сервер");
});

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  document.querySelector("#installButton").hidden = false;
});

document.querySelector("#installButton").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.querySelector("#installButton").hidden = true;
});

window.addEventListener("appinstalled", () => showToast("Копилка установлена"));

window.addEventListener("load", async () => {
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("./service-worker.js").catch(console.warn);
  }
  sendUpcomingNotifications();
});

function refreshRecurringSchedules() {
  if (processRecurringOperations()) renderAll();
  sendUpcomingNotifications();
}

window.setInterval(() => {
  pullRemoteVault(true).then(() => refreshRecurringSchedules());
}, 60000);
["pointerdown", "keydown", "touchstart"].forEach(eventName => {
  document.addEventListener(eventName, () => {
    if (appUnlocked) lastActivityAt = Date.now();
  }, { passive: true });
});
window.setInterval(() => {
  const timeout = Math.max(1, Number(state.settings.autoLockMinutes || 5)) * 60000;
  if (appUnlocked && state.settings.profileCreated && hasAppProtection()
    && Date.now() - lastActivityAt >= timeout) lockApp();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  if (state.settings.lockOnHide !== false && hiddenAt && Date.now() - hiddenAt >= 15000) lockApp();
  hiddenAt = 0;
  pullRemoteVault(true).then(() => refreshRecurringSchedules());
});

async function initializeApp() {
  const initialPage = location.hash.slice(1);
  await restoreRemoteSession();
  processRecurringOperations();
  renderAll();
  showPage(pageMeta[initialPage] ? initialPage : "dashboard");
  syncAccessState();
}

initializeApp();
