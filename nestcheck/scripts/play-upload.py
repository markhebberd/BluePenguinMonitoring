#!/usr/bin/env python3
"""
Upload a signed nestcheck AAB to Google Play via the Play Developer API.

Nestcheck is a .NET (net9.0-android) app, so it has no Gradle project and
cannot use the Gradle Play Publisher plugin the Kotlin apps use. This script is
the .NET equivalent: it pushes an already-built, already-signed .aab straight to
the Play Developer API using the same account-wide service account.

Prereqs (one-time, on whatever machine runs this):
  pip install google-api-python-client google-auth
  A service-account JSON with Play access (see RELEASE.md). Default location:
  nestcheck/play-service-account.json (git-ignored).

Usage:
  python3 scripts/play-upload.py \
      bin/Release/net9.0-android/publish/nz.co.wildwatch.nestcheck-Signed.aab \
      --track internal

Tracks: internal | alpha (closed) | beta (open) | production.
The app currently lives on the 'internal' track only — promote in the Console.
"""
import argparse
import os
import sys

from google.oauth2 import service_account
from googleapiclient.discovery import build

PACKAGE = "nz.co.wildwatch.nestcheck"
DEFAULT_KEY = os.path.join(os.path.dirname(__file__), "..", "play-service-account.json")
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload a nestcheck AAB to Google Play.")
    ap.add_argument("aab", help="Path to the signed .aab")
    ap.add_argument("--track", default="internal",
                    help="Play track: internal (default) | alpha | beta | production")
    ap.add_argument("--key", default=DEFAULT_KEY,
                    help="Service-account JSON (default: nestcheck/play-service-account.json)")
    ap.add_argument("--status", default="completed",
                    help="Release status: completed (default) | draft | inProgress (staged)")
    args = ap.parse_args()

    if not os.path.isfile(args.aab):
        print(f"AAB not found: {args.aab}", file=sys.stderr)
        return 1
    if not os.path.isfile(args.key):
        print(f"Service-account key not found: {args.key}\n"
              f"Drop a copy at nestcheck/play-service-account.json (git-ignored) "
              f"or pass --key. See RELEASE.md.", file=sys.stderr)
        return 1

    creds = service_account.Credentials.from_service_account_file(args.key, scopes=SCOPES)
    svc = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)

    edit_id = svc.edits().insert(packageName=PACKAGE, body={}).execute()["id"]
    print(f"Opened edit {edit_id}")

    bundle = svc.edits().bundles().upload(
        packageName=PACKAGE, editId=edit_id,
        media_body=args.aab, media_mime_type="application/octet-stream",
    ).execute()
    version_code = bundle["versionCode"]
    print(f"Uploaded {os.path.basename(args.aab)} -> versionCode {version_code}")

    svc.edits().tracks().update(
        packageName=PACKAGE, editId=edit_id, track=args.track,
        body={"releases": [{"versionCodes": [str(version_code)], "status": args.status}]},
    ).execute()
    print(f"Assigned versionCode {version_code} to track '{args.track}' ({args.status})")

    svc.edits().commit(packageName=PACKAGE, editId=edit_id).execute()
    print(f"Committed. v{version_code} is live on '{args.track}'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
