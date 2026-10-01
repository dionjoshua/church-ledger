# Church Ledger

A full-stack church administration and real-estate ledger system with:
- **Windows desktop app** (Electron)
- **Android mobile app** (WebView)
- **Cloud server** (Node.js, deployable on Railway)
- **Firebase Realtime Database** sync

## Features
- Sunday offering tracking with denomination breakdowns
- Tenant rent management and payment tracking
- Fixed deposits, refundable leases, and church loan records
- Personal financial ledger per mobile device
- PIN-protected church data access
- Cloud sync via Firebase or local WiFi server

## Running Locally (Desktop)

```bash
npm install
npm start
```

## Cloud Deployment (Railway)

The `server.js` file is the standalone cloud server. Deploy with:

1. Push this repo to GitHub (already done)
2. Go to [railway.app](https://railway.app) and create a new project from this GitHub repo
3. Railway auto-detects `server.js` and deploys it
4. Set the start command to: `node server.js`

## Android App

The APK is built with Android Studio. The mobile web app source is in the `mobile/` directory.
