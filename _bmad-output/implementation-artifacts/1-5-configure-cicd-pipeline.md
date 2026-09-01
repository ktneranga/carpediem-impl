# Story 1.5: Configure CI/CD Pipeline

Status: review

- **Epic:** 1 — Project Foundation & Infrastructure
- **Story ID:** 1.5
- **Story Key:** 1-5-configure-cicd-pipeline
- **Created:** 2026-08-21

---

## ⚠️ READ FIRST — Acceptance Criteria Were Corrected

The acceptance criteria in `epics.md` for this story rest on **five false premises**. They have been rewritten below. Do not implement the epics.md version.

| # | epics.md claims | Reality |
|---|---|---|
| 1 | "Watchtower waits for `GET /api/health` to return 200 before removing the old container" | **Watchtower has no application health gate.** It stops the old container and starts the new one. This was finding AR9 on Story 1.4, deferred here. |
| 2 | "it rolls back to the previous image" | **Watchtower has no rollback mechanism.** Confirmed by its own maintainers — see the technical research doc. |
| 3 | "the `Dockerfile` in the repository root" | It is at **`docker/Dockerfile`** (Story 1.4). `docker-compose.yml` sets `build.context: .` + `build.dockerfile: docker/Dockerfile`. |
| 4 | "the image starts successfully with `node server.ts`" | `server.ts` is **TypeScript** — `node` cannot run it. Story 1.4's CMD is `sh -c "sh docker/scripts/migrate.sh && pnpm start"`, and `pnpm start` = `cross-env NODE_ENV=production tsx server.ts`. |
| 5 | "pushes the image tagged with … `latest`" | The technical research doc explicitly says **never use `:latest`** — mutable tags are cited as the leading cause of production container outages. |

**Also note:** epics.md asks you to create a multi-stage Dockerfile. **One already exists** (4 stages, Story 1.4). Do not create another. This story only builds and ships it.

---

## Story

As a developer,
I want a GitHub Actions pipeline that builds and pushes immutable Docker images to GHCR, with Watchtower delivering them to a targeted restaurant and a post-deploy health check that auto-reverts a bad release,
So that software updates reach restaurant servers automatically without manual deployment, and a broken build does not leave a restaurant down.

---

## Acceptance Criteria

**AC-1: Workflow triggers and builds**
**Given** `.github/workflows/deploy.yml`
**When** a commit is pushed to `main`
**Then** the workflow triggers; builds the image using `docker/Dockerfile` with build context at repo root; authenticates to GHCR with the built-in `GITHUB_TOKEN`; requires no manually managed registry secret

**AC-2: Immutable tagging — no `:latest`**
**Given** a successful build
**When** the image is pushed to GHCR
**Then** it carries an immutable tag `sha-<short-commit-sha>`; and a moving pointer tag `stable` is also pushed referencing the same digest; **`latest` is never pushed**

**AC-3: Watchtower opt-in and per-restaurant scoping**
**Given** the Watchtower service in `docker-compose.yml`
**When** the stack is running
**Then** Watchtower runs with `WATCHTOWER_LABEL_ENABLE=true` (explicit opt-in — unlabeled containers are never touched); the `app` service carries `com.centurylinklabs.watchtower.enable=true` and `com.centurylinklabs.watchtower.scope=${RESTAURANT_SCOPE}`; Watchtower runs with a matching `--scope`; `db`, `portainer`, and `uptime-kuma` are **not** labeled and are never auto-updated

**AC-4: GHCR authentication on the restaurant server**
**Given** the app image lives in a private GHCR repository
**When** Watchtower polls for updates
**Then** it authenticates using a mounted Docker config or `REPO_USER`/`REPO_PASS` environment variables; a pull of a private image succeeds

**AC-5: Post-deploy health verification**
**Given** an image has been pushed and Watchtower has applied it
**When** the workflow's verification job runs
**Then** it polls `GET /api/health` on the target server over Tailscale until it returns HTTP 200 with `db: "connected"`, or a 5-minute timeout elapses

