-- 20261020280000_profile_avatars.sql
-- Awatary z Google przy osobach w rankingu. Adres bierzemy z danych konta (avatar_url / picture),
-- trzymamy w profilu (czytają go wszyscy zalogowani) i odświeżamy przy logowaniu.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_avatar_url_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_avatar_url_check CHECK (
  avatar_url IS NULL
  OR (char_length(avatar_url) <= 500 AND avatar_url ~ '^https://[a-z0-9.-]+\.googleusercontent\.com/')
);

-- Polityka „Users rename only themselves” już ogranicza zmiany do własnego profilu
GRANT UPDATE (avatar_url) ON TABLE public.profiles TO authenticated;

-- Istniejące konta
UPDATE public.profiles p
SET avatar_url = coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
FROM auth.users u
WHERE u.id = p.id
  AND coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
      ~ '^https://[a-z0-9.-]+\.googleusercontent\.com/'
  AND char_length(coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')) <= 500;

-- Nowe konto od razu z awatarem (zły adres = bez awatara, rejestracja nie może się wywalić)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  avatar text := coalesce(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture');
BEGIN
  IF avatar IS NULL OR char_length(avatar) > 500 OR avatar !~ '^https://[a-z0-9.-]+\.googleusercontent\.com/' THEN
    avatar := NULL;
  END IF;
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (NEW.id, left(coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 50), avatar)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
