#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
llama_root="${repo_root}/third_party/llama.cpp"
llama_build="${llama_root}/build"
galactus_build="${repo_root}/build"

cmake -S "${llama_root}" -B "${llama_build}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_METAL=ON \
    -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=ON \
    -DLLAMA_BUILD_TOOLS=ON

cmake --build "${llama_build}" --target llama-cli llama-bench llama-eval-callback -j "$(sysctl -n hw.ncpu)"

cmake -S "${repo_root}" -B "${galactus_build}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${galactus_build}" --target galactus-route-trace -j "$(sysctl -n hw.ncpu)"
