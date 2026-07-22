(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.KopilkaSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  // Клиент серверной синхронизации поверх Supabase (Auth v1 + PostgREST).
  // Никакого SDK: только fetch к HTTPS-эндпоинтам. Сервер видит лишь шифртекст.

  class SyncError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = "SyncError";
      this.code = code || "sync_error";
      this.status = status || 0;
    }
  }

  function createClient(config, deps = {}) {
    const url = String(config?.url || "").replace(/\/+$/, "");
    const apikey = String(config?.publishableKey || config?.anonKey || "");
    const fetchImpl = deps.fetch || root.fetch?.bind(root);
    if (!url || !apikey) throw new SyncError("Синхронизация не настроена", "not_configured");
    if (!fetchImpl) throw new SyncError("fetch недоступен", "no_fetch");

    async function request(path, { method = "GET", token, body, headers } = {}) {
      const finalHeaders = Object.assign({ apikey }, headers || {});
      if (token) finalHeaders.Authorization = `Bearer ${token}`;
      if (body !== undefined) finalHeaders["Content-Type"] = "application/json";

      let response;
      try {
        response = await fetchImpl(`${url}${path}`, {
          method,
          headers: finalHeaders,
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      } catch (networkError) {
        throw new SyncError("Нет связи с сервером", "offline", 0);
      }

      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (_) { data = text; }
      }

      if (!response.ok) {
        const serverText = [
          data?.error_code, data?.code, data?.msg, data?.message,
          data?.error_description, data?.details, data?.hint,
          typeof data === "string" ? data : ""
        ].filter(Boolean).join(" ");
        // Конфликт версий из push_vault (RAISE 'vault_conflict', SQLSTATE P0001).
        if (serverText.includes("vault_conflict")) {
          throw new SyncError("Данные на сервере новее", "conflict", response.status);
        }
        if (response.status === 401 || response.status === 403) {
          throw new SyncError("Требуется повторный вход", "unauthorized", response.status);
        }
        const message = data?.msg || data?.message || data?.error_description || `Ошибка ${response.status}`;
        throw new SyncError(message, "server_error", response.status);
      }
      return data;
    }

    function normalizeSession(raw) {
      if (!raw?.access_token) return null;
      return {
        accessToken: raw.access_token,
        refreshToken: raw.refresh_token || "",
        expiresAt: raw.expires_at
          ? raw.expires_at * 1000
          : Date.now() + (Number(raw.expires_in || 3600) * 1000),
        userId: raw.user?.id || "",
        email: raw.user?.email || ""
      };
    }

    return {
      SyncError,

      // authKey — производный секрет пароля, не сам пароль (E2E: сервер не может расшифровать данные).
      async signUp(email, authKey) {
        const data = await request("/auth/v1/signup", {
          method: "POST",
          body: { email, password: authKey }
        });
        const session = normalizeSession(data);
        return {
          session,
          // Если в проекте включено подтверждение email — сессии сразу нет.
          needsConfirmation: !session
        };
      },

      async signIn(email, authKey) {
        const data = await request("/auth/v1/token?grant_type=password", {
          method: "POST",
          body: { email, password: authKey }
        });
        const session = normalizeSession(data);
        if (!session) throw new SyncError("Не удалось войти", "no_session");
        return session;
      },

      async refresh(refreshToken) {
        const data = await request("/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          body: { refresh_token: refreshToken }
        });
        const session = normalizeSession(data);
        if (!session) throw new SyncError("Сессия истекла", "unauthorized", 401);
        return session;
      },

      async signOut(token) {
        try {
          await request("/auth/v1/logout", { method: "POST", token, body: {} });
        } catch (_) { /* локальный выход всё равно состоится */ }
      },

      // Скачать зашифрованное хранилище пользователя (или null, если ещё ничего нет).
      async pullVault(token) {
        const rows = await request(
          "/rest/v1/vaults?select=ciphertext,key_wrap,version,updated_at,device_id&limit=1",
          { token }
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) return null;
        return {
          ciphertext: row.ciphertext,
          keyWrap: row.key_wrap,
          version: Number(row.version || 0),
          updatedAt: row.updated_at,
          deviceId: row.device_id || ""
        };
      },

      // Загрузить хранилище с проверкой версии. baseVersion — версия, поверх которой пишем
      // (0 для самой первой загрузки). При конфликте бросает SyncError code "conflict".
      async pushVault(token, { ciphertext, keyWrap, baseVersion, deviceId }) {
        const rows = await request("/rest/v1/rpc/push_vault", {
          method: "POST",
          token,
          headers: { Prefer: "return=representation" },
          body: {
            p_ciphertext: ciphertext,
            p_key_wrap: keyWrap,
            p_base_version: Number(baseVersion || 0),
            p_device_id: deviceId || null
          }
        });
        const row = Array.isArray(rows) ? rows[0] : rows;
        return {
          version: Number(row?.version || 0),
          updatedAt: row?.updated_at,
          deviceId: row?.device_id || ""
        };
      }
    };
  }

  return { createClient, SyncError };
});
