-- Runs once on first container init (postgres image executes everything in
-- docker-entrypoint-initdb.d/ automatically). Creates a second, physically
-- separate database for integration tests so they never touch dev data.
CREATE DATABASE signalai_test;
