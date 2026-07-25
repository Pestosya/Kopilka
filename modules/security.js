(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.KopilkaSecurity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const PASSWORD_ITERATIONS = 600000;
  const BACKUP_ITERATIONS = 600000;

  function cryptoApi() {
    return root.crypto;
  }

  async function hashLegacySecret(secret) {
    if (cryptoApi()?.subtle && root.TextEncoder) {
      const bytes = new TextEncoder().encode(secret);
      const digest = await cryptoApi().subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    }
    let hash = 2166136261;
    for (const char of secret) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `local-${(hash >>> 0).toString(16)}`;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    cryptoApi().getRandomValues(bytes);
    return bytes;
  }

  function bytesToBase64(bytes) {
    if (typeof root.btoa === "function") {
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return root.btoa(binary);
    }
    return Buffer.from(bytes).toString("base64");
  }

  function base64ToBytes(value) {
    if (typeof root.atob === "function") {
      const binary = root.atob(value);
      return Uint8Array.from(binary, char => char.charCodeAt(0));
    }
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  }

  async function derivePbkdf2Bytes(secret, salt, iterations = PASSWORD_ITERATIONS) {
    const material = await cryptoApi().subtle.importKey(
      "raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]
    );
    return new Uint8Array(await cryptoApi().subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      256
    ));
  }

  async function createSecretHash(secret, iterations = PASSWORD_ITERATIONS) {
    if (!cryptoApi()?.subtle) return hashLegacySecret(secret);
    const salt = randomBytes(16);
    const hash = await derivePbkdf2Bytes(secret, salt, iterations);
    return `pbkdf2$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
  }

  async function verifySecret(secret, storedHash) {
    if (!storedHash) return false;
    if (!storedHash.startsWith("pbkdf2$")) return (await hashLegacySecret(secret)) === storedHash;
    const [, iterationText, saltText, expectedText] = storedHash.split("$");
    const actual = await derivePbkdf2Bytes(secret, base64ToBytes(saltText), Number(iterationText));
    const expected = base64ToBytes(expectedText);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    actual.forEach((value, index) => { difference |= value ^ expected[index]; });
    return difference === 0;
  }

  function isStrongPassword(secret) {
    const value = String(secret || "");
    return value.length >= 8
      && /[A-Za-zА-Яа-яЁё]/.test(value)
      && /\d/.test(value);
  }

  function needsHashUpgrade(storedHash, minimumIterations = PASSWORD_ITERATIONS) {
    if (!String(storedHash || "").startsWith("pbkdf2$")) return true;
    const iterations = Number(String(storedHash).split("$")[1] || 0);
    return iterations < minimumIterations;
  }

  async function deriveAesKey(password, salt, iterations, usages) {
    const material = await cryptoApi().subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return cryptoApi().subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      usages
    );
  }

  async function encryptPayload(payload, password, iterations = BACKUP_ITERATIONS) {
    if (!cryptoApi()?.subtle) throw new Error("Шифрование не поддерживается");
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveAesKey(password, salt, iterations, ["encrypt"]);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      format: "kopilka-encrypted-backup",
      version: 1,
      encrypted: true,
      algorithm: "AES-GCM-256",
      kdf: { name: "PBKDF2-SHA-256", iterations, salt: bytesToBase64(salt) },
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted))
    };
  }

  async function decryptPayload(envelope, password) {
    if (!cryptoApi()?.subtle) throw new Error("Расшифровка не поддерживается");
    if (envelope?.format !== "kopilka-encrypted-backup" || !envelope.ciphertext) {
      throw new Error("Неверный формат");
    }
    const salt = base64ToBytes(envelope.kdf.salt);
    const iv = base64ToBytes(envelope.iv);
    const key = await deriveAesKey(password, salt, Number(envelope.kdf.iterations), ["decrypt"]);
    const decrypted = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBytes(envelope.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  async function encryptWithRawKey(payload, rawKey) {
    if (!cryptoApi()?.subtle) throw new Error("Шифрование не поддерживается");
    const iv = randomBytes(12);
    const key = await cryptoApi().subtle.importKey(
      "raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]
    );
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      format: "kopilka-encrypted-profile",
      version: 1,
      encrypted: true,
      algorithm: "AES-GCM-256",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted))
    };
  }

  async function decryptWithRawKey(envelope, rawKey) {
    if (envelope?.format !== "kopilka-encrypted-profile" || !envelope.ciphertext) {
      throw new Error("Неверный формат профиля");
    }
    const key = await cryptoApi().subtle.importKey(
      "raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]
    );
    const decrypted = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  async function wrapVaultKey(rawKey, secret, iterations = BACKUP_ITERATIONS) {
    return encryptPayload({ key: bytesToBase64(rawKey) }, secret, iterations);
  }

  async function unwrapVaultKey(envelope, secret) {
    const payload = await decryptPayload(envelope, secret);
    if (!payload?.key) throw new Error("Ключ хранилища повреждён");
    return base64ToBytes(payload.key);
  }

  function preserveVaultSecuritySettings(profileState, wrapper) {
    profileState.settings ||= {};
    profileState.settings.vaultPasswordWrap = wrapper || null;
    profileState.settings.encryptedAtRest = true;
    profileState.settings.vaultPinWrap = profileState.settings.vaultPinWrap || null;
    return profileState;
  }

  return {
    PASSWORD_ITERATIONS,
    BACKUP_ITERATIONS,
    hashLegacySecret,
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
    unwrapVaultKey,
    preserveVaultSecuritySettings
  };
});
