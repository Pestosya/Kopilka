-- Копилка — серверная схема (гибрид).
-- Вставьте это целиком в Supabase → SQL Editor → New query → Run.
-- Финансы хранятся ТОЛЬКО зашифрованным blob (сервер их не видит),
-- а несекретные метаданные аккаунта — обычными строками в profiles.

-- 0. Профиль аккаунта: несекретные метаданные (имя, аватар, активность).
--    Финансов здесь нет — только то, что можно показывать без расшифровки.
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar       text,
  locale       text        not null default 'ru',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.profiles enable row level security;
grant select, insert, update on public.profiles to authenticated;

drop policy if exists "profile_select_own" on public.profiles;
create policy "profile_select_own" on public.profiles
  for select using (auth.uid() = user_id);

drop policy if exists "profile_upsert_own" on public.profiles;
create policy "profile_upsert_own" on public.profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists "profile_update_own" on public.profiles;
create policy "profile_update_own" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Автозаведение строки профиля при регистрации нового пользователя.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
    values (new.id, split_part(new.email, '@', 1))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 1. Таблица зашифрованных хранилищ: одна строка на пользователя.
create table if not exists public.vaults (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  ciphertext jsonb       not null,           -- envelope kopilka-encrypted-profile (AES-GCM-256)
  key_wrap   jsonb       not null,           -- ключ базы, обёрнутый паролем (E2E, сервер расшифровать не может)
  version    bigint      not null default 1, -- монотонная версия для разрешения конфликтов
  device_id  text,                           -- какое устройство записало последним
  updated_at timestamptz not null default now()
);

-- 2. Включаем защиту на уровне строк: каждый видит только своё.
alter table public.vaults enable row level security;

-- Доступ к таблице только у вошедших пользователей (строки всё равно ограничивает RLS).
grant select, insert, update, delete on public.vaults to authenticated;

drop policy if exists "vault_select_own" on public.vaults;
create policy "vault_select_own" on public.vaults
  for select using (auth.uid() = user_id);

drop policy if exists "vault_insert_own" on public.vaults;
create policy "vault_insert_own" on public.vaults
  for insert with check (auth.uid() = user_id);

drop policy if exists "vault_update_own" on public.vaults;
create policy "vault_update_own" on public.vaults
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "vault_delete_own" on public.vaults;
create policy "vault_delete_own" on public.vaults
  for delete using (auth.uid() = user_id);

-- 3. Атомарная запись со сравнением версии (optimistic concurrency).
--    Клиент присылает базовую версию, которую он видел. Если на сервере уже
--    новее — возвращаем конфликт, клиент сливает изменения и пробует снова.
create or replace function public.push_vault(
  p_ciphertext   jsonb,
  p_key_wrap     jsonb,
  p_base_version bigint,
  p_device_id    text default null
)
returns public.vaults
language plpgsql
security invoker
as $$
declare
  v_current public.vaults;
  v_result  public.vaults;
begin
  select * into v_current from public.vaults where user_id = auth.uid();

  if not found then
    -- первая загрузка: base_version должен быть 0
    if coalesce(p_base_version, 0) <> 0 then
      raise exception 'vault_conflict' using errcode = 'P0001';
    end if;
    insert into public.vaults (user_id, ciphertext, key_wrap, version, device_id, updated_at)
      values (auth.uid(), p_ciphertext, p_key_wrap, 1, p_device_id, now())
      returning * into v_result;
    return v_result;
  end if;

  -- кто-то (другое устройство) записал раньше нас
  if v_current.version <> coalesce(p_base_version, -1) then
    raise exception 'vault_conflict' using errcode = 'P0001';
  end if;

  update public.vaults
     set ciphertext = p_ciphertext,
         key_wrap   = p_key_wrap,
         version    = v_current.version + 1,
         device_id  = p_device_id,
         updated_at = now()
   where user_id = auth.uid()
   returning * into v_result;
  return v_result;
end;
$$;

grant execute on function public.push_vault(jsonb, jsonb, bigint, text) to authenticated;
