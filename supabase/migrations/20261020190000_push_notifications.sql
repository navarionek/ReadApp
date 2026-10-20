-- 20261020190000_push_notifications.sql
-- Powiadomienia push: subskrypcje urządzeń + wywołanie funkcji notify-new-read po dodaniu wpisu.

-- 1. Subskrypcje (jedno urządzenie/przeglądarka = jeden endpoint)
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Klient nie ma bezpośredniego dostępu; tylko przez funkcje niżej
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_subscriptions FROM public, anon, authenticated;

-- Zapis subskrypcji tego urządzenia dla zalogowanego (to samo urządzenie po zmianie konta przechodzi na nowe)
CREATE OR REPLACE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Musisz być zalogowany' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
  VALUES (auth.uid(), p_endpoint, p_p256dh, p_auth);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_push_subscription(p_endpoint text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint AND user_id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.save_push_subscription(text, text, text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.delete_push_subscription(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_push_subscription(text) TO authenticated;

-- 2. Znacznik „powiadomienie wysłane”, żeby jeden wpis nie poszedł dwa razy.
--    Klient nie może go ustawić (INSERT/UPDATE ma tylko na title, pages, multiplier).
ALTER TABLE public.reads ADD COLUMN IF NOT EXISTS notified_at timestamptz;

-- 3. Po dodaniu wpisu: asynchroniczne wywołanie funkcji (pg_net nie blokuje zapisu).
--    Funkcja dostaje samo id i sama sprawdza w bazie, czy wpis jest świeży i niewysłany.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.notify_new_read()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://ipqjdqvfyfgggykaazug.supabase.co/functions/v1/notify-new-read',
    body := jsonb_build_object('id', NEW.id),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Powiadomienie nie może zablokować dodania wpisu
  RAISE WARNING 'notify_new_read: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reads_notify ON public.reads;
CREATE TRIGGER reads_notify
  AFTER INSERT ON public.reads
  FOR EACH ROW EXECUTE FUNCTION public.notify_new_read();
