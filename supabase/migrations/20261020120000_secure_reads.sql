-- 20261020120000_secure_reads.sql
-- Wpisy należą do konta (user_id), a nie tylko do nazwy wyświetlanej.
-- Czytać i dodawać mogą tylko zalogowani, i tylko jako oni sami.

-- 1. Kolumna z właścicielem wpisu
ALTER TABLE public.reads
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reads_user_id_idx ON public.reads (user_id);

-- 2. Przypisz istniejące wpisy do kont, które już się logowały
--    (po nazwie z Google; pomijamy nazwy, które ma więcej niż jedno konto)
WITH named_users AS (
  SELECT id, coalesce(raw_user_meta_data->>'full_name', email) AS name
  FROM auth.users
),
unique_names AS (
  SELECT name, min(id::text)::uuid AS id
  FROM named_users
  GROUP BY name
  HAVING count(*) = 1
)
UPDATE public.reads r
SET user_id = u.id
FROM unique_names u
WHERE r.user_id IS NULL
  AND r.username = u.name;

-- 3. Kto zaloguje się pierwszy raz, przejmuje swoje stare wpisy
CREATE OR REPLACE FUNCTION public.claim_legacy_reads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    UPDATE public.reads
    SET user_id = NEW.id
    WHERE user_id IS NULL
      AND username = coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email);
  EXCEPTION WHEN OTHERS THEN
    -- Nigdy nie blokuj rejestracji przez problem z wpisami
    RAISE WARNING 'claim_legacy_reads: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_claim_reads ON auth.users;
CREATE TRIGGER on_auth_user_created_claim_reads
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.claim_legacy_reads();

-- 4. Właściciel, nazwa i data ustawiane przez serwer, nie przez klienta
CREATE OR REPLACE FUNCTION public.reads_set_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.user_id    := auth.uid();
    NEW.username   := coalesce(auth.jwt()->'user_metadata'->>'full_name', auth.jwt()->>'email');
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reads_set_owner ON public.reads;
CREATE TRIGGER reads_set_owner
  BEFORE INSERT ON public.reads
  FOR EACH ROW EXECUTE FUNCTION public.reads_set_owner();

-- 5. Sensowne wartości
ALTER TABLE public.reads
  ADD CONSTRAINT reads_pages_check CHECK (pages BETWEEN 1 AND 5000),
  ADD CONSTRAINT reads_multiplier_check CHECK (multiplier IN (0.5, 1, 1.5, 2.25)),
  ADD CONSTRAINT reads_title_check CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 300);

-- 6. Uprawnienia: anon nie ma dostępu, zalogowani tylko SELECT + INSERT
DROP POLICY IF EXISTS "Allow inserts" ON public.reads;
DROP POLICY IF EXISTS "Allow selects" ON public.reads;

REVOKE ALL ON TABLE public.reads FROM public, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.reads TO authenticated;
GRANT USAGE ON SEQUENCE public.reads_id_seq TO authenticated;

CREATE POLICY "Logged in users can read" ON public.reads
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users insert only as themselves" ON public.reads
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
