---
stepsCompleted: [1, 2]
inputDocuments: []
workflowType: 'research'
lastStep: 1
research_type: 'technical'
research_topic: 'targeted restaurant update delivery using Docker and Watchtower'
research_goals: 'Understand how to push feature updates to a specific restaurant using Docker + Watchtower — image tagging strategies, per-restaurant control, rollback, and safe delivery patterns'
user_name: 'Teran'
date: '2026-05-17'
web_research_enabled: true
source_verification: true
---

# Research Report: Technical

**Date:** 2026-05-17
**Author:** Teran
**Research Type:** Technical

---

## Research Overview

[Research overview and methodology will be appended here]

---

<!-- Content will be appended sequentially through research workflow steps -->

## Technical Research Scope Confirmation

**Research Topic:** targeted restaurant update delivery using Docker and Watchtower
**Research Goals:** Understand how to push feature updates to a specific restaurant using Docker + Watchtower — image tagging strategies, per-restaurant control, rollback, and safe delivery patterns

**Technical Research Scope:**

- Architecture Analysis - design patterns, frameworks, system architecture
- Implementation Approaches - development methodologies, coding patterns
- Technology Stack - languages, frameworks, tools, platforms
- Integration Patterns - APIs, protocols, interoperability
- Performance Considerations - scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** 2026-05-17

---

## Technology Stack Analysis

### Watchtower — Per-Container Update Control

Watchtower is the core update delivery engine. It supports Docker labels that override global settings on a per-container basis, allowing explicit opt-in/opt-out of automatic updates per restaurant.

**Key labels:**

| Label | Value | Effect |
|---|---|---|
| `com.centurylinklabs.watchtower.enable` | `true` / `false` | Include or exclude a container from updates |
| `com.centurylinklabs.watchtower.monitor-only` | `true` | Detect new images but don't apply — useful for staging |
| `com.centurylinklabs.watchtower.scope` | `restaurant-A` | Isolate a Watchtower instance to only manage containers with the same scope value |
| `com.centurylinklabs.watchtower.no-pull` | _(flag)_ | Skip pulling new images for a specific container |

**Opt-in model (recommended for production):** Setting `WATCHTOWER_LABEL_ENABLE=true` on the Watchtower container switches it to explicit opt-in — it only updates containers that have `com.centurylinklabs.watchtower.enable=true`. This is the safest model: new containers are ignored by default unless explicitly tagged for updates.

**Scope-based isolation:** Multiple Watchtower instances can run on the same Docker host using `--scope`. A Watchtower scoped to `restaurant-A` only monitors containers labelled `scope=restaurant-A`. This is the mechanism for targeting one restaurant without affecting others.

