-- 20261020130000_stable_usernames.sql
-- Nazwa w leaderboardzie nie zależy od aktualnej nazwy w Google:
-- kto ma już wpisy, dostaje nazwę ze swojego pierwszego wpisu.

CREATE OR REPLACE FUNCTION public.reads_set_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.user_id    := auth.uid();
    NEW.username   := coalesce(
      (SELECT r.username FROM public.reads r
       WHERE r.user_id = auth.uid()
       ORDER BY r.created_at, r.id
       LIMIT 1),
      auth.jwt()->'user_metadata'->>'full_name',
      auth.jwt()->>'email'
    );
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END;
$$;
