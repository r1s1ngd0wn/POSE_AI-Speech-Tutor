-- AI Speaking Tutor: parent privacy settings (consent, PIN, permissions, daily limit) and teacher judgments.
-- Backend-only access, like the other tutor tables.
CREATE TABLE IF NOT EXISTS public.tutor_parents (parent_id text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS public.tutor_judgments (id text PRIMARY KEY, value jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS tutor_judgments_session ON public.tutor_judgments ((value->>'sessionId'));
ALTER TABLE public.tutor_parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tutor_judgments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tutor_parents, public.tutor_judgments FROM anon, authenticated;
GRANT ALL ON public.tutor_parents, public.tutor_judgments TO service_role;

-- A teacher role for the review screens. Roles are assigned by an administrator, for example:
--   UPDATE public.profiles SET role = 'teacher' WHERE id = '<the teacher''s auth user id>';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('user', 'teacher', 'admin'));