**AC-6: Automatic revert on failed health check**
**Given** the health verification fails or times out
**When** the workflow handles the failure
**Then** the `stable` tag is re-pointed to the previous known-good digest and pushed; Watchtower pulls it within one poll interval and the restaurant returns to the prior working version; the workflow exits non-zero and the failure is visible in GitHub Actions

**AC-7: Targeted single-restaurant deployment**
**Given** `workflow_dispatch` with inputs `restaurant` and `version`
**When** triggered manually
**Then** only the named restaurant's scope/tag is updated; other restaurants are unaffected

**AC-8: Migration safety in CI**
**Given** `drizzle.config.ts` reads `DATABASE_URL`
**When** the CI build runs without a database
**Then** the build does not attempt migrations and does not fail on a missing `DATABASE_URL`; migrations remain a container-start concern only (`docker/scripts/migrate.sh`)

**AC-9: Documented limitation**
**Given** the delivery mechanism
**When** a developer reads the workflow file
**Then** a header comment states plainly that Watchtower performs a stop-then-start with a brief interruption (typically 5–15 seconds), that true zero-downtime requires `docker-rollout` and is deferred, and that revert is eventually-consistent (bounded by the poll interval), not instant

---

## Tasks / Subtasks

- [x] **Task 1 — Fix `drizzle.config.ts` DATABASE_URL assertion** (AC: 8)
  - Deferred item from Story 1.3 code review, explicitly assigned to this story.
  - `drizzle.config.ts:8` uses a `!` non-null assertion on `process.env.DATABASE_URL`. Replace with an explicit check that throws a clear message naming the missing variable.
  - Verify `pnpm build` still succeeds with no `DATABASE_URL` set — the build must not touch the database.

- [x] **Task 2 — Create `.github/workflows/deploy.yml` skeleton** (AC: 1, 9)
  - Triggers: `push` to `main`, plus `workflow_dispatch` with `restaurant` (choice) and `version` (string) inputs.
  - `permissions: { contents: read, packages: write }` — required for `GITHUB_TOKEN` to push to GHCR.
  - Header comment documenting the AC-9 limitations.

- [x] **Task 3 — Build and push job** (AC: 1, 2)
  - Steps: checkout → setup-buildx → login to `ghcr.io` → metadata → build-push.
  - `file: docker/Dockerfile`, `context: .`
  - Tags: `type=sha,prefix=sha-,format=short` and `type=raw,value=stable`. **No `latest`.**
  - Enable GitHub Actions build cache (`cache-from`/`cache-to: type=gha`) — the image installs all dependencies and is slow to build cold.

- [x] **Task 4 — Capture previous good digest** (AC: 6)
  - Before pushing, resolve and store the digest `stable` currently points to. This is the revert target.
  - Persist it as a job output so the verification job can use it.

- [x] **Task 5 — Add Watchtower labels and scope to `docker-compose.yml`** (AC: 3)
  - `app` service: add `labels:` with `com.centurylinklabs.watchtower.enable=true` and `com.centurylinklabs.watchtower.scope=${RESTAURANT_SCOPE:-default}`.
  - `watchtower` service: add `WATCHTOWER_LABEL_ENABLE=true` and `WATCHTOWER_SCOPE=${RESTAURANT_SCOPE:-default}`.
  - Change `app` from `build:` to `image: ghcr.io/<org>/carpe-diem-rms:stable` for production, keeping `build:` in `docker-compose.override.yml` for local dev. Watchtower cannot update a locally-built image.
  - Do **not** label `db`, `portainer`, or `uptime-kuma`.

- [x] **Task 6 — GHCR authentication for the server** (AC: 4)
  - Add `REPO_USER` / `REPO_PASS` env vars to the `watchtower` service, sourced from `.env`.
  - Document in `.env.example` that `REPO_PASS` is a GitHub PAT with `read:packages` scope only.

- [x] **Task 7 — Health verification job** (AC: 5)
  - Runs after build-push. Connects to the target server over Tailscale (`tailscale/github-action` to join the runner to the tailnet).
  - Poll `GET /api/health` every 15s for up to 5 minutes. Success requires HTTP 200 **and** `db: "connected"` in the body — a 200 with `db: "error"` is a failure.
  - Allow an initial grace period covering Watchtower's poll interval (300s) plus container start.

