-- This project does not grant new tables to the API roles automatically.
-- Only the server's service role may use the memory tables; anon and
-- authenticated get nothing.
grant select, insert, update, delete on public.user_memories to service_role;
grant select, insert, update, delete on public.organization_memories to service_role;
