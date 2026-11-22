-- Banco exclusivo dos testes: assim `docker compose up` (app no banco `wagering`) e `bun run test`
-- (banco `wagering_test`) rodam ao mesmo tempo sem um disputar dados/eventos do outro.
-- O Postgres executa esta pasta só na criação do volume (primeiro `docker compose up`).
CREATE DATABASE wagering_test;