- [x] **Task 8 — Revert on failure** (AC: 6)
  - On verification failure, re-tag `stable` to the digest captured in Task 4 and push.
  - Use `docker buildx imagetools create` to re-point the tag without a rebuild.
  - Fail the job so the run is red in GitHub Actions.

- [x] **Task 9 — Targeted deployment path** (AC: 7)
  - When `workflow_dispatch` supplies `restaurant`, push the pointer tag as `stable-<restaurant>` instead of `stable`, and confirm that restaurant's compose references that tag.
  - Document the scope-per-restaurant mapping in `.env.example`.

- [x] **Task 10 — Update `.env.example`** (AC: 3, 4, 7)
  - Add `RESTAURANT_SCOPE`, `REPO_USER`, `REPO_PASS`, and `GHCR_IMAGE` with explanatory comments.

---

### Review Findings

_Code review 2026-08-21 (Opus 5, self-review — same model that implemented; independence is weaker than a cross-model review)._

- [ ] [Review][Decision] **AC-5 and AC-7 contradict each other — one health URL cannot verify a targeted deploy** — The workflow pushes a per-restaurant pointer tag (`stable-<restaurant>`) but always polls a single `DEPLOY_HEALTH_URL` secret. Deploying to restaurant B verifies restaurant A's health, and a failure would revert B's tag based on A's state. Options: A) make the health URL a per-restaurant lookup (repository variable keyed by scope, or a JSON map secret); B) accept a single-restaurant pipeline for v1 and remove the `restaurant` input until Epic 12; C) require the health URL as a `workflow_dispatch` input alongside `restaurant`.
- [ ] [Review][Decision] **`GHCR_IMAGE` defaults to a personal repository** [`docker-compose.yml:9`] — `ghcr.io/ktneranga/carpediem-impl` is the fallback when the variable is unset. For a product intended to ship to multiple restaurants, any misconfigured deployment silently pulls from one individual's GitHub account. Options: A) remove the default so the variable is mandatory and the stack fails loudly; B) move the image under a GitHub organisation and default to that; C) accept for v1 while there is one restaurant.
- [ ] [Review][Decision] **`REPO_PASS` is readable via `docker inspect`** [`docker-compose.yml:96`] — The GHCR pull token sits in the Watchtower service environment, visible to anyone who can reach the Docker socket. Portainer is now bound to all interfaces and mounts that socket, so the exposure chain is real. Options: A) mount a pre-authenticated `~/.docker/config.json` read-only into Watchtower instead; B) use Docker secrets; C) accept — the token is `read:packages` scope only.
- [ ] [Review][Patch] **Health-check deadline equals the Watchtower poll interval — guaranteed false reverts** [`.github/workflows/deploy.yml:155`] — `DEADLINE=$(( SECONDS + 300 ))` while `WATCHTOWER_POLL_INTERVAL=300`. In the worst case Watchtower has not even pulled the new image when the deadline expires, so the job fails, reverts a perfectly good release, and reports a false alarm. The deadline must exceed poll interval + container start + migration time. Raise to ~600s and add an initial grace sleep.
- [ ] [Review][Patch] **`.env.example` is excluded from git** [`.gitignore:34`] — the `.env*` pattern matches `.env.example`, so the template documenting every required variable is untracked. A fresh clone has no env reference at all, which breaks provisioning. Add a `!.env.example` negation and commit the file.
- [ ] [Review][Patch] **`docker compose up -d` now fails on a fresh server — image has never been published** [`docker-compose.yml:9`] — `app` was switched from `build:` to `image:`, but no image exists in GHCR yet because CI has never run. This breaks Story 1.4's AC-2 ("all 5 services start … within 60 seconds") and makes the outstanding 1.4 smoke test impossible. Either publish an image first, or document that the first bring-up must use `docker compose -f docker-compose.yml build`.
- [ ] [Review][Patch] **Proxy passes itself as the `Reflect.get` receiver** [`src/server/db/index.ts:48`] — `Reflect.get(real, prop, receiver)` sets `this` to the Proxy inside any accessor property, so a getter that reads another property re-enters the trap. Risk of infinite recursion or wrong values. Should be `Reflect.get(real, prop, real)`.
- [ ] [Review][Patch] **`verify` job uses `docker buildx` without setting up Buildx** [`.github/workflows/deploy.yml:196`] — the revert step calls `docker buildx imagetools create` on a runner where `docker/setup-buildx-action` never ran. It happens to work on current GitHub runners because buildx ships bundled, but the revert path is the last line of defence and should not rely on that. Add the setup step to the `verify` job.
- [ ] [Review][Patch] **`WATCHTOWER_CLEANUP=true` destroys the local-disk rollback path** [`docker-compose.yml:89`] — pruning the previous image after each update removes the "previous image on disk" recovery option named in the technical research doc. Registry-based revert still works, but the fastest local recovery is gone. Not required by any AC — either remove it or document the trade-off.
- [ ] [Review][Patch] **`pnpm db:generate` now throws without `DATABASE_URL`** [`drizzle.config.ts:6`] — `drizzle-kit generate` produces SQL from the schema and never connects to a database, but the new module-level throw fires before `defineConfig` runs. This is a regression on a normal development command. Guard only the paths that actually need a connection, or set a harmless placeholder when the command is `generate`.
- [ ] [Review][Patch] **Health check greps raw JSON substrings** [`.github/workflows/deploy.yml:162-163`] — `grep -q '"status":"ok"'` depends on the serializer emitting no spaces. Any change to the response formatting silently breaks the gate, and a broken gate fails open into a revert. Parse with `jq` instead.
- [ ] [Review][Patch] **`portainer/portainer-ce:latest` uses a mutable tag** [`docker-compose.yml:52`] — this story enforces "never `latest`" for the app image, then leaves a `latest` tag on the container that holds the Docker socket. An unattended Portainer major version change carries full host control. Pin to a specific version.
- [x] [Review][Defer] Proxy defines no `has`, `set`, or `ownKeys` traps [`src/server/db/index.ts:46`] — `'execute' in db` returns false and `Object.keys(db)` returns `[]`. No current call site depends on either; deferred until one does.
- [x] [Review][Defer] No pool shutdown path [`src/server/db/index.ts`] — the cached pool is never closed. Compounds the pre-existing missing SIGTERM handler from Story 1.1; deferred to that item.
- [x] [Review][Defer] `WATCHTOWER_HTTP_API_TOKEN` may still be empty [`docker-compose.yml:92`] — pre-existing from Story 1.4, mitigated by network isolation. Becomes live if the API port is ever published.

