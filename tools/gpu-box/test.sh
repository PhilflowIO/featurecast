#!/usr/bin/env bash
# Runs the recording test tier on a remote GPU host and brings its receipt back.
#
#   tools/gpu-box/test.sh
#
# Why: `*.gpu.test.ts` records, and a recording proves nothing on a software
# GL renderer — it runs at ~17fps while every frame-count and duration check
# still passes (src/renderer.ts). No hosted CI runner has a GPU, so this tier
# cannot live in the public check. It runs here instead and leaves
# docs/evidence/gpu-tier/latest.json behind; tests/gpu-receipt.test.ts reads
# that file from the portable tier and turns the public check red whenever
# the recorder has moved since this script last ran.
#
# Same host, image and safety rails as tools/gpu-box/record.sh: it refuses a
# busy GPU, copies only tracked files, and installs nothing outside the
# checkout directory and the image.
#
# Environment (all optional):
#   FEATURECAST_BOX          ssh target            default phil@192.168.178.139
#   FEATURECAST_BOX_GPU      GPU index             default 1
#   FEATURECAST_BOX_DIR      remote checkout dir   default featurecast-test
#   FEATURECAST_BOX_IMAGE    image tag             default featurecast-record:1
#   FEATURECAST_BOX_MAX_UTIL refuse above this GPU utilization in %, default 20
set -euo pipefail

BOX=${FEATURECAST_BOX:-phil@192.168.178.139}
GPU=${FEATURECAST_BOX_GPU:-1}
DIR=${FEATURECAST_BOX_DIR:-featurecast-test}
IMAGE=${FEATURECAST_BOX_IMAGE:-featurecast-record:1}
MAX_UTIL=${FEATURECAST_BOX_MAX_UTIL:-20}
SSH=(ssh -o IdentitiesOnly=yes "$BOX")
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

util=$("${SSH[@]}" nvidia-smi --id="$GPU" --query-gpu=utilization.gpu --format=csv,noheader,nounits | tr -d ' ')
if ((util > MAX_UTIL)); then
  echo "GPU $GPU on $BOX is at ${util}% (limit ${MAX_UTIL}%); not competing with it" >&2
  exit 3
fi

"${SSH[@]}" mkdir -p "$DIR"
git -C "$ROOT" ls-files -z --cached --others --exclude-standard |
  rsync -a --delete-missing-args --from0 --files-from=- \
    --exclude .git --exclude node_modules --exclude artifacts \
    --exclude auth --exclude .box-browsers \
    -e "ssh -o IdentitiesOnly=yes" "$ROOT/" "$BOX:$DIR/"

if ! "${SSH[@]}" docker image inspect "$IMAGE" >/dev/null 2>&1; then
  "${SSH[@]}" docker build -t "$IMAGE" - <"$ROOT/tools/gpu-box/Dockerfile"
fi

# The receipt names the host it was earned on, and the container does not
# know it. The tier itself refuses a software renderer, so nothing here can
# fake a GPU that was not present.
box_host=$("${SSH[@]}" hostname)

"${SSH[@]}" "cd $DIR && docker run --rm \
  --gpus device=$GPU -e NVIDIA_DRIVER_CAPABILITIES=all --ipc=host \
  --user \$(id -u):\$(id -g) -e HOME=/tmp -e SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 \
  -e FEATURECAST_RECEIPT_HOST=$(printf '%q' "$box_host") \
  -v \$PWD:/work -w /work -e PLAYWRIGHT_BROWSERS_PATH=/work/.box-browsers \
  $IMAGE bash -c 'pnpm install --frozen-lockfile --reporter=silent \
    && pnpm exec playwright install chromium >/dev/null \
    && pnpm exec vitest run --project gpu \
         --reporter=default --reporter=json --outputFile.json=artifacts/gpu-tier/vitest.json \
    && pnpm exec tsx tools/gpu-box/write-receipt.ts artifacts/gpu-tier/vitest.json'"

rsync -a -e "ssh -o IdentitiesOnly=yes" \
  "$BOX:$DIR/docs/evidence/gpu-tier/latest.json" \
  "$ROOT/docs/evidence/gpu-tier/latest.json"
echo "receipt: $ROOT/docs/evidence/gpu-tier/latest.json — commit it."
