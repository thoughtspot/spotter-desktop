#!/usr/bin/env bash
# Imports the Developer ID certificate into a keychain this workflow owns, and
# points electron-builder at it through CSC_KEYCHAIN and CSC_NAME.
#
# electron-builder can do this itself when given CSC_LINK, but its own keychain
# setup fails on current macOS runners: `security set-key-partition-list`
# rejects the password of the keychain electron-builder just created, with
# "SecKeychainUnlock: The user name or passphrase you entered is not correct".
# That broke the 1.7.0 release while the certificate and both passwords were
# verified good, and it reproduces on the electron-builder version that shipped
# 1.6.0, so it is the runner rather than the tool version.
#
# Importing with -A grants access without needing set-key-partition-list at all.
# -A is broad, but this keychain exists for one job on an ephemeral runner and
# is destroyed with it.
set -euo pipefail

: "${CSC_LINK:?CSC_LINK is not set}"
: "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD is not set}"

KEYCHAIN="${RUNNER_TEMP:-/tmp}/signing.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
CERT="${RUNNER_TEMP:-/tmp}/certificate.p12"

cleanup() { rm -f "$CERT"; }
trap cleanup EXIT

echo "$CSC_LINK" | base64 --decode > "$CERT"
echo "certificate decoded: $(wc -c < "$CERT" | tr -d ' ') bytes"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
# Without this the keychain relocks on its own timer mid-build.
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$CERT" -k "$KEYCHAIN" -P "$CSC_KEY_PASSWORD" -A

# codesign only searches the keychains on the user search list.
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | head -1 | sed -E 's/.*"(.*)".*/\1/')"
if [ -z "$IDENTITY" ]; then
  echo "::error::No codesigning identity found after import"
  exit 1
fi
echo "signing identity: $IDENTITY"

# electron-builder rejects a CSC_NAME carrying the certificate-type prefix —
# it picks the certificate type itself and wants only the name. `security`
# prints the full string, so strip it back off.
CSC_NAME="${IDENTITY#Developer ID Application: }"
echo "CSC_NAME: $CSC_NAME"

{
  echo "CSC_KEYCHAIN=$KEYCHAIN"
  echo "CSC_NAME=$CSC_NAME"
} >> "$GITHUB_ENV"
