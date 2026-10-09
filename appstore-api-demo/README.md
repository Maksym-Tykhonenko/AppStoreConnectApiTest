# App Store Connect API demo

Educational tool to manage **many apps across many Apple developer accounts** via
the App Store Connect API. Node.js/Express backend + React Native (CLI) frontend.

What it does:

- Edit App Store **metadata** (Promotional Text / Keywords / Description / What's
  New / Support URL / Privacy Policy URL) and **fan-out translate** each field
  into every open locale (OpenAI), with per-field push/translate toggles.
- Add **locales** to the editable version.
- Upload **screenshots** to selected locales (auto display-type from image size).
- Upload **A/B test** (Product Page Optimization) screenshots per variant.
- **Telegram monitor**: polls every app and reports status changes (version
  state, removal from store, Game Center keyword-injection, A/B test status).
- **Change auditor**: manual per-app diff of the whole App Store Connect state.

Each app lives in its own account, so every request is authenticated with that
account's own ES256 JWT and can go through that app's own outbound proxy.

---

## Project structure

```
appstore-api-demo/
  backend/
    server.js         Express server + Telegram monitor (all endpoints)
    targets.js        Loads apps.json (the list of apps) + normalizes fields
    appstore.js       App Store Connect API wrapper (per-target auth + proxy)
    jwt.js            Per-account ES256 JWT (cached per keyId)
    proxy.js          Per-target outbound proxy (http/https/socks)
    screenshots.js    Screenshot + A/B-treatment upload (reserve→upload→commit)
    gameCenter.js     Game Center footprint (keyword-injection detector)
    statusStore.js    Monitor state (last status/version/since per app)
    auditor.js        Snapshot + diff of an app's ASC state
    audit.js          CLI for the change auditor
    telegram.js       Telegram bot messaging
    translate.js      OpenAI translation
    discover.js       Startup discovery log
    apps.json         YOUR apps (git-ignored — secrets)   ← see apps.json.example
    .env              Globals + single-app fallback (git-ignored)
    AutKeys/          Your AuthKey_*.p8 private keys (git-ignored)
  frontend/
    App.js            Tabs: Locales · Metadata · Screenshots · A/B test
    config.js         backendUrl (point at your machine's IP:3000)
```

---

## Setup

### 1. Backend config — `backend/apps.json`

The list of apps to work with. Copy `apps.json.example` → `apps.json` and fill in
one object per app (each with its own account credentials):

```json
[
  {
    "name": "My Game",
    "issuerId": "69a6de70-03db-47e3-e053-5b8c7c11a4d1",
    "keyId": "ABC123DEFG",
    "privateKeyPath": "./AutKeys/AuthKey_ABC123DEFG.p8",
    "appId": "1234567890",
    "proxyUrl": "socks5://user:pass@host:1080",
    "screenshotsDir": "./screenshots/my-game",
    "screenshotsDirForAb": "./screenshots/my-game-ab",
    "isGrey": false,
    "Jira": "1234 (Client)",
    "ignoreRemoved": false
  }
]
```

| Field | Meaning |
| --- | --- |
| `name` | Label shown in the app picker and Telegram reports. |
| `issuerId` | Issuer ID of **that app's account** (Users and Access → Integrations → App Store Connect API). |
| `keyId` | The API key's Key ID (10 chars). Must belong to the same account. |
| `privateKeyPath` | Path to that key's `.p8` (kept in `AutKeys/`). Apple issues a `.p8` once — it can't be re-downloaded. |
| `appId` | The app's numeric Apple ID (App Information → Apple ID). |
| `proxyUrl` | Optional per-app outbound proxy. Accepts `scheme://user:pass@host:port`, `host:port`, `host:port:user:pass`, or the scrambled `host:port@user:pass`. Empty → falls back to `.env` `PROXY_URL`. |
| `screenshotsDir` | Folder with this app's screenshots (auto display-type by pixel size). |
| `screenshotsDirForAb` | Base folder for A/B-test screenshots — inside it, subfolders `A` / `B` / `C` matched to Treatment A/B/C. |
| `isGrey` | `false` = actively watched (polled every interval, whole group reported on any change). `true` = hands-off (polled once a day, only for liveness + Game Center). |
| `Jira` | Free-form label shown in Telegram (`🎫 Jira: …`). |
| `ignoreRemoved` | `true` = never show/alert `🚫 Removed from the App Store` for this app (e.g. casino apps flagged CANNOT_SELL for known reasons). |
| `notPublishedYet` | `true` = always show `🆕 Not published yet (first release)` instead of `🚫 Removed` and never alert as removed — for a first release that isn't numbered 1.0 / 1.0.0 (e.g. v1.1). |

> If `apps.json` is missing, the backend falls back to a **single** app built from
> the `.env` vars (`ISSUER_ID` / `KEY_ID` / `PRIVATE_KEY_PATH` / `APP_ID`).

### 2. Backend globals — `backend/.env`

Copy `.env.example` → `.env`:

