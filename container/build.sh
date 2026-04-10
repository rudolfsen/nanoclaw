#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build lightweight image (no browser — used for regular chat)
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Build browser image (with Chromium — used for browser automation tasks)
if [ "$1" = "--with-browser" ] || [ "$2" = "--with-browser" ]; then
  echo ""
  echo "Building browser image..."
  ${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:browser" -f Dockerfile.browser .
  echo "Browser image: ${IMAGE_NAME}:browser"
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