_Source: [Container Selection — Watchtower](https://containrrr.dev/watchtower/container-selection/), [Per-Container Update Configuration with Watchtower — OneUptime](https://oneuptime.com/blog/post/2026-03-20-per-container-update-watchtower-portainer/view)_

---

### Docker Image Tagging Strategy

**Never use `:latest`.** Over 73% of production container outages stem from environment inconsistencies caused by mutable tags like `:latest` — when a new image is pushed with the same tag, Watchtower silently pulls it everywhere.

**Recommended tagging approaches for per-restaurant targeting:**

| Strategy | Example Tag | Use Case |
|---|---|---|
| Semantic versioning | `v1.5.0` | Standard release — all restaurants eligible |
| Restaurant-pinned | `v1.5.0-restaurant-A` | Feature only for Restaurant A |
| Commit hash | `v1.5.0-a1b2c3d` | Traceability and exact rollback |
| Environment prefix | `prod-v1.5.0` | Separate staging/production streams |

**Best practice:** Combine semantic version + short commit hash — `v1.5.0-g16af2b`. Organizations adopting commit-based labelling saw a **54% decrease in rollback times** due to improved reproducibility.

_Source: [Docker Image Tagging Strategies — Podostack](https://podostack.com/p/docker-image-tagging-strategies), [Essential Guide to Docker Image Tagging — Moldstud](https://moldstud.com/articles/p-essential-guide-how-to-use-tags-for-versioning-docker-images-effectively)_

---

### GitHub Actions → GHCR Pipeline

The standard build-and-push pipeline for targeting a specific restaurant:

**Tools used:**
- `docker/login-action` — authenticate to GHCR using `GITHUB_TOKEN` (no secrets to manage)
- `docker/metadata-action` — auto-generate tags from branch, commit SHA, and semantic version
- `docker/build-push-action` — build and push with generated tags
- `docker/setup-buildx-action` — enables multi-platform builds

**Per-restaurant tag flow:**

```
Trigger: workflow_dispatch with input: restaurant=restaurant-A, version=v1.5.2
→ Build image
→ Push as: ghcr.io/org/carpe-diem:v1.5.2-restaurant-A
→ Watchtower on Restaurant A's server detects new image (scope matches)
→ Pulls and restarts app container
→ Restaurant B is unaffected (different scope, different tag)
```

_Source: [Publishing Docker Images — GitHub Docs](https://docs.github.com/en/actions/publishing-packages/publishing-docker-images), [GitHub Actions Docker Builds — OneUptime](https://oneuptime.com/blog/post/2025-12-20-github-actions-docker-builds/view)_

---

### Development Tools and Platforms

| Tool | Role |
|---|---|
| **GHCR** (GitHub Container Registry) | Private image registry — free for private repos, integrated with GitHub Actions |
| **Watchtower** | Auto-update agent running on each restaurant's local server |
| **Docker Compose** | Defines per-restaurant service config including image tag and scope labels |
| **Portainer** (optional) | Visual management UI for monitoring container state across restaurants |
| **Docker Hub** | Alternative registry — public, rate-limited on free tier |

---

### Technology Adoption Trends

- **Watchtower scopes are the emerging standard** for multi-site Docker deployments — replacing manual SSH-based update scripts
- **`:latest` avoidance is now mainstream** — immutable semantic tags are the industry default for production
- **GitHub Actions + GHCR** has become the dominant free CI/CD pipeline for container workflows in 2025-2026
- **Portainer** is gaining adoption as a lightweight visual layer over Docker Compose for non-technical operators
- **HTTP API triggering** (Watchtower's `/v1/update` endpoint) is an emerging pattern for event-driven updates rather than polling intervals

_Source: [Full Watchtower Docker Automatic Update Guide — watchtowerdocker.com](https://watchtowerdocker.com/2026/04/04/watchtower-docker-automatic-update/), [Docker Registry Setup 2025 — dasroot.net](https://dasroot.net/posts/2025/12/docker-registry-setup-and-image/)_

---

## Integration Patterns Analysis

### API Design Patterns — Watchtower HTTP API

Watchtower exposes an HTTP API (`--http-api-update` flag) that allows external systems to trigger container updates on demand rather than waiting for the polling interval.

**Primary endpoint:**
```
POST /v1/update
Authorization: Bearer <token>
```

**Target a specific image (not all containers):**
```bash
curl -H "Authorization: Bearer mytoken" \
  "localhost:8080/v1/update?image=ghcr.io/org/carpe-diem"
```

This means GitHub Actions can **push an image then immediately call the restaurant's Watchtower API** to trigger the update in seconds — no waiting for the next polling cycle.

**Configuration:**
```yaml
watchtower:
  environment:
    - WATCHTOWER_HTTP_API_UPDATE=true
    - WATCHTOWER_HTTP_API_TOKEN=your-secret-token
  ports:
    - "8080:8080"
```

_Source: [HTTP API Mode — Watchtower](https://containrrr.dev/watchtower/http-api-mode/)_

---

### Communication Protocol — GitHub Actions → Restaurant Server

Two integration patterns for triggering updates from GitHub Actions to a specific restaurant server:

**Pattern A — Poll-based (Watchtower default):**
```
Developer pushes image → GHCR → Watchtower polls on interval (every 5 min) → detects new digest → updates
```
Simple, no inbound connection needed. Latency = poll interval.

**Pattern B — Push-based via HTTP API (recommended):**
```
GitHub Actions → builds image → pushes to GHCR
                             → calls Watchtower /v1/update via Tailscale VPN
                             → immediate update, no poll wait
```
Requires the restaurant server to be reachable (via Tailscale), but gives instant, event-driven delivery.

**GitHub Actions `workflow_dispatch` for targeted deployment:**
```yaml
on:
  workflow_dispatch:
    inputs:
      restaurant:
        description: 'Target restaurant'
        type: choice
        options: [restaurant-A, restaurant-B, all]
        required: true
      version:
        description: 'Version to deploy (e.g. v1.5.2)'
        required: true
        type: string
```
Triggered manually from GitHub UI or programmatically: `gh workflow run deploy.yml -f restaurant=restaurant-A -f version=v1.5.2`

_Source: [Workflow Dispatch Inputs — GitHub Docs](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions), [Workflow Dispatch Guide — OneUptime](https://oneuptime.com/blog/post/2026-01-25-github-actions-workflow-dispatch/view)_

---

### Rollback Patterns

**Important caveat:** Watchtower itself has **no built-in rollback mechanism**. Its maintainers explicitly recommend it for small self-hosted stacks, not full production pipelines requiring approvals and rollback.

**Practical rollback strategy for Carpe Diem:**

| Approach | How |
|---|---|
| **Image tag rollback** | Update `docker-compose.yml` to previous version tag (`v1.5.1`), run `docker compose up -d` |
| **Previous image on disk** | Docker keeps the old image locally until pruned — `docker run` the old tag immediately |
| **Registry rollback** | Re-trigger GitHub Actions deploying the previous version tag to the restaurant |

**The key rule:** Because each release is tagged with an immutable version (`v1.5.1`, not `:latest`), rolling back is simply redeploying the previous tag. No data is affected — only the app container restarts; the database volume is untouched.

_Source: [Docker Image Rollback Best Practices — Docker Forums](https://forums.docker.com/t/docker-image-rollback-best-practices/40787), [Watchtower GitHub — containrrr](https://github.com/containrrr/watchtower)_

---

### Zero-Downtime Update Pattern

By default, Watchtower stops the old container then starts the new one — causing a brief downtime (typically 5–15 seconds for a Next.js app). For a restaurant mid-service, this is noticeable.

**Solution: `docker-rollout`** — a zero-downtime deployment tool for Docker Compose:
```bash
# Instead of: docker compose up -d app
docker rollout app
```
It scales the service to 2x, waits for the new container to pass its health check, then removes the old one. No downtime.

**Health check required in `docker-compose.yml`:**
```yaml
app:
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
    interval: 10s
    timeout: 5s
    retries: 3
```

_Source: [Docker Rollout — GitHub](https://github.com/wowu/docker-rollout), [Zero-Downtime Deployments Docker Compose — Virtualization Howto](https://www.virtualizationhowto.com/2025/06/docker-rollout-zero-downtime-deployments-for-docker-compose-made-simple/)_

---

### Integration Security Patterns

| Concern | Solution |
|---|---|
| Watchtower API exposed on LAN | Bind to localhost only; access via Tailscale VPN |
| GHCR authentication | Use `GITHUB_TOKEN` in Actions; `docker login ghcr.io` on server with PAT |
| Watchtower API token | Store as GitHub Actions secret; rotate periodically |
| Database not exposed | PostgreSQL binds to Docker internal network only, not host ports |
