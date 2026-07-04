# Nestcheck — Play Store release runbook

How the **nestcheck** Android app ships to Google Play. There are **two
independent release machines** — the **macOS** dev PC and the **devian (Linux)**
box — and **either can build and release on its own**. This app is deliberately
**not** covered by the repo's `DEPLOYMENT.md` (that's wildwatch, the web app).

## The one thing to understand first

Nestcheck is a **.NET app** (`net9.0-android`) — **not** Gradle. (The other Android
apps in this Play account — casper, shute, ssh-portal, avpn — are Kotlin/Gradle and
release with `./gradlew publishReleaseBundle`.) A nestcheck release is two steps:
**build** the signed AAB with `dotnet publish`, then **upload** it to Play.

Both machines have the full toolchain to do both steps:

| | macOS (this PC) | devian (Linux) |
|---|---|---|
| Build (`dotnet publish -c Release -f net9.0-android`) | ✅ | ✅ dotnet 9 + `android`/`maui-android` workloads, Java, Android SDK |
| Signing keystore + `secrets.props` | ✅ (git-ignored, present) | ✅ under `~/src/PenguinMonitor/nestcheck/` |
| Upload credential (account-wide SA) | drop `play-service-account.json` (git-ignored) | ✅ copies in the sibling app dirs |

Neither machine depends on the other.

---

## Shared setup

### The service account (same one the Gradle apps use)

- Identity: `devianplay-publisher@casper-deployer.iam.gserviceaccount.com` (GCP project `casper-deployer`).
- Granted access **account-wide** in Play Console → Users & permissions, so this one
  key publishes every app in the developer account — nestcheck included.
- Copies live on devian at `~/src/{casper,shute,ssh-portal,avpn}/play-service-account.json`
  (all identical).
- **Never commit it.** `.gitignore` blocks `play-service-account.json`. Place a
  git-ignored copy at `nestcheck/play-service-account.json` on whichever machine uploads.

### Signing keystore

`nestcheck/my-release-key.keystore` + `nestcheck/secrets.props`
(`KeystorePassword`, `SigningKeyPassword`) — both git-ignored, present on both machines.

---

## Step 1 — Bump the version (both files, kept in sync)

Every Play upload needs a **new, higher versionCode**; Play rejects a code it has
seen (pattern: versionName `XX.YY` ↔ versionCode `XXYY`):

- `PenguinMonitor.csproj` → `<ApplicationVersion>` (code) + `<ApplicationDisplayVersion>` (name)
- `AndroidManifest.xml` → `android:versionCode` + `android:versionName`

e.g. `38.14` / `3814` → `38.15` / `3815`.

## Step 2 — Build the signed AAB

```bash
cd nestcheck
dotnet publish -c Release -f net9.0-android
# -> bin/Release/net9.0-android/publish/nz.co.wildwatch.nestcheck-Signed.aab
```

Always ship the **`-Signed.aab`**, never the plain `.aab`.

## Step 3 — Upload to Play

### macOS (this PC)

```bash
cd nestcheck
python3 scripts/play-upload.py \
    bin/Release/net9.0-android/publish/nz.co.wildwatch.nestcheck-Signed.aab \
    --track internal
```

`scripts/play-upload.py` opens a Play edit, uploads the bundle, assigns it to the
track, and commits — printing the versionCode. One-time on this machine:
`pip install google-api-python-client google-auth`.

### devian (Linux)

> **TODO (Mark to fill in):** document the exact release command used on devian.
> devian builds independently (`dotnet publish` as above) — this section just needs
> the actual **upload** step it uses (the Gradle Play Publisher route, a script, or
> `scripts/play-upload.py`). Left as a stub deliberately rather than guessed.

### Tracks

The app currently lives on the **`internal`** testing track only. Progression is
`internal` → `alpha` (closed) → `beta` (open) → `production`. Promote by re-running
with `--track production`, or in the Console. For a staged production rollout add
`--status inProgress` instead of the default `completed`.

## Step 4 — Commit the version bump (after a successful upload)

```bash
git add nestcheck/PenguinMonitor.csproj nestcheck/AndroidManifest.xml
git commit -m "vXX.YY (XXYY) for Play"
```

(Matches existing history, e.g. `38.00 (3800) for Play`.)
