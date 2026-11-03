# Social CRM & LinkedIn Integration — Backend Handover & Deployment Checklist

## 1. Security & Secrets Notice (Item 16)
- **No plain-text secrets** are stored in this handover document.
- Rotate `LINKEDIN_CLIENT_SECRET` (and `LINKEDIN_PAGE_CLIENT_SECRET` if using a separate Community Management API app) in the LinkedIn Developer Portal and inject the rotated secret exclusively via the host `.env` file on the VPS (`/opt/leadersperformance/lp_backend/.env` for Staging, `/opt/leadersperformance-prod/lp_backend/.env` for Production).

---

## 2. LinkedIn App Architecture & Separate Page Connection (Items 7, 8, 9, 13)
- **Company Page Vanity URL:** `https://www.linkedin.com/company/lioneleersteling` (`LINKEDIN_ORGANIZATION_VANITY_NAME="lioneleersteling"`).
- **API Version:** Controlled from a single environment variable: `LINKEDIN_API_VERSION="202504"`.
- **Community Management API App Isolation:**
  - LinkedIn's **Community Management API** requires its own standalone LinkedIn Developer App and cannot share an app with consumer sign-in/posting products (`Sign In with LinkedIn using OpenID Connect` / `Share on LinkedIn`).
  - The backend isolates the two connections in `social_account_connections`:
    1. **`LINKEDIN_PAGE` (Company Page Analytics — Read-Only):**
       - OAuth endpoint: `GET /api/v1/social/linkedin/auth-url` (or `GET /api/v1/social/linkedin/page/auth-url`)
       - Scopes requested: `r_organization_social`, `rw_organization_admin` (read-only analytics scopes; never requests `w_member_social` or `w_organization_social`).
       - Optional dedicated app credentials: `LINKEDIN_PAGE_CLIENT_ID`, `LINKEDIN_PAGE_CLIENT_SECRET`, `LINKEDIN_PAGE_REDIRECT_URI` (falls back to `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` / `LINKEDIN_REDIRECT_URI` if only the page app is configured).
       - **Strict Isolation:** `LinkedInAdapter.getActiveConnection()` (used by the scheduler and publishing service) reads **only** `platform = 'LINKEDIN'` and never reads `LINKEDIN_PAGE` or `LINKEDIN_ACCESS_TOKEN`. Connecting the company page for analytics can **never** give the scheduler a token it can post with.
    2. **`LINKEDIN` (Personal Profile Publishing — Lionel Eersteling):**
       - OAuth endpoint: `GET /api/v1/social/linkedin/auth-url?target=member`
       - Scopes requested: `openid`, `profile`, `email`, `w_member_social`.
       - Blocked from publishing until `LINKEDIN_PUBLISHING_ENABLED="true"`.

---

## 3. Environment Variables (`.env`)

```env
# Kill switch — keep "false" until the owner explicitly authorizes going live
LINKEDIN_PUBLISHING_ENABLED="false"

# Single LinkedIn REST API version (replaces sunset 202401)
LINKEDIN_API_VERSION="202504"

# Company Page configuration (linkedin.com/company/lioneleersteling)
LINKEDIN_ORGANIZATION_VANITY_NAME="lioneleersteling"
LINKEDIN_ORGANIZATION_ID="<numeric-org-id>"
LINKEDIN_ORGANIZATION_URN="urn:li:organization:<numeric-org-id>"

# Dedicated Community Management API App (Page Analytics - LINKEDIN_PAGE)
LINKEDIN_PAGE_CLIENT_ID="<page-analytics-app-client-id>"
LINKEDIN_PAGE_CLIENT_SECRET="<rotated-secret-in-host-env-only>"
LINKEDIN_PAGE_REDIRECT_URI="https://staging.leadersperformance.ae/api/v1/social/linkedin/callback"

# Personal Profile Publishing App (Member Posting - LINKEDIN)
LINKEDIN_CLIENT_ID="<member-posting-app-client-id>"
LINKEDIN_CLIENT_SECRET="<rotated-secret-in-host-env-only>"
LINKEDIN_REDIRECT_URI="https://staging.leadersperformance.ae/api/v1/social/linkedin/callback"
```

---

## 4. Deployment Checklist (`feature/social-crm-backend`) (Item 17)

```bash
cd /opt/leadersperformance/lp_backend
git fetch origin
git checkout feature/social-crm-backend
git pull origin feature/social-crm-backend

# Verify .env has LINKEDIN_PUBLISHING_ENABLED="false" and LINKEDIN_API_VERSION="202504"
docker compose down
docker compose up -d --build
```

---

## 5. Going Live Procedure (When Owner Approves)
1. Set `LINKEDIN_PUBLISHING_ENABLED="true"` in `lp_backend/.env`.
2. Restart the backend container: `docker compose restart lp_backend` (or `docker compose up -d --build`).
3. **Past-Due Safety Gate (Item 4):** Any post that was approved while `LINKEDIN_PUBLISHING_ENABLED` was `false` or whose `scheduledFor` timestamp has already passed at go-live is automatically marked `FAILED` (with `approvalSignature` cleared) so old approvals are never auto-published in a batch. They must be re-approved with a fresh future schedule.
4. **CRM Delete Behavior (Item 18):** `DELETE /api/v1/content/posts/:id` removes only the CRM database record ("Remove from CRM"). Published posts on LinkedIn remain on LinkedIn and are linked via their real `urn:li:` URL.

