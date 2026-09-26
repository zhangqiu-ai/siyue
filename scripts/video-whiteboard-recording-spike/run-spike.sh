#!/usr/bin/env bash
# Builds and runs the synthetic C10 recording spike.
# Requires only Xcode command line tools (swiftc, AVFoundation). ffmpeg is not used.
# All media is written inside the temporary output directory; nothing is uploaded.
set -euo pipefail

spike_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="${SPIKE_BUILD_DIR:-/tmp/vwspike-build}"
output_dir="${SPIKE_OUTPUT_DIR:-/tmp/siyue-video-whiteboard-spike}"
binary="${build_dir}/video-whiteboard-spike"
subcommand="${1:-all}"
shift || true

mkdir -p "${build_dir}"
# shellcheck disable=SC2046
xcrun swiftc -O -swift-version 5 -o "${binary}" $(find "${spike_dir}/Sources" -name '*.swift' | sort)

exec "${binary}" "${subcommand}" "$@" --output-dir "${output_dir}"
