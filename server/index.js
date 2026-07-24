const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { openDatabase } = require("./storage");

const app = express();
const db = openDatabase();

const APP_ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SESSION_COOKIE = "kopilka_session";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_VAULT_JSON_BYTES = 8 * 1024 * 1024;

if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

function nowIso() {
  return new Date().toISOString();
}

function normalizeLogin(login) {
  return String(login || "").trim().toLowerCase();
}

function isValidEmail(login) {
  const email = normalizeLogin(login);
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    login: row.login,
    name: row.name || row.login,
    avatar: row.avatar || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [
      decodeURIComponent(part.slice(0, index).trim()),
      decodeURIComponent(part.slice(index + 1).trim())
    ];
  }).filter(([key]) => key));
}

function sendSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString("base64url")}`;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const params = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const digest = crypto.scryptSync(password, salt, 64, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

function verifyPassword(password, storedHash) {
  const [scheme, nText, rText, pText, saltText, digestText] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || !saltText || !digestText) return false;
  const digest = Buffer.from(digestText, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(saltText, "base64url"), digest.length, {
    N: Number(nText),
    r: Number(rText),
    p: Number(pText),
    maxmem: 64 * 1024 * 1024
  });
  return digest.length === actual.length && crypto.timingSafeEqual(digest, actual);
}

function isStrongPassword(password) {
  const value = String(password || "");
  return value.length >= 8 && /[A-Za-zА-Яа-яЁё]/.test(value) && /\d/.test(value);
}

function validateLoginAndPassword(login, password) {
  const normalizedLogin = normalizeLogin(login);
  if (!isValidEmail(normalizedLogin)) {
    return { error: "Введите корректную электронную почту. Она будет уникальным логином аккаунта." };
  }
  if (!isStrongPassword(password)) {
    return { error: "Пароль должен содержать минимум 8 символов, буквы и цифры." };
  }
  return { login: normalizedLogin };
}

function validateVaultEnvelope(envelope, wrap) {
  const envelopeText = JSON.stringify(envelope || {});
  const wrapText = JSON.stringify(wrap || {});
  if (Buffer.byteLength(envelopeText, "utf8") > MAX_VAULT_JSON_BYTES) {
    return { error: "Зашифрованная база слишком большая." };
  }
  if (envelope?.format !== "kopilka-encrypted-profile" || envelope?.algorithm !== "AES-GCM-256" || !envelope?.iv || !envelope?.ciphertext) {
    return { error: "Неверный формат зашифрованной базы." };
  }
  if (wrap?.format !== "kopilka-encrypted-backup" || wrap?.algorithm !== "AES-GCM-256" || !wrap?.iv || !wrap?.ciphertext) {
    return { error: "Неверный формат ключа шифрования." };
  }
  return { envelopeText, wrapText };
}

function sessionExpiryIso() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashSessionToken(token), userId, nowIso(), sessionExpiryIso());
  sendSessionCookie(res, token);
}

function readVault(userId) {
  const row = db.prepare("SELECT * FROM vaults WHERE user_id = ?").get(userId);
  if (!row) return null;
  return {
    revision: row.revision,
    envelope: JSON.parse(row.envelope_json),
    wrap: JSON.parse(row.wrap_json),
    updatedAt: row.updated_at
  };
}

function respondAuthPayload(res, userRow) {
  res.json({
    authenticated: true,
    user: publicUser(userRow),
    vault: readVault(userRow.id)
  });
}

function authRequired(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ code: "AUTH_REQUIRED", message: "Войдите в аккаунт." });
    return;
  }
  const session = db.prepare(`
    SELECT sessions.id_hash, sessions.expires_at, users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ?
  `).get(hashSessionToken(token));
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    clearSessionCookie(res);
    if (session) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(session.id_hash);
    res.status(401).json({ code: "AUTH_REQUIRED", message: "Сессия истекла. Войдите заново." });
    return;
  }
  req.user = session;
  req.sessionHash = session.id_hash;
  next();
}

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, storage: "sqlite", encryptedVaults: true });
});

app.get("/api/auth/check", (req, res) => {
  const email = normalizeLogin(req.query.email);
  if (!isValidEmail(email)) {
    res.status(400).json({
      code: "INVALID_EMAIL",
      message: "Введите корректную электронную почту."
    });
    return;
  }
  const existing = db.prepare("SELECT id FROM users WHERE login = ?").get(email);
  res.json({ email, available: !existing });
});

app.get("/api/session", (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) {
    res.json({ authenticated: false });
    return;
  }
  const session = db.prepare(`
    SELECT sessions.id_hash, sessions.expires_at, users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ?
  `).get(hashSessionToken(token));
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    clearSessionCookie(res);
    if (session) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(session.id_hash);
    res.json({ authenticated: false });
    return;
  }
  respondAuthPayload(res, session);
});

app.post("/api/auth/register", (req, res) => {
  const { login, password, envelope, wrap, profile = {} } = req.body || {};
  const credentials = validateLoginAndPassword(login, password);
  if (credentials.error) {
    res.status(400).json({ code: "INVALID_CREDENTIALS", message: credentials.error });
    return;
  }
  const vault = validateVaultEnvelope(envelope, wrap);
  if (vault.error) {
    res.status(400).json({ code: "INVALID_VAULT", message: vault.error });
    return;
  }
  const existing = db.prepare("SELECT id FROM users WHERE login = ?").get(credentials.login);
  if (existing) {
    res.status(409).json({ code: "EMAIL_EXISTS", message: "Аккаунт с такой почтой уже существует. Войдите или используйте другую почту." });
    return;
  }

  const userId = randomId("usr");
  const createdAt = nowIso();
  const createAccount = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, login, password_hash, name, avatar, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      credentials.login,
      createPasswordHash(password),
      String(profile.name || credentials.login).slice(0, 120),
      String(profile.avatar || ""),
      createdAt,
      createdAt
    );
    db.prepare(`
      INSERT INTO vaults (user_id, revision, envelope_json, wrap_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?)
    `).run(userId, vault.envelopeText, vault.wrapText, createdAt, createdAt);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  });

  let user;
  try {
    user = createAccount();
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || String(error.message || "").includes("UNIQUE constraint failed")) {
      res.status(409).json({ code: "EMAIL_EXISTS", message: "Аккаунт с такой почтой уже существует. Войдите или используйте другую почту." });
      return;
    }
    throw error;
  }
  createSession(res, user.id);
  respondAuthPayload(res, user);
});

app.post("/api/auth/login", (req, res) => {
  const { login, password } = req.body || {};
  const normalizedLogin = normalizeLogin(login);
  if (!isValidEmail(normalizedLogin)) {
    res.status(400).json({ code: "INVALID_EMAIL", message: "Введите корректную электронную почту." });
    return;
  }
  const user = db.prepare("SELECT * FROM users WHERE login = ?").get(normalizedLogin);
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ code: "BAD_LOGIN", message: "Неверная почта или пароль." });
    return;
  }
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  createSession(res, user.id);
  respondAuthPayload(res, user);
});

app.post("/api/auth/logout", authRequired, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(req.sessionHash);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/vault", authRequired, (req, res) => {
  res.json({
    authenticated: true,
    user: publicUser(req.user),
    vault: readVault(req.user.id)
  });
});

app.put("/api/vault", authRequired, (req, res) => {
  const { revision, envelope, wrap, profile = {} } = req.body || {};
  const vault = validateVaultEnvelope(envelope, wrap);
  if (vault.error) {
    res.status(400).json({ code: "INVALID_VAULT", message: vault.error });
    return;
  }
  const current = db.prepare("SELECT revision FROM vaults WHERE user_id = ?").get(req.user.id);
  if (!current) {
    res.status(404).json({ code: "VAULT_NOT_FOUND", message: "Зашифрованная база не найдена." });
    return;
  }
  if (Number(revision) !== Number(current.revision)) {
    res.status(409).json({
      code: "VAULT_CONFLICT",
      message: "Данные уже изменились на другом устройстве.",
      vault: readVault(req.user.id)
    });
    return;
  }
  const updatedAt = nowIso();
  const nextRevision = current.revision + 1;
  db.transaction(() => {
    db.prepare(`
      UPDATE vaults
      SET revision = ?, envelope_json = ?, wrap_json = ?, updated_at = ?
      WHERE user_id = ?
    `).run(nextRevision, vault.envelopeText, vault.wrapText, updatedAt, req.user.id);
    db.prepare(`
      UPDATE users
      SET name = ?, avatar = ?, updated_at = ?
      WHERE id = ?
    `).run(
      String(profile.name || req.user.name || req.user.login).slice(0, 120),
      String(profile.avatar || ""),
      updatedAt,
      req.user.id
    );
  })();
  res.json({ ok: true, vault: { revision: nextRevision, updatedAt } });
});

app.use((req, res, next) => {
  if (req.path.startsWith("/server/")
    || req.path.startsWith("/tests/")
    || req.path.startsWith("/node_modules/")
    || req.path.startsWith("/.git/")
    || ["/package.json", "/package-lock.json", "/README.md", "/Dockerfile"].includes(req.path)) {
    res.sendStatus(404);
    return;
  }
  next();
});

app.use(express.static(APP_ROOT, {
  index: false,
  dotfiles: "ignore",
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-store");
  }
}));

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(APP_ROOT, "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  const status = Number(error.status || error.statusCode || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    code: status === 413 ? "REQUEST_TOO_LARGE" : "SERVER_ERROR",
    message: status === 413 ? "Зашифрованная база слишком большая." : "Внутренняя ошибка сервера."
  });
});

app.listen(PORT, () => {
  console.log(`Копилка запущена: http://localhost:${PORT}`);
});
