#!/usr/bin/env bash
# Records a featurecast script on a remote GPU host and brings the clip back.
#
#   tools/gpu-box/record.sh demo/raven-startseite.ts --devices desktop-wide
#
# Why: a recording paints every frame of the page it films. On a loaded or
# GPU-less machine the page presents a scroll at 20-30 fps instead of 60 and
# at under half its scripted pace, and the clip judders even though every
# frame-count check passes (featurecast#150). A quiet host with a real GPU
# removes both. Measurements: docs/CAPTURE-CADENCE.md, "Recording host".
#
# What it does, in order:
#   1. refuses if the chosen GPU is busy (other jobs come first),
#   2. copies the tracked files of this checkout to the host (no .git, no
#      node_modules, no artifacts; auth/ only with FEATURECAST_BOX_SYNC_AUTH=1,
#      because a stored session is a login),
#   3. builds the container image from tools/gpu-box/Dockerfile if missing,
#   4. installs dependencies and the pinned browser from the lockfile inside
#      the container, into the remote checkout,
#   5. runs `featurecast run` there with that GPU and copies the output back
#      to the same --out a local run would use.
#
# Environment (all optional):
#   FEATURECAST_BOX          ssh target            default phil@192.168.178.139
#   FEATURECAST_BOX_GPU      GPU index             default 1
#   FEATURECAST_BOX_DIR      remote checkout dir   default featurecast-run (under $HOME)
#   FEATURECAST_BOX_IMAGE    image tag             default featurecast-record:1
#   FEATURECAST_BOX_MAX_UTIL refuse above this GPU utilization in %, default 20
#   FEATURECAST_BOX_SYNC_AUTH=1  also copy auth/ (signed-in recordings)
#
# The host needs docker with the NVIDIA container toolkit and nothing else;
# nothing is installed on it outside the checkout directory and the image.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <script.ts> [featurecast run options]" >&2
  exit 2
fi

BOX=${FEATURECAST_BOX:-phil@192.168.178.139}
GPU=${FEATURECAST_BOX_GPU:-1}
DIR=${FEATURECAST_BOX_DIR:-featurecast-run}
IMAGE=${FEATURECAST_BOX_IMAGE:-featurecast-record:1}
MAX_UTIL=${FEATURECAST_BOX_MAX_UTIL:-20}
SSH=(ssh -o IdentitiesOnly=yes "$BOX")
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

script=$1
shift
out=artifacts/$(basename "$script" .ts)
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ ${args[$i]} == --out ]]; then
    echo "--out is chosen by this wrapper ($out); drop it" >&2
    exit 2
  fi
done

util=$("${SSH[@]}" nvidia-smi --id="$GPU" --query-gpu=utilization.gpu --format=csv,noheader,nounits | tr -d ' ')
if ((util > MAX_UTIL)); then
  echo "GPU $GPU on $BOX is at ${util}% (limit ${MAX_UTIL}%); not competing with it" >&2
  exit 3
fi

"${SSH[@]}" mkdir -p "$DIR"
excludes=(--exclude .git --exclude node_modules --exclude artifacts --exclude .box-browsers)
[[ ${FEATURECAST_BOX_SYNC_AUTH:-0} == 1 ]] || excludes+=(--exclude auth)
git -C "$ROOT" ls-files -z --cached --others --exclude-standard |
  rsync -a --from0 --files-from=- "${excludes[@]}" \
    -e "ssh -o IdentitiesOnly=yes" "$ROOT/" "$BOX:$DIR/"
if [[ ${FEATURECAST_BOX_SYNC_AUTH:-0} == 1 && -d $ROOT/auth ]]; then
  rsync -a -e "ssh -o IdentitiesOnly=yes" "$ROOT/auth/" "$BOX:$DIR/auth/"
fi

if ! "${SSH[@]}" docker image inspect "$IMAGE" >/dev/null 2>&1; then
  "${SSH[@]}" docker build -t "$IMAGE" - <"$ROOT/tools/gpu-box/Dockerfile"
fi

remote_out=$(printf '%q' "$out")
remote_args=$(printf '%q ' "${args[@]}")
"${SSH[@]}" "cd $DIR && rm -rf $remote_out && docker run --rm \
  --gpus device=$GPU -e NVIDIA_DRIVER_CAPABILITIES=all --ipc=host \
  --user \$(id -u):\$(id -g) -e HOME=/tmp -e SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 \
  -v \$PWD:/work -w /work -e PLAYWRIGHT_BROWSERS_PATH=/work/.box-browsers \
  $IMAGE bash -c 'pnpm install --frozen-lockfile --reporter=silent \
    && pnpm exec playwright install chromium >/dev/null \
    && pnpm exec tsx src/cli.ts run $(printf '%q' "$script") --out $remote_out $remote_args'"

mkdir -p "$ROOT/$out"
rsync -a --delete -e "ssh -o IdentitiesOnly=yes" "$BOX:$DIR/$out/" "$ROOT/$out/"
echo "fetched: $ROOT/$out"
