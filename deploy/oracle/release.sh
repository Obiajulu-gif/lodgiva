# shellcheck shell=bash
# What a Lodgiva server image is, and how it is built.
#
# Sourced (never run) by setup.sh on a server and by the "Server image"
# GitHub workflow, so both name a release identically - a server pulls the
# image the workflow pushed only because the tags match.
#
# Needs release.lock in the current directory and LODGIVA_REF (the revision of
# this repository to take the control app from). Sets BASE_RELEASE,
# CONTROL_TREE, RELEASE and SERVER_IMAGE, and leaves the control app in
# control-src/.

# shellcheck disable=SC1091
. ./release.lock

SERVER_IMAGE="ghcr.io/obiajulu-gif/lodgiva-server"

pin() {  # pin <repo url> <branch or tag> <sha>: refuse a ref that has moved
  local got
  got="$(git ls-remote "$1" "refs/heads/$2" "refs/tags/$2^{}" "refs/tags/$2" | awk 'NR==1{print $1}')"
  if [ "$got" != "$3" ]; then
    echo "release.lock is stale: $1 $2 is ${got:-missing}, lock says $3." >&2
    echo "Bump release.lock deliberately, or set LODGIVA_REF to a release branch." >&2
    exit 1
  fi
}
pin https://github.com/frappe/frappe "$FRAPPE_BRANCH" "$FRAPPE_SHA"
pin https://github.com/frappe/payments "$PAYMENTS_REF" "$PAYMENTS_SHA"
pin https://github.com/Obiajulu-gif/lodgiva-pms "$PMS_REF" "$PMS_SHA"
pin https://github.com/Obiajulu-gif/lodgiva-nigeria "$NIGERIA_REF" "$NIGERIA_SHA"

# The control app lives in this repository. It is identified by its tree hash,
# not the commit, so a docs-only commit does not demand a new image.
rm -rf control-src && git init -q control-src
git -C control-src fetch -q --depth 1 https://github.com/Obiajulu-gif/lodgiva "$LODGIVA_REF"
git -C control-src checkout -q FETCH_HEAD -- frappe-apps/lodgiva_control
CONTROL_TREE="$(git -C control-src rev-parse FETCH_HEAD:frappe-apps/lodgiva_control)"

BASE_RELEASE="pms-${PMS_SHA:0:7}.ng-${NIGERIA_SHA:0:7}.pay-${PAYMENTS_REF}.frappe-${FRAPPE_BRANCH}"
RELEASE="${BASE_RELEASE}.ctl-${CONTROL_TREE:0:7}"

fetch_frappe_docker() {
  if [ ! -d frappe_docker/.git ]; then
    rm -rf frappe_docker && git init -q frappe_docker
    git -C frappe_docker remote add origin https://github.com/frappe/frappe_docker
  fi
  git -C frappe_docker fetch -q --depth 1 origin "$FRAPPE_DOCKER_SHA"
  git -C frappe_docker checkout -q --force FETCH_HEAD
}

# Builds lodgiva-pms:$RELEASE and lodgiva-pms:latest. Needs frappe_docker/ and
# control.Containerfile in the current directory, and about 4 GB of RAM.
build_server_image() {
  cat > apps.json <<EOF
[
  { "url": "https://github.com/frappe/payments", "branch": "${PAYMENTS_REF}" },
  { "url": "https://github.com/Obiajulu-gif/lodgiva-pms", "branch": "${PMS_REF}" },
  { "url": "https://github.com/Obiajulu-gif/lodgiva-nigeria", "branch": "${NIGERIA_REF}" }
]
EOF
  if ! docker image inspect "lodgiva-pms:base-$BASE_RELEASE" >/dev/null 2>&1 || [ "${REBUILD:-0}" = 1 ]; then
    # The pinned Containerfile reads the app list from a build secret. A
    # build-arg is silently ignored and yields an image with Frappe only.
    DOCKER_BUILDKIT=1 docker build \
      --build-arg=FRAPPE_PATH=https://github.com/frappe/frappe \
      --build-arg=FRAPPE_BRANCH="$FRAPPE_BRANCH" \
      --secret=id=apps_json,src=apps.json \
      --tag=lodgiva-pms:base-"$BASE_RELEASE" \
      --file=frappe_docker/images/layered/Containerfile frappe_docker
  fi
  rm -rf control-build && mkdir control-build
  cp -r control-src/frappe-apps/lodgiva_control control-build/lodgiva_control
  cp control.Containerfile control-build/Containerfile
  DOCKER_BUILDKIT=1 docker build --build-arg=BASE="lodgiva-pms:base-$BASE_RELEASE" \
    --label=lodgiva.release="$RELEASE" \
    --label=org.opencontainers.image.source=https://github.com/Obiajulu-gif/lodgiva \
    --tag=lodgiva-pms:latest --tag=lodgiva-pms:"$RELEASE" \
    --file=control-build/Containerfile control-build
  # Fail here, not at new-site, if an app is missing from the image.
  docker run --rm --entrypoint bash lodgiva-pms:latest -c \
    'cd /home/frappe/frappe-bench && for a in frappe payments kamra lodgiva_nigeria lodgiva_control; do env/bin/python -c "import $a" || exit 1; done && echo "image has every app"'
}