```
# Single-app fallback (used only when apps.json is absent):
ISSUER_ID=
KEY_ID=
PRIVATE_KEY_PATH=./AutKeys/AuthKey_ABC123DEFG.p8
APP_ID=

PORT=3000
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Default screenshots folder (per-app screenshotsDir overrides it):
SCREENSHOTS_DIR=./screenshots
# Optional: force one display type for all images (skip size detection):
SCREENSHOT_DISPLAY_TYPE=

# Default outbound proxy (per-app proxyUrl overrides it). Empty = direct:
PROXY_URL=

# Telegram monitor:
TELEGRAM_BOT_TOKEN=            # bot token from @BotFather (NOT a @username)
TELEGRAM_CHAT_ID=             # message the bot, then getUpdates → chat.id
STATUS_INTERVAL_MINUTES=30    # poll cadence for non-grey apps
STABLE_INTERVAL_HOURS=24      # poll cadence for grey apps (liveness + Game Center)
```

### 3. Frontend — `frontend/config.js`

Point `backendUrl` at your machine's LAN IP (the phone/simulator must reach it),
e.g. `http://192.168.0.10:3000`.

---

## Running

### Backend

```bash
cd appstore-api-demo/backend
npm install          # first time
npm start            # = node server.js   (or: npm run dev — auto-restart with --watch)
```

On start it logs each configured app + latest version, and (if a Telegram token
is set) turns on the monitor.

### Frontend (React Native CLI)

```bash
cd appstore-api-demo/frontend
npm install                                       # first time
cd ios && LANG=en_US.UTF-8 pod install && cd ..   # first time / after native dep changes
npm start                                         # Metro bundler (react-native start)
# in a second terminal:
npm run ios                                        # react-native run-ios  (or: npm run android)
```

> `LANG=en_US.UTF-8` before `pod install` avoids the CocoaPods `unicode_normalize`
> crash. The frontend sends `x-target-id` on every request to pick the app.

---

## Endpoints

The app sends the chosen app's index in the `x-target-id` header.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness check. |
| GET | `/targets` | List of apps to pick from (id, name, appId — no secrets). |
| GET | `/app` | Selected app's name / bundle id. |
| GET | `/status` | Latest version's review state (+ forSale/removed). |
| GET | `/locales` | Added + still-addable locales for the editable version. |
| POST | `/locales/add` | Add locales. |
| GET | `/metadata` | Current fields (prefilled from the primary locale). |
| PATCH | `/metadata` | Translate + push per-field values to every locale. |
| GET | `/screenshots` | Local screenshot files + version locales. |
| POST | `/screenshots/push` | Upload screenshots to selected locales. |
| GET | `/abtests` | A/B experiments + variants + per-variant local screenshots. |
| POST | `/abtests/screenshots/push` | Upload a variant's screenshots to selected treatment locales. |
| GET | `/telegram/test` | Send the current status digest now. |

---

## Telegram monitor

Polled every `STATUS_INTERVAL_MINUTES` (default 30). Messages are **change-only**.

- **Non-grey apps** (`isGrey: false`) — polled every tick. If ANY of them changed
  since the last poll, one message reports the current status of ALL non-grey
  apps. Watched signals: version state, forSale/removed, Game Center footprint,
  A/B test status.
- **Grey apps** (`isGrey: true`) — polled once every `STABLE_INTERVAL_HOURS`
  (default 24), only for **liveness** (removed from store) and **Game Center**
  changes. Version/state churn is ignored.

Each app block shows: `📱 name`, `🎫 Jira`, status line with a colour dot
(🔴 rejected · 🟢 ready · 🟡 waiting · 🟣 pending release · 🩷 in review · ⚪ other),
`🗓 since <date>`, and — when relevant — `🚫 Removed`/`🆕 Not published yet`,
`🎮 Game Center content live`, `🧪 A/B: …`.

"Removed" = not for sale in any territory **and** the app was published at some
point (a version reached READY_FOR_SALE); a never-published first release is
"Not published yet", not removed. `ignoreRemoved: true` suppresses it per app;
`notPublishedYet: true` forces "Not published yet" per app.

---

## Change auditor (manual)

Snapshots an app's full App Store Connect state and diffs it against the previous
snapshot — use it before/after giving someone access to an account.

```bash
cd appstore-api-demo/backend
node audit.js <id|name>   # audit one app (by id "2" or name substring)
node audit.js all         # audit every app
node audit.js             # list apps
```

First run captures a baseline; later runs report what changed (metadata, versions,
Game Center, IAP, users, …) into `audit.log`.

---

## Troubleshooting

- **`Could not read private key`** → check `privateKeyPath` and that the `.p8` exists in `AutKeys/`.
- **401** → issuerId/keyId don't match the key's account, or the key was revoked (auth error — appId doesn't affect it).
- **404** → wrong `appId` for that account (list the account's apps via the API to find the right one).
- **409** → the version isn't editable (already submitted / live).
- **422** → value rejected (too long / invalid).
- **502 / socket disconnected before TLS** → the proxy exit couldn't reach Apple. Try a fresh proxy session/country, or clear the proxy.
- **Screenshot "dimensions are wrong"** → the image size mapped to a display type the app's version doesn't use. Check `DIMENSION_MAP` in `screenshots.js` / the image pixel size.
- **`apps.json` / files vanish** → they're git-ignored and this folder isn't a git repo, so there's no safety net. Keep a copy outside the repo (or `git init` and commit — secrets stay ignored).
```

The frontend `config.js` `backendUrl` must be reachable from the device.

cd appstore-api-demo/backend
npm start

cd appstore-api-demo/frontend
npm start

lsof -ti:3000,8081 | xargs kill