# Social CRM & LinkedIn Integration — Backend Handover & Deployment Checklist

## 1. Security & Secrets Notice
- **No plain-text secrets** are stored in this handover document or in chat.
- Set `LINKEDIN_PAGE_CLIENT_SECRET` and `LINKEDIN_CLIENT_SECRET` only in the host `.env` file (`/opt/leadersperformance/lp_backend/.env` on Staging, local `lp_backend/.env` for local testing) and share local credentials only via an encrypted/safe channel (e.g. 1Password / Vault).

---

## 2. Step-by-Step: Creating the Standalone LinkedIn Page Analytics App
LinkedIn's **Community Management API** cannot share an app with consumer sign-in/posting products (`Sign In with LinkedIn` / `Share on LinkedIn`). Follow these steps in the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps/new):

1. **Create a Separate App for Page Analytics:**
   - **App name:** `Leaders Performance Analytics` (or `LP Social CRM Analytics`)
   - **LinkedIn Page:** `https://www.linkedin.com/company/lioneleersteling`
   - **App logo:** Upload the Leaders Performance logo and check the legal agreement box, then click **Create app**.
2. **Verify the App (Page Admin):**
   - Go to the **Settings** tab -> under **Company**, click **Verify** -> **Generate URL**.
   - Have **Lionel Eersteling** (as super admin of `linkedin.com/company/lioneleersteling`) open the verification URL and click **Verify**.
   - *(Tip: While in the Company Page admin view on LinkedIn, the URL in the browser address bar is `https://www.linkedin.com/company/<NUMERIC_ID>/admin/...` — copy that `<NUMERIC_ID>` for `LINKEDIN_ORGANIZATION_ID`.)*
3. **Request the Community Management API Product:**
   - Go to the **Products** tab of the new app.
   - Find **Community Management API** and click **Request access** (do **not** add *Share on LinkedIn* or *Sign In with LinkedIn* to this app).
4. **Register Authorized Redirect URLs:**
   - Go to the **Auth** tab -> under **OAuth 2.0 settings**, add both **Authorized redirect URLs for your app**:
     - `https://staging.leadersperformance.ae/api/v1/social/linkedin/callback`
     - `http://localhost:4000/api/v1/social/linkedin/callback`
   - Copy the **Client ID** (`LINKEDIN_PAGE_CLIENT_ID`) and **Primary Client Secret** (`LINKEDIN_PAGE_CLIENT_SECRET`).
5. *(For Later — Before Go-Live)*:
   - On the personal posting app (`LINKEDIN_CLIENT_ID`), also add `https://staging.leadersperformance.ae/api/v1/social/linkedin/callback` under **Auth -> Authorized redirect URLs** before enabling publishing.

---

## 3. Environment Variables (`.env`)

### Staging (`/opt/leadersperformance/lp_backend/.env`)
```env
LINKEDIN_PUBLISHING_ENABLED="false"
LINKEDIN_API_VERSION="202504"

LINKEDIN_PAGE_CLIENT_ID="<from-linkedin-page-app>"
LINKEDIN_PAGE_CLIENT_SECRET="<set-in-host-env-only>"
LINKEDIN_PAGE_REDIRECT_URI="https://staging.leadersperformance.ae/api/v1/social/linkedin/callback"

LINKEDIN_ORGANIZATION_ID="<numeric-org-id>"
LINKEDIN_ORGANIZATION_URN="urn:li:organization:<numeric-org-id>"
LINKEDIN_ORGANIZATION_VANITY_NAME="lioneleersteling"
```

### Local (`lp_backend/.env`)
```env
LINKEDIN_PUBLISHING_ENABLED="false"
LINKEDIN_API_VERSION="202504"

LINKEDIN_PAGE_CLIENT_ID="<from-linkedin-page-app>"
LINKEDIN_PAGE_CLIENT_SECRET="<set-in-local-env-only>"
LINKEDIN_PAGE_REDIRECT_URI="http://localhost:4000/api/v1/social/linkedin/callback"

LINKEDIN_ORGANIZATION_ID="<numeric-org-id>"
LINKEDIN_ORGANIZATION_URN="urn:li:organization:<numeric-org-id>"
LINKEDIN_ORGANIZATION_VANITY_NAME="lioneleersteling"
```

---

## 4. Safety & Verification Checks
1. **Strict Member Connection & Scope Block While Publishing is Off:**
   - While `LINKEDIN_PUBLISHING_ENABLED="false"`, `GET /api/v1/social/linkedin/auth-url?target=member` returns `403 Forbidden`, and no token with `w_member_social` or `w_organization_social` can be requested or stored.
   - `GET /api/v1/social/linkedin/auth-url?target=page` requests only `r_organization_social` and `rw_organization_admin`, and saves to `platform = 'LINKEDIN_PAGE'`.
2. **Post-Connection Verification:**
   - Once Lionel clicks **Connect company page** (`target=page`) in CRM -> Integrations:
     - `GET /api/v1/social/linkedin/status` returns:
       ```json
       {
         "success": true,
         "publishingEnabled": false,
         "pageConnected": true,
         "memberConnected": false
       }
       ```
     - `GET /api/v1/analytics/social/linkedin?range=30d` returns `connected: true` with live `followers` and `impressions` (and even if `LINKEDIN_ORGANIZATION_ID` was omitted, the backend auto-discovers and caches `urn:li:organization:<id>` from `/rest/organizations?q=vanityName&vanityName=lioneleersteling` or `/rest/organizationAcls?q=roleAssignee`).
