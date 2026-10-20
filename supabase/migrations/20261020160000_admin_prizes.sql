-- 20261020160000_admin_prizes.sql
-- Admin (flaga w profilu) ustawia nagrodę na dany rok, wszyscy zalogowani ją widzą.
-- Flagi nie da się ustawić z aplikacji (UPDATE profili jest tylko na display_name);
-- admina nadaje się ręcznie w SQL Editorze.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT p.is_admin FROM public.profiles p WHERE p.id = auth.uid()), false);
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

CREATE TABLE IF NOT EXISTS public.prizes (
  year integer PRIMARY KEY CHECK (year BETWEEN 2000 AND 2100),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500)
);

ALTER TABLE public.prizes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.prizes FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prizes TO authenticated;

CREATE POLICY "Logged in users can read prizes" ON public.prizes
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Admins insert prizes" ON public.prizes
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY "Admins update prizes" ON public.prizes
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY "Admins delete prizes" ON public.prizes
  FOR DELETE TO authenticated
  USING ((SELECT public.is_admin()));
