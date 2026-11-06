# Social CRM & TikTok Integration — Frontend Developer Handover

**Target Audience:** Frontend Team (Asad)  
**Feature:** TikTok Social CRM Connection, Video Telemetry & Content Studio  
**Backend Base URL:**  
- **Staging:** `https://staging.leadersperformance.ae/api/v1`  
- **Local Dev:** `http://localhost:4000/api/v1`  
**Authentication Header:** `x-api-key: b8f9c1a2d4e7465b90a3f8c2e1d5b` (or pass `?api_key=b8f9c1a2d4e7465b90a3f8c2e1d5b`)

---

## 1. Executive Summary & Flow

The backend handles the entire TikTok OAuth 2.0 PKCE handshake, token refreshes, and TikTok Display API v2 telemetry.  
As the frontend engineer, you only need to integrate **5 clean REST endpoints**:

1. **OAuth Connect:** Trigger TikTok sign-in via 1-click redirect.
2. **Connection Status:** Render the connected/disconnected card in the Channels tab.
3. **Analytics & Video Telemetry:** Render account KPIs (followers, likes, video count) and the video performance grid (views, likes, shares).
4. **Account Disconnect:** Revoke token and reset connection state.
5. **Content Studio Publish / Draft:** Send approved video to TikTok Creator Inbox.

---

## 2. API Endpoints Reference

### Endpoint 1: Initiate TikTok Connect (OAuth 2.0)
Generates the cryptographically signed PKCE session and redirects the user to the official TikTok authorization screen.

* **Method:** `GET`
* **Path:** `/social/tiktok/auth-url`
* **Query Parameters:**
  * `return_to` *(optional)*: The frontend route where TikTok should redirect the user after authorization (e.g., `https://staging.leadersperformance.ae/social-crm/channels`).
* **Frontend Implementation (Button Click):**
  ```typescript
  const handleConnectTikTok = () => {
    const returnTo = encodeURIComponent(window.location.href);
    window.location.href = `${API_BASE_URL}/social/tiktok/auth-url?return_to=${returnTo}&api_key=${API_KEY}`;
  };
  ```
* **Post-Auth URL Query Params:**  
  When TikTok redirects back to your `return_to` URL, it appends:
  `?tiktok_connected=true&account=lioneleersteling`  
  Use this to trigger a success toast: *"TikTok account @lioneleersteling connected successfully!"*

---

### Endpoint 2: Get Connection Status
Returns the active state of the `@lioneleersteling` account.

* **Method:** `GET`
* **Path:** `/social/tiktok/status`
* **Headers:** `x-api-key: <API_KEY>`
* **Success Response (HTTP 200):**
  ```json
  {
    "success": true,
    "connected": true,
    "publishingEnabled": false,
    "status": "HEALTHY",
    "username": "lioneleersteling",
    "accountName": "Lionel Eersteling",
    "accountUrn": "-000qKCTvgGbZKXwqULEc8s7qdX8z1aJOTPh",
    "profileUrl": "https://www.tiktok.com/@lioneleersteling",
    "profilePictureUrl": "https://p16-common-sign.tiktokcdn-eu.com/...",
    "followersCount": 48886,
    "likesCount": 753777,
    "videoCount": 1192,
    "expiresAt": "2026-11-06T16:56:09.533Z"
  }
  ```
* **Disconnected Response (HTTP 200):**
  ```json
  {
    "success": true,
    "connected": false,
    "publishingEnabled": false,
    "status": "DISCONNECTED",
    "username": "lioneleersteling",
    "accountName": null,
    "followersCount": null,
    "message": "TikTok account not connected yet"
  }
  ```

---

### Endpoint 3: Fetch TikTok Analytics & Video Grid
Pulls real-time profile totals and the array of public videos with granular metrics.

* **Method:** `GET`
* **Path:** `/social/tiktok/analytics`
* **Headers:** `x-api-key: <API_KEY>`
* **Success Response (HTTP 200):**
  ```json
  {
    "success": true,
    "data": {
      "connected": true,
      "username": "lioneleersteling",
      "profileUrl": "https://www.tiktok.com/@lioneleersteling",
      "displayName": "Lionel Eersteling",
      "avatarUrl": "https://p16-common-sign.tiktokcdn-eu.com/...",
      "followers": 48886,
      "following": 33,
      "likes": 753777,
      "videoCount": 1192,
      "videos": [
        {
          "id": "7703644487695797536",
          "title": "Een patroon herken je niet aan wat iemand zegt...",
          "description": "Een patroon herken je niet aan wat iemand zegt...",
          "publishedAt": "2026-11-02T18:35:09.000Z",
          "durationSeconds": 18,
          "coverImageUrl": "https://p16-common-sign.tiktokcdn-eu.com/...",
          "shareUrl": "https://www.tiktok.com/@lioneleersteling/video/7703644487695797536",
          "views": 738,
          "likes": 12,
          "comments": 0,
          "shares": 1
        }
      ]
    }
  }
  ```

---

### Endpoint 4: Disconnect TikTok Account
Revokes credentials and transitions status to `DISCONNECTED`.

* **Method:** `POST`
* **Path:** `/social/tiktok/disconnect`
* **Headers:** `x-api-key: <API_KEY>`
* **Success Response (HTTP 200):**
  ```json
  {
    "success": true,
    "message": "Successfully disconnected TikTok account"
  }
  ```

