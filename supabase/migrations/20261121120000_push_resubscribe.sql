-- 20261121120000_push_resubscribe.sql
-- save_push_subscription zwraca, czy ten endpoint był już w bazie. Funkcja notify-new-read usuwa
-- subskrypcje, które serwis push odrzucił (404/410), a przeglądarka dalej trzyma tę martwą.
-- Apka przy starcie widzi wtedy false i robi sobie nową subskrypcję zamiast zapisywać martwą w kółko.

DROP FUNCTION IF EXISTS public.save_push_subscription(text, text, text);

CREATE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existed boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Musisz być zalogowany' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
  v_existed := FOUND;
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
  VALUES (auth.uid(), p_endpoint, p_p256dh, p_auth);
  RETURN v_existed;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_push_subscription(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text) TO authenticated;