## Dev Notes

### Do Not Reinvent — These Already Exist

| Asset | Location | Built in |
|---|---|---|
| Multi-stage Dockerfile (4 stages) | `docker/Dockerfile` | Story 1.4 |
| Health endpoint `GET /api/health` | `src/app/api/health/route.ts` | Story 1.4 |
| Container healthcheck script | `docker/scripts/healthcheck.sh` | Story 1.4 |
| Migration runner | `docker/scripts/migrate.sh` | Story 1.3 |
| 5-service Compose stack | `docker-compose.yml` | Story 1.4 |
| Dev hot-reload overrides | `docker-compose.override.yml` | Story 1.4 |

**This story writes no Dockerfile and no health endpoint.** It writes a GitHub Actions workflow and adds labels/env to existing files.

### Runtime Facts You Must Not Contradict

- **`server.ts` is TypeScript and runs under `tsx`**, never `node`. `tsx` is in `dependencies` (moved there in Story 1.4) precisely because it is a production runtime need.
- `pnpm start` = `cross-env NODE_ENV=production tsx server.ts`. `cross-env` and `drizzle-kit` are devDependencies **installed in the production image on purpose** — do not switch the Dockerfile to `--prod` installs, it will break container start.
- The container CMD runs migrations first, then the server: `sh -c "sh docker/scripts/migrate.sh && pnpm start"`.
- Package manager is **pnpm** with `pnpm-lock.yaml`. Use `--frozen-lockfile`.
- Node 22 Alpine base.

### The Watchtower Reality — Design Rationale

