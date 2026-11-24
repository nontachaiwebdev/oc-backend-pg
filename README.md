# oc-backend-pg

Generic backend API for the OC app. It replaces Supabase and Pinecone with PostgreSQL, pgvector, Azure Blob Storage and Azure Communication Services Email.

**One running service serves one frontend**, with its own database, storage container, secrets and settings. To serve another client, deploy the same code again with a different env file.

```text
Frontend A  ->  API service A  ->  PostgreSQL A + Storage A
Frontend B  ->  API service B  ->  PostgreSQL B + Storage B
```

## Run locally

Requires Node 20.19+, Docker, and the Supabase CLI (logged in) for seeding.

```sh
cp .env.example .env
# In .env, set SERVICE_NAME, KNOWLEDGE_BASE_NAME, SEED_SUPABASE_REPO, SEED_SUPABASE_PROJECT_REF
# and AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true
npm install
npm run db:up
npm run db:migrate
npm run seed:db      # replaces all rows in the local database with a copy from Supabase
npm run seed:files   # copies files into the local blob emulator
npm run dev          # http://localhost:4000
```

Check it with `curl localhost:4000/health`, then run `npm run smoke` while the server is up.

## Run a second service locally

Give it its own env file with a different `PORT`, `SERVICE_NAME`, `DATABASE_URL`, `JWT_SECRET`, `AZURE_STORAGE_CONTAINER`, `CORS_ORIGINS` and `SITE_URL`. Create its database once if it doesn't exist:

```sh
docker compose exec postgres createdb -U postgres my_second_db
```

Select the file with `DOTENV_CONFIG_PATH` for any command:

```sh
DOTENV_CONFIG_PATH=.env.second npm run db:migrate
DOTENV_CONFIG_PATH=.env.second npm run dev
```

## Settings to fill in

| Needed for | Settings |
|---|---|
| Identity of this deployment | `SERVICE_NAME`, `KNOWLEDGE_BASE_NAME` |
| AI chat, drafting, reindex | `OPENAI_API_KEY`, `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Invitation email | `AZURE_COMMUNICATION_CONNECTION_STRING`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` |
| Links in email | `SITE_URL` |
| Production | `NODE_ENV=production`, `JWT_SECRET` (32+ characters), `DATABASE_URL`, `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER`, `CORS_ORIGINS`, `SITE_URL`, `TRUST_PROXY=1` behind nginx |
| Refresh cookie | `COOKIE_SAME_SITE` (`lax` by default), `COOKIE_DOMAIN`. Use `none` only when the frontend and API are on different sites |
| Nightly AI reindex | `REINDEX_NIGHTLY_TIME` in Stockholm time. Blank is `04:00` in production and off elsewhere |

Without AI keys, the server still runs and AI routes return `503`. Without mail settings in development, invites create the account but send nothing. Use a recovery link to give that user access.

## Build the AI index

Chat answers need chunks in pgvector. This calls OpenAI and costs money. It can be stopped and resumed, and unchanged files aren't embedded again.

```sh
npx tsx src/rag/reindex-cli.ts
```

In production the API also runs this every night. If a run is already active, that night's job is skipped.

## Tests

`npm test` needs Docker. It creates a temporary database, checks access control and the main API flows, then removes it. It makes no AI calls.

## Docker

```sh
docker build -t oc-pg-api .
docker run --rm --env-file .env.production oc-pg-api node --import tsx src/db/migrate.ts
docker run -d --env-file .env.production -p 127.0.0.1:4000:4000 oc-pg-api
```

## Import into production

Refresh the local copy, migrate the empty target, check it, then import. The target must be empty, and sessions and one-time links are not copied.

```sh
npm run seed:db && npm run seed:files
DOTENV_CONFIG_PATH=.env.production npm run db:migrate
npm run import:production -- --target-env .env.production
npm run import:production -- --target-env .env.production --apply --confirm <target-database-name>
```

Stop writes in the old app before the final seed, or changes made after it are lost.

## Connecting the frontend

- Base URL: `http://localhost:4000/api`.
- Log in with `POST /auth/login`. Keep `access_token` in memory and send it as `Authorization: Bearer <token>`.
- Send requests with `credentials: "include"`. The refresh token is an httpOnly cookie.
- `POST /auth/refresh` and `POST /auth/logout` need an `X-Requested-With: oc-app` header.
- Invite and recovery links arrive as `/auth/callback#type=...&token=...`. Call `POST /auth/token/verify`, then `POST /auth/token/accept`.
- File downloads need the bearer token, so use `fetch` and a blob URL.
- Errors are `{ "error": "...", "code": "..." }`.

Each old Supabase call is mapped to its new endpoint in [docs/api](docs/api): `users.md`, `files.md`, `content.md`, `conversations.md`, `assistant.md`.
