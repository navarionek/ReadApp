-- 20261029120000_drop_badge_notifications.sql
-- Bez powiadomień push o zdobytych odznakach: usuwamy wyzwalacz, który po zapisie odznaki wołał funkcję
-- notify-badge, i jego funkcję. Odznaki dalej zapisują się w user_badges (kolumna notified_at zostaje,
-- nic już jej nie czyta, a aplikacja nadal ją wypełnia przy cichym zapisie).

DROP TRIGGER IF EXISTS user_badges_notify ON public.user_badges;
DROP FUNCTION IF EXISTS public.notify_new_badge();
