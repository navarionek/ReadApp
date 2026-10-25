-- 20261025120000_tv_tokens.sql
-- Prywatny link do widoku TV (?tv=token): telewizor pokazuje statystyki bez logowania Google.
-- Każda osoba ma co najwyżej jeden token; nowy zastępuje stary (unieważnienie = usunięcie wiersza).
-- Tabelę czyta tylko właściciel; funkcja tv-feed sprawdza token kluczem service_role i zwraca
-- wyłącznie dane do odczytu (to samo, co i tak widzi każdy zalogowany).

CREATE TABLE IF NOT EXISTS public.tv_tokens (
  user_id uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (token ~ '^[a-z0-9]{10,64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tv_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tv_tokens FROM public, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.tv_tokens TO authenticated;
GRANT INSERT (token) ON TABLE public.tv_tokens TO authenticated;
GRANT UPDATE (token, created_at) ON TABLE public.tv_tokens TO authenticated;

CREATE POLICY "Users see own tv token" ON public.tv_tokens
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users add own tv token" ON public.tv_tokens
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users update own tv token" ON public.tv_tokens
  FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users delete own tv token" ON public.tv_tokens
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));
