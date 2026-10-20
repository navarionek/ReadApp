-- 20261020140000_profiles.sql
-- Nazwa wyświetlana trzymana raz na konto w profiles zamiast w każdym wpisie.

-- 0. Wszystkie wpisy muszą mieć właściciela, inaczej stracilibyśmy nazwy
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reads WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'Są wpisy bez user_id - przypisz je do kont przed tą migracją';
  END IF;
END;
$$;

-- 1. Profile
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 50)
);

-- Istniejące konta: nazwa z pierwszego wpisu, a bez wpisów nazwa z Google
INSERT INTO public.profiles (id, display_name)
SELECT u.id, left(coalesce(
  (SELECT r.username FROM public.reads r WHERE r.user_id = u.id ORDER BY r.created_at, r.id LIMIT 1),
  u.raw_user_meta_data->>'full_name',
  u.email
), 50)
FROM auth.users u;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.profiles FROM public, anon, authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT UPDATE (display_name) ON TABLE public.profiles TO authenticated;

CREATE POLICY "Logged in users can read profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users rename only themselves" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- 2. Nowe konto dostaje profil z nazwą z Google
--    (zastępuje claim_legacy_reads, starych wpisów bez właściciela już nie ma)
DROP TRIGGER IF EXISTS on_auth_user_created_claim_reads ON auth.users;
DROP FUNCTION IF EXISTS public.claim_legacy_reads();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, left(coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 50))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. reads: właściciel z defaultu, klient podaje tylko tytuł, strony i mnożnik
DROP TRIGGER IF EXISTS reads_set_owner ON public.reads;
DROP FUNCTION IF EXISTS public.reads_set_owner();

ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_user_id_fkey;
ALTER TABLE public.reads
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ALTER COLUMN user_id SET NOT NULL,
  ADD CONSTRAINT reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  DROP COLUMN username;

REVOKE INSERT ON TABLE public.reads FROM authenticated;
GRANT INSERT (title, pages, multiplier) ON TABLE public.reads TO authenticated;