Watchtower polls a registry, pulls a newer digest for a watched tag, then **stops the old container and starts the new one**. It does not call your application, does not wait for it to be healthy, and cannot roll back. The technical research report states this directly, citing Watchtower's maintainers recommending it for small self-hosted stacks rather than pipelines needing approvals and rollback.

This story therefore delivers the *effect* the epic wanted, using mechanisms that actually exist:

- **Delivery** — Watchtower watches a moving `stable` tag, scoped per restaurant.
- **Health gate** — GitHub Actions verifies `/api/health` *after* rollout, over Tailscale.
- **Rollback** — re-point `stable` to the previous digest; Watchtower pulls it on the next poll.

**Accepted limitations, stated in AC-9:** brief interruption during restart (5–15s), and revert bounded by the poll interval rather than instant. True zero-downtime needs `docker-rollout`, which the architecture names but which is out of scope here.

### Why `stable` and not `latest`

`stable` is also a moving tag, so the mutable-tag risk is not eliminated — it is *contained*. Every build additionally pushes an immutable `sha-<short-sha>` tag, so any historical build stays addressable and a revert is a tag re-point rather than a rebuild. `latest` is avoided because it is the conventional default that tooling pulls implicitly, making accidental deployment far easier.

### Verified Action Versions (2026-08)

```yaml
- uses: docker/login-action@v4          # verified current
- uses: docker/metadata-action@v6       # verified current
- uses: docker/build-push-action@v7     # verified current
- uses: docker/setup-buildx-action@v3   # NOT verified — check before use
- uses: actions/checkout@v4             # NOT verified — check before use
- uses: tailscale/github-action@v3      # NOT verified — check before use
```

Confirm the three unverified ones against their repos at implementation time. Pin to major version tags, not `@master`.

### Tailscale Access From CI

The runner must reach the restaurant server, which has no public ports (NFR-S5). Use an **ephemeral auth key** stored as a GitHub secret, not a reusable one — CI runners are disposable and should not accumulate stale tailnet nodes. Tag the CI node in your Tailscale ACLs so it can reach only `/api/health` on port 3000, not Portainer on 9000.

### Security Constraints

- `GITHUB_TOKEN` is sufficient for pushing to GHCR — do not add a PAT for pushes.
- The server-side pull PAT (`REPO_PASS`) needs `read:packages` **only**. Never a write-scoped token.
- Never echo `REPO_PASS`, `TAILSCALE_AUTHKEY`, or `SESSION_SECRET` into logs.
- `/api/health` is intentionally unauthenticated (Story 1.4) so Uptime Kuma and CI can poll it. Confirm it exposes no sensitive data before relying on it from CI.

### Previous Story Intelligence — Story 1.4

- **Story 1.4 is still in `review` and has not been smoke-tested.** `docker compose up -d` has never been run against the current compose file. If the stack does not build, that is a 1.4 problem, not a 1.5 problem — check there first.
- Story 1.4 just changed `portainer` and `uptime-kuma` from `127.0.0.1` binds to all-interface binds, with the firewall as the access control (`docker/FIREWALL.md`). If you touch port bindings, do not revert that.
- `PORTAINER_URL` was corrected to `http://portainer:9000`. Service names, not `localhost`, for cross-container URLs.
- Deferred from Story 1.4 and **still open** — relevant if you touch Watchtower config: `WATCHTOWER_HTTP_API_TOKEN` can be empty, leaving the Watchtower API unauthenticated. Currently mitigated by network isolation. If you expose the Watchtower HTTP API in this story, that item becomes live and must be fixed here.
- Deferred from Story 1.1 and still open: `server.ts` has no SIGTERM handler. Watchtower stopping the container drops in-flight requests. This makes the AC-9 interruption worse than it needs to be. Out of scope, but note it in Completion Notes if you observe it.

### Git History

Single commit (`7e4b28c initial commit`). No CI has ever run in this repo. `.github/` does not exist. You are creating the first workflow — there are no existing conventions to match.

### Project Structure Notes