---

### Endpoint 5: Publish / Send Video to TikTok (Content Studio)
Transfers an approved video to TikTok as a creator inbox draft or direct post.

* **Method:** `POST`
* **Path:** `/social/tiktok/publish`
* **Headers:**  
  * `Content-Type: application/json`
  * `x-api-key: <API_KEY>`
* **Request Body:**
  ```json
  {
    "videoUrl": "https://staging.leadersperformance.ae/uploads/video.mp4",
    "title": "Discipline is the foundation of executive performance. #leadership",
    "mode": "DRAFT",
    "privacyLevel": "PUBLIC_TO_EVERYONE"
  }
  ```
* **Payload Fields:**
  * `videoUrl` *(string, required)*: Public HTTPS link to the MP4 file.
  * `title` *(string, optional)*: Caption / hashtags (max 2200 chars).
  * `mode` *(string, default "DRAFT")*: `"DRAFT"` (inbox) or `"DIRECT_POST"`.
  * `privacyLevel` *(string)*: `"PUBLIC_TO_EVERYONE"` | `"MUTUAL_FOLLOW_FRIENDS"` | `"FOLLOWER_OF_CREATOR"` | `"SELF_ONLY"`.
* **Important Kill-Switch Handling:**  
  While TikTok API review is pending, `TIKTOK_PUBLISHING_ENABLED="false"`. If called, the backend returns:
  ```json
  {
    "success": false,
    "error": "TikTok publishing is currently disabled (TIKTOK_PUBLISHING_ENABLED=false)."
  }
  ```
  **Frontend UI Tip:** If `status.publishingEnabled === false`, display a badge:  
  *“Draft Mode Only — Live publishing awaiting TikTok review”* or disable the direct publish toggle.

---

## 3. TypeScript Interfaces (Copy & Paste for Frontend)

Save this in `src/types/tiktok.types.ts`:

```typescript
export interface TikTokStatusResponse {
  success: boolean;
  connected: boolean;
  publishingEnabled: boolean;
  status: 'HEALTHY' | 'DISCONNECTED' | 'EXPIRED' | 'ERROR';
  username: string;
  accountName: string | null;
  accountUrn?: string | null;
  profileUrl: string;
  profilePictureUrl?: string | null;
  followersCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
  expiresAt?: string | null;
  message?: string;
}

export interface TikTokVideoItem {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSeconds: number | null;
  coverImageUrl: string | null;
  shareUrl: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface TikTokAnalyticsResponse {
  success: boolean;
  data: {
    connected: boolean;
    username: string;
    profileUrl: string;
    displayName: string;
    avatarUrl: string | null;
    followers: number | null;
    following: number | null;
    likes: number | null;
    videoCount: number | null;
    videos: TikTokVideoItem[];
  };
}

export interface TikTokPublishPayload {
  videoUrl: string;
  title?: string;
  mode?: 'DRAFT' | 'DIRECT_POST';
  privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
}
```

---

## 4. Ready-to-Use API Client Service

Save this in `src/services/tiktokService.ts`:

```typescript
import { TikTokStatusResponse, TikTokAnalyticsResponse, TikTokPublishPayload } from '../types/tiktok.types';

const API_BASE = import.meta.env.VITE_API_URL || 'https://staging.leadersperformance.ae/api/v1';
const API_KEY = import.meta.env.VITE_CRM_API_KEY || 'b8f9c1a2d4e7465b90a3f8c2e1d5b';

const defaultHeaders = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
};

export const tiktokService = {
  getAuthUrl(returnTo?: string): string {
    const target = returnTo || window.location.href;
    return `${API_BASE}/social/tiktok/auth-url?return_to=${encodeURIComponent(target)}&api_key=${API_KEY}`;
  },

  async getStatus(): Promise<TikTokStatusResponse> {
    const res = await fetch(`${API_BASE}/social/tiktok/status`, { headers: defaultHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async getAnalytics(): Promise<TikTokAnalyticsResponse> {
    const res = await fetch(`${API_BASE}/social/tiktok/analytics`, { headers: defaultHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async disconnect(): Promise<{ success: boolean; message: string }> {
    const res = await fetch(`${API_BASE}/social/tiktok/disconnect`, {
      method: 'POST',
      headers: defaultHeaders,
    });
    return res.json();
  },

  async publish(payload: TikTokPublishPayload) {
    const res = await fetch(`${API_BASE}/social/tiktok/publish`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify(payload),
    });
    return res.json();
  },
};
```

---

## 5. UI Guidelines for Asad

1. **Format Telemetry Numbers:**
   * Use compact numbers (e.g., `48.9K` for `48886` followers, `753.8K` for `753777` likes).
2. **Handle Disconnected State Cleanly:**
   * If `connected === false`, display an inactive TikTok card with a prominent **"Connect with TikTok"** button linking to `tiktokService.getAuthUrl()`.
   * Never show fake zeroes or placeholder metrics when disconnected.
3. **Video Grid Display:**
   * Format `durationSeconds` as `MM:SS` (e.g. `18s` -> `00:18`).
   * Clicking a video card can open `video.shareUrl` directly on TikTok in a new tab.
4. **Toast Feedback:**
   * Check for `?tiktok_connected=true` on route load to display a green confirmation notification and clean up the query param with `window.history.replaceState`.

