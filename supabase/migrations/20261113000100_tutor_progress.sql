-- AI Speaking Tutor: one learner-progress document per child (word mastery, level, streak, stickers).
-- Deleted together with the child profile by the backend. Backend-only access, like the other tutor tables.
CREATE TABLE IF NOT EXISTS public.tutor_progress (child_id text PRIMARY KEY, value jsonb NOT NULL);
ALTER TABLE public.tutor_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tutor_progress FROM anon, authenticated;
GRANT ALL ON public.tutor_progress TO service_role;