New files:
```
.github/workflows/deploy.yml
```
Modified files:
```
docker-compose.yml          (Watchtower labels, scope, image ref)
docker-compose.override.yml (keep build: for local dev)
.env.example                (RESTAURANT_SCOPE, REPO_USER, REPO_PASS, GHCR_IMAGE)
drizzle.config.ts           (DATABASE_URL guard)
```

**Variance from architecture:** `architecture.md:290` specifies "Zero-downtime deployment via `docker-rollout` + `/api/health` gate." This story implements the health gate but **not** `docker-rollout`. Recorded as a deliberate deviation in AC-9. Flag it in Completion Notes so the architecture can be reconciled later.

### Testing Standards

No test framework is configured in this repo yet — `package.json` has no test script, and Vitest/Playwright are not installed. **Do not install one as part of this story**; that is unrelated scope.

Verify instead by:
1. `pnpm build` succeeds with no `DATABASE_URL` set (AC-8)
2. `npx tsc --noEmit` exits 0
3. `npx eslint` exits 0
4. Workflow YAML parses — `actionlint` if available, otherwise a YAML parse
5. Push to a throwaway branch with the trigger temporarily widened, confirm the image appears in GHCR, then revert the trigger

Record actual command output in the Debug Log. Do not claim a step passed without running it.

### References

