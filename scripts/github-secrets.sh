#!/usr/bin/env bash
#
# Prints the four repository secrets the Android workflow needs for signing.
# Run it yourself and paste the values into
#   GitHub → Settings → Secrets and variables → Actions → New repository secret
#
# The output contains your signing key. Do not paste it anywhere else, and do
# not commit it.
set -euo pipefail

props="${1:-src-tauri/gen/android/keystore.properties}"
if [ ! -f "$props" ]; then
  echo "No $props — build the app locally once so the keystore is set up." >&2
  exit 1
fi

get() { sed -n "s/^$1=//p" "$props"; }
keystore=$(get storeFile)

if [ ! -f "$keystore" ]; then
  echo "Keystore $keystore is missing." >&2
  exit 1
fi

echo "ANDROID_KEYSTORE_BASE64:"
base64 -w0 "$keystore"
printf '\n\n'
echo "ANDROID_KEYSTORE_PASSWORD: $(get storePassword)"
echo "ANDROID_KEY_ALIAS:         $(get keyAlias)"
echo "ANDROID_KEY_PASSWORD:      $(get keyPassword)"
