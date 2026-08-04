#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="${repo_root}/third_party/llama.cpp"
runtime_commit="da5b448622ce8f8265bed15a7f80c5cf17894511"
runtime_repo="https://github.com/ggml-org/llama.cpp.git"
runtime_patch="${repo_root}/patches/llama.cpp/0001-deferred-moe-route-trace.patch"

if [[ ! -d "${runtime_root}/.git" ]]; then
    mkdir -p "${repo_root}/third_party"
    git clone "${runtime_repo}" "${runtime_root}"
fi

git -C "${runtime_root}" fetch origin "${runtime_commit}" --depth 1
git -C "${runtime_root}" checkout --detach "${runtime_commit}"

if git -C "${runtime_root}" apply --reverse --check "${runtime_patch}" >/dev/null 2>&1; then
    echo "Galactus route-trace patch is already applied."
elif git -C "${runtime_root}" apply --check "${runtime_patch}"; then
    git -C "${runtime_root}" apply "${runtime_patch}"
else
    echo "error: the Galactus route-trace patch does not apply cleanly" >&2
    exit 1
fi
