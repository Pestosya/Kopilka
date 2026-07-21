const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, SyncError } = require("../modules/sync.js");
const { deriveAuthKey } = require("../modules/security.js");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body))
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { fetchImpl, calls };
}

const CONFIG = { url: "https://demo.supabase.co", publishableKey: "sb_publishable_test" };

test("клиент требует url и ключ", () => {
  assert.throws(() => createClient({}, { fetch: async () => ({}) }), /не настроена/);
});

test("вход отправляет authKey как пароль и нормализует сессию", async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, {
      access_token: "acc", refresh_token: "ref", expires_in: 3600,
      user: { id: "u1", email: "a@b.com" }
    })
  );
  const client = createClient(CONFIG, { fetch: fetchImpl });
  const session = await client.signIn("a@b.com", "kpk_authkey");

  assert.equal(session.accessToken, "acc");
  assert.equal(session.userId, "u1");
  assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(JSON.parse(calls[0].options.body).password, "kpk_authkey");
  assert.equal(calls[0].options.headers.apikey, "sb_publishable_test");
});

test("регистрация без сессии означает подтверждение email", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { user: { id: "u1" } }));
  const client = createClient(CONFIG, { fetch: fetchImpl });
  const result = await client.signUp("a@b.com", "kpk_authkey");
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.session, null);
});

test("pullVault возвращает null, когда хранилища ещё нет", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, []));
  const client = createClient(CONFIG, { fetch: fetchImpl });
  assert.equal(await client.pullVault("acc"), null);
});

test("pushVault передаёт версию и возвращает новую", async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, [{ version: 5, updated_at: "2026-01-01", device_id: "d1" }])
  );
  const client = createClient(CONFIG, { fetch: fetchImpl });
  const result = await client.pushVault("acc", {
    ciphertext: { c: 1 }, keyWrap: { k: 1 }, baseVersion: 4, deviceId: "d1"
  });
  assert.equal(result.version, 5);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.p_base_version, 4);
  assert.match(calls[0].url, /\/rpc\/push_vault$/);
});

test("конфликт версий отдаёт код conflict", async () => {
  // Реальная форма ответа PostgREST на RAISE 'vault_conflict' (SQLSTATE P0001).
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse(400, { code: "P0001", message: "vault_conflict", details: null, hint: null })
  );
  const client = createClient(CONFIG, { fetch: fetchImpl });
  await assert.rejects(
    () => client.pushVault("acc", { ciphertext: {}, keyWrap: {}, baseVersion: 1 }),
    (error) => error instanceof SyncError && error.code === "conflict"
  );
});

test("сетевая ошибка помечается как offline", async () => {
  const client = createClient(CONFIG, {
    fetch: async () => { throw new TypeError("Failed to fetch"); }
  });
  await assert.rejects(
    () => client.pullVault("acc"),
    (error) => error instanceof SyncError && error.code === "offline"
  );
});

test("401 требует повторного входа", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(401, { message: "JWT expired" }));
  const client = createClient(CONFIG, { fetch: fetchImpl });
  await assert.rejects(
    () => client.pullVault("acc"),
    (error) => error instanceof SyncError && error.code === "unauthorized"
  );
});

test("authKey детерминирован по паролю и email, но зависит от обоих", async () => {
  const a1 = await deriveAuthKey("secret123", "user@mail.com", 1000);
  const a2 = await deriveAuthKey("secret123", "user@mail.com", 1000);
  const other = await deriveAuthKey("secret123", "different@mail.com", 1000);
  const wrong = await deriveAuthKey("wrong", "user@mail.com", 1000);
  assert.equal(a1, a2);
  assert.match(a1, /^kpk_/);
  assert.notEqual(a1, other);
  assert.notEqual(a1, wrong);
});

test("email нормализуется по регистру и пробелам", async () => {
  const a = await deriveAuthKey("secret123", "User@Mail.com", 1000);
  const b = await deriveAuthKey("secret123", "  user@mail.com  ", 1000);
  assert.equal(a, b);
});
