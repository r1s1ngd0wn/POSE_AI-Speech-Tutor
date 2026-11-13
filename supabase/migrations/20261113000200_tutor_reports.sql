-- AI Speaking Tutor: the latest comprehensive learner report per child. Deleted with the child profile
-- by the backend. Backend-only access, like the other tutor tables.
CREATE TABLE IF NOT EXISTS public.tutor_reports (child_id text PRIMARY KEY, value jsonb NOT NULL);
ALTER TABLE public.tutor_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tutor_reports FROM anon, authenticated;
GRANT ALL ON public.tutor_reports TO service_role;
