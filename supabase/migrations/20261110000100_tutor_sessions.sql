-- AI Speaking Tutor: child profiles and lesson sessions. Same key/value shape as the other app
-- tables; only the trusted backend connects, so row level security is enabled with no policies.
CREATE TABLE IF NOT EXISTS public.tutor_children (id text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.tutor_sessions (id text PRIMARY KEY, value jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS tutor_children_parent ON public.tutor_children ((value->>'parentId'));
CREATE INDEX IF NOT EXISTS tutor_sessions_child ON public.tutor_sessions ((value->>'childId'));
ALTER TABLE public.tutor_children ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tutor_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tutor_children, public.tutor_sessions FROM anon, authenticated;
GRANT ALL ON public.tutor_children, public.tutor_sessions TO service_role;