- [Source: epics.md#Story-1.5] — original ACs, corrected above
- [Source: architecture.md:271-298#Infrastructure-and-Deployment] — CI/CD pipeline and GHCR intent
- [Source: architecture.md:290] — `docker-rollout` + health gate (partially deferred)
- [Source: research/technical-targeted-restaurant-update-delivery-docker-watchtower-research-2026-05-17.md] — Watchtower labels/scopes, tagging strategy, no-rollback limitation, HTTP API trigger, `docker-rollout`
- [Source: prd.md#NFR-I3] — updates delivered via Watchtower from GHCR
- [Source: prd.md#Integration-List] — GHCR, Tailscale as MVP integrations
- [Source: 1-4-configure-docker-compose-stack-and-health-endpoint.md] — Dockerfile structure, CMD, health endpoint, review findings
- [Source: deferred-work.md] — `drizzle.config.ts` assertion assigned to Story 1.5

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

```
npx tsc --noEmit                          → exit 0
npx eslint                                → exit 0 (1 pre-existing warning, src/server/socket/index.ts:5,
                                             unused eslint-disable directive — from Story 1.1, untouched)
env -u DATABASE_URL npx next build        → SUCCESS
                                             Route (app): / , /_not-found , /api/health  — all ƒ (Dynamic)
                                             BEFORE the db fix this FAILED:
                                             "Error: Failed to collect page data for /api/health"
YAML parse (js-yaml)                      → docker-compose.yml OK, docker-compose.override.yml OK,
                                             .github/workflows/deploy.yml OK
Scripted AC assertions (27 checks)        → ALL PASS
  5 services · all restart:unless-stopped · app uses image not build · no :latest ·
  app watchtower.enable=true + scope label · db/portainer/uptime-kuma NOT labeled ·
  WATCHTOWER_LABEL_ENABLE=true · --scope in command · REPO_USER/REPO_PASS present ·
  override restores build context+dockerfile · override sets watchtower.enable=false ·
  push:main trigger · workflow_dispatch inputs · packages:write · latest=false ·
  sha- tag · login-action@v4 · metadata-action@v6 · build-push-action@v7 ·
  file: docker/Dockerfile · verify job needs build · revert step if:failure() +
  imagetools create · AC-9 limitations documented
```

### Completion Notes List

**Significant find — Story 1.4's Docker build could never have succeeded.**

`src/server/db/index.ts` threw at **module load** when `DATABASE_URL` was absent. `next build` imports every route module while collecting page data, so the build died on `/api/health`. Story 1.4's Dockerfile runs `pnpm build` in its builder stage with no database present — meaning that image has never built successfully. Story 1.4 is still in `review` and was never smoke-tested, which is why this went unnoticed.

Fixed by deferring pool construction to first query behind a `Proxy`, preserving the existing `import { db }` call sites. Fail-fast behaviour is retained, just moved from import-time to first-use — a missing `DATABASE_URL` at runtime now throws on the first query, which `/api/health` already catches and reports as `503 { status: "degraded", db: "error" }`. This was required by AC-8; the task text anticipated only `drizzle.config.ts`, but the AC ("the build does not fail on a missing DATABASE_URL") could not be met without it.

**Delivery design.** Watchtower has no health gate and no rollback, so those guarantees are assembled in the workflow instead: Watchtower delivers on a scoped moving `stable` tag; GitHub Actions polls `/api/health` over Tailscale after rollout; on failure `stable` is re-pointed to the previously captured digest with `docker buildx imagetools create` (server-side, no rebuild) and Watchtower restores it on its next poll.

**`app` switched from `build:` to `image:`.** Watchtower cannot update a locally-built image. The override file now carries the full build block (context + dockerfile), which it previously inherited from the base — without that change local development would have broken.

**Safety choices not explicitly required by the ACs:**
- `WATCHTOWER_LABEL_ENABLE=true` makes updates strictly opt-in. Default Watchtower updates *every* container it can see — an unattended `postgres:17-alpine` major bump would be catastrophic. `db`, `portainer`, and `uptime-kuma` are deliberately unlabelled.
- `concurrency` group on the workflow prevents two runs racing to re-point the same pointer tag.
- Override sets `watchtower.enable=false` so a local Watchtower never replaces a container being actively edited.
- Tailscale CI access uses an **ephemeral** OAuth node tagged `tag:ci`; `.env.example` documents restricting it to port 3000 so CI cannot reach Portainer.

**NOT verified — requires a real environment:**
- AC-1 through AC-7 have **not been executed**. No workflow run has ever occurred; `.github/` did not exist before this story and the repo has a single commit.
- No image has been pushed to GHCR. Tag behaviour, digest capture, and the revert path are unexercised.
- Watchtower scoping/labels are structurally correct in the compose file but have never been observed applying an update.
- `docker compose up -d` was never run — Docker CLI invocations were blocked by the environment sandbox.
- Three action versions could not be verified and are marked inline in the story: `setup-buildx-action@v3`, `actions/checkout@v4`, `tailscale/github-action@v3`. Confirm before the first real run.

**Required GitHub secrets before first run:** `DEPLOY_HEALTH_URL`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`. Documented in `.env.example`.

**Deviation from architecture, carried forward:** `architecture.md:290` specifies zero-downtime via `docker-rollout`. This story implements the health gate but not `docker-rollout`; restart interruption (5–15s) and eventually-consistent revert are documented in AC-9 and in the workflow header.

**Deferred item now live:** `WATCHTOWER_HTTP_API_TOKEN` may still be empty. The HTTP API was not exposed in this story, so it remains mitigated by network isolation — but `WATCHTOWER_HTTP_API_METRICS=true` is set, so if that port is ever published the token becomes mandatory.

### File List

- NEW: `.github/workflows/deploy.yml`
- UPDATE: `drizzle.config.ts` (explicit DATABASE_URL guard replacing `!` assertion)
- UPDATE: `src/server/db/index.ts` (lazy pool initialisation — unblocks `next build` without a database)
- UPDATE: `docker-compose.yml` (app → published image; Watchtower opt-in labels, scope, GHCR pull credentials)
- UPDATE: `docker-compose.override.yml` (full build block restored; local Watchtower opt-out)
- UPDATE: `.env.example` (GHCR_IMAGE, APP_TAG, RESTAURANT_SCOPE, REPO_USER, REPO_PASS, CI secret documentation)

### Change Log

- 2026-08-21: Story created. Acceptance criteria rewritten — the epics.md version specified Watchtower behavior that does not exist (health gate, rollback) and contained three stale technical facts (Dockerfile location, `node` vs `tsx`, `:latest` tagging).
- 2026-08-21: Story implemented. GitHub Actions build/push to GHCR with immutable `sha-` tags plus a moving scoped pointer tag; post-deploy health verification over Tailscale; automatic pointer-tag revert on failure. Watchtower switched to explicit label opt-in with per-restaurant scoping. Fixed a latent build-blocking defect in `src/server/db/index.ts` that would have prevented the Docker image from ever building.
