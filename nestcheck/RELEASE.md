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

### Android API 36 (required — Play refuses anything lower)

Since Sep 2026 Play rejects an upload at commit time with **"Target SDK of artifact is
too low"** unless it targets API 36. v3962 was the last build accepted at 35. Both
machines therefore need the API 36 toolchain, or a build here will quietly produce an
artifact Play won't take:

```bash
dotnet workload install android-36
sdkmanager "platforms;android-36" "build-tools;36.0.0"
```

The project pins `<TargetFramework>net9.0-android36.0</TargetFramework>` — pinned, not
plain `net9.0-android`, which follows whichever platform happens to be installed and so
builds a 35 artifact on a machine that hasn't been updated. `AndroidManifest.xml` carries
the matching `android:targetSdkVersion="36"`.

Behaviour changes that came with it, and where they stand:

- **Edge-to-edge is enforced** and the opt-out flag is ignored. Already handled — the root
  scroll view and both tag-mode bars pad themselves by the system insets and the display
  cutout (`UI/Utils/ViewInsetsListener.cs`).
- **`screenOrientation` is ignored on screens ≥600dp.** MainActivity asks for portrait and
  still gets it on phones; on a large tablet it will rotate. No field device is affected.
- **16 KB memory pages.** The .NET runtime's native libraries are built with `0x4000`
  segment alignment, so they load on 16 KB devices; nothing to do.

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
dotnet publish -c Release -f net9.0-android36.0
# -> bin/Release/net9.0-android36.0/publish/nz.co.wildwatch.nestcheck-Signed.aab
```

Always ship the **`-Signed.aab`**, never the plain `.aab`.

## Step 3 — Upload to Play

### macOS (this PC)

```bash
cd nestcheck
python3 scripts/play-upload.py \
    bin/Release/net9.0-android36.0/publish/nz.co.wildwatch.nestcheck-Signed.aab \
    --track internal
```

`scripts/play-upload.py` opens a Play edit, uploads the bundle, assigns it to the
track, and commits — printing the versionCode. One-time on this machine:
`pip install google-api-python-client google-auth`.

### devian (Linux)

Same script. Repo lives at `~/src/PenguinMonitor`; the service-account key sits at
`nestcheck/play-service-account.json` (git-ignored, same account-wide SA as the
sibling app dirs). `google-api-python-client` is installed system-wide.

devian builds with a **clean build** rather than publish (never trust incremental
output for a release) — the signed AAB lands directly in the build dir, not
`publish/`:

```bash
cd ~/src/PenguinMonitor
rm -rf nestcheck/bin/Release nestcheck/obj/Release
dotnet build nestcheck/PenguinMonitor.csproj -c Release --no-incremental

cd nestcheck
python3 scripts/play-upload.py \
    bin/Release/net9.0-android36.0/nz.co.wildwatch.nestcheck-Signed.aab \
    --track internal
```

Before building, always `git pull` **and** check the highest versionCode already on
Play (releases happen from both machines, so local git can be behind Play — in
Jul 2026 a stale build shipped as 3807 missing 3803–3806 features):

```bash
cd nestcheck
python3 - <<'EOF'
from google.oauth2 import service_account
from googleapiclient.discovery import build
creds = service_account.Credentials.from_service_account_file(
    "play-service-account.json",
    scopes=["https://www.googleapis.com/auth/androidpublisher"])
svc = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)
pkg = "nz.co.wildwatch.nestcheck"
edit = svc.edits().insert(packageName=pkg, body={}).execute()
codes = [b["versionCode"] for b in svc.edits().bundles().list(
    packageName=pkg, editId=edit["id"]).execute().get("bundles", [])]
svc.edits().delete(packageName=pkg, editId=edit["id"]).execute()
print("highest on Play:", max(codes))
EOF
```

devian also sideloads test **APKs** (not AABs) to Google Drive for the field team:

```bash
rclone delete "devian:apks/NestCheck-38.apk"   # Drive duplicates instead of overwriting
rclone copyto <local-apk> "devian:apks/NestCheck-38.apk"
```

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
