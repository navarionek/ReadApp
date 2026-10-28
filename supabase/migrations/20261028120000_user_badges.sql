-- 20261028120000_user_badges.sql
-- Zdobyte odznaki zapisują się na stałe, osobno dla każdego roku (rywalizacja resetuje się 1 stycznia).
-- Aplikacja liczy odznaki z wpisów i zapisuje nowo zdobyte; zapisanej odznaki nikt nie odbiera
-- (brak UPDATE i DELETE), nawet jeśli wpis zostanie potem usunięty albo zmieniony.
-- Widzą je wszyscy zalogowani, zapisać można tylko swoją. Po zapisie trigger woła funkcję notify-badge,
-- która wysyła powiadomienie push pozostałym.

CREATE TABLE IF NOT EXISTS public.user_badges (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  badge_id text NOT NULL CHECK (char_length(badge_id) BETWEEN 1 AND 40),
  earned_at timestamptz NOT NULL DEFAULT now(),
  -- Ustawiane przy cichym zapisie (odznaki sprzed tej funkcji) i przez funkcję po wysłaniu powiadomienia
  notified_at timestamptz,
  UNIQUE (user_id, year, badge_id)
);

ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_badges FROM public, anon, authenticated;
GRANT SELECT ON TABLE public.user_badges TO authenticated;
GRANT INSERT (year, badge_id, notified_at) ON TABLE public.user_badges TO authenticated;
GRANT USAGE ON SEQUENCE public.user_badges_id_seq TO authenticated;

CREATE POLICY "Logged in users can see badges" ON public.user_badges
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users add own badges" ON public.user_badges
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

-- Po zapisie odznaki: asynchroniczne wywołanie funkcji (pg_net nie blokuje zapisu).
-- Funkcja dostaje samo id i sama sprawdza w bazie, czy odznaka jest świeża i niewysłana.
CREATE OR REPLACE FUNCTION public.notify_new_badge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.notified_at IS NULL THEN
    PERFORM net.http_post(
      url := 'https://ipqjdqvfyfgggykaazug.supabase.co/functions/v1/notify-badge',
      body := jsonb_build_object('id', NEW.id),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Powiadomienie nie może zablokować zapisu odznaki
  RAISE WARNING 'notify_new_badge: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_badges_notify ON public.user_badges;
CREATE TRIGGER user_badges_notify
  AFTER INSERT ON public.user_badges
  FOR EACH ROW EXECUTE FUNCTION public.notify_new_badge();
