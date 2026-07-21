// Настройки серверной синхронизации.
// publishable-ключ ПУБЛИЧНЫЙ по замыслу Supabase — его безопасно держать в клиенте,
// доступ к данным ограничивают политики RLS (см. supabase/schema.sql).
// НИКОГДА не помещайте сюда sb_secret_… ключ.
window.KOPILKA_SYNC_CONFIG = {
  url: "https://esfbmbgsqqsyabosezrz.supabase.co",
  publishableKey: "sb_publishable_y6zXROBjWcXxjLU-0cOpnQ_DzcBYvBi",
  enabled: true
};
