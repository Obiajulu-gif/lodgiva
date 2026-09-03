-- The API must connect as lodgiva_app. The schema/migration connection remains
-- the owner so Prisma Migrate can manage objects without being trapped by RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lodgiva_app') THEN
    CREATE ROLE lodgiva_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO lodgiva_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lodgiva_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lodgiva_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lodgiva_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lodgiva_app;

-- Authentication tables are intentionally excluded: the guard must validate
-- a session and membership before a tenant context exists. Every business
-- table carrying tenantId is protected automatically, including future ones.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'tenantId'
      AND table_name NOT IN ('Tenant', 'Membership', 'MembershipProperty', 'Invitation')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', target.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I TO lodgiva_app USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))',
      target.table_name
    );
  END LOOP;
END
$$;
