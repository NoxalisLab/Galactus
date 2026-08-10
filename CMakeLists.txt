cmake_minimum_required(VERSION 3.20)

project(galactus LANGUAGES CXX)

if(APPLE)
    enable_language(OBJCXX)
endif()

find_package(Threads REQUIRED)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(LLAMA_CPP_BUILD_DIR "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/build" CACHE PATH "Built llama.cpp tree")

find_library(LLAMA_LIBRARY
    NAMES llama
    PATHS "${LLAMA_CPP_BUILD_DIR}/bin"
    NO_DEFAULT_PATH
    REQUIRED)

find_library(GGML_LIBRARY
    NAMES ggml
    PATHS "${LLAMA_CPP_BUILD_DIR}/bin"
    NO_DEFAULT_PATH
    REQUIRED)

find_library(GGML_BASE_LIBRARY
    NAMES ggml-base
    PATHS "${LLAMA_CPP_BUILD_DIR}/bin"
    NO_DEFAULT_PATH
    REQUIRED)

add_executable(galactus-route-trace src/route-trace.cpp)
add_executable(galactus-process-memory src/process-memory.cpp)

add_library(galactus-h4-core STATIC src/h4/h4-core.cpp src/h4/h4-profile.cpp src/h4/h4-reader.cpp)
target_include_directories(galactus-h4-core PUBLIC "${CMAKE_SOURCE_DIR}/src/h4")
target_link_libraries(galactus-h4-core PUBLIC Threads::Threads)

# Le cache d'experts fait partie du coeur H4 : il partage les constantes gelees
# du packer via frozen_layer_record_bytes().
add_executable(galactus-h4-expert-cache-replay
    src/h4/h4-expert-cache-replay.cpp
    src/h4/h4-expert-cache.cpp)
target_include_directories(galactus-h4-expert-cache-replay PRIVATE "${CMAKE_SOURCE_DIR}/src/h4")
target_link_libraries(galactus-h4-expert-cache-replay PRIVATE galactus-h4-core)

add_executable(galactus-h4-decode-shape
    src/h4/h4-decode-shape.cpp
    src/h4/h4-expert-store.cpp
    src/h4/h4-expert-cache.cpp)
target_include_directories(galactus-h4-decode-shape PRIVATE "${CMAKE_SOURCE_DIR}/src/h4")
target_link_libraries(galactus-h4-decode-shape PRIVATE galactus-h4-core Threads::Threads)

add_executable(galactus-h4-selftest src/h4/h4-selftest.cpp)
target_link_libraries(galactus-h4-selftest PRIVATE galactus-h4-core)


add_executable(galactus-h4-fixture src/h4/h4-fixture.cpp)
target_link_libraries(galactus-h4-fixture PRIVATE galactus-h4-core)

add_executable(galactus-h4-benchmark src/h4/h4-benchmark.cpp)
target_link_libraries(galactus-h4-benchmark PRIVATE galactus-h4-core)

add_executable(galactus-h4-paced-benchmark src/h4/h4-paced-benchmark.cpp)
target_link_libraries(galactus-h4-paced-benchmark PRIVATE galactus-h4-core)

add_executable(galactus-h4-sentinel src/h4/h4-sentinel.cpp)
target_link_libraries(galactus-h4-sentinel PRIVATE galactus-h4-core)

add_executable(galactus-h4-clone-pack src/h4/h4-clone-pack.cpp)

# galactus-h4-serve-check : verification de CONTENU du chemin de service
# (magasin + lecteur reels, comparaison hote contre le GGUF, sans Metal).
add_executable(galactus-h4-serve-check
    src/h4/h4-serve-check.cpp
    src/h4/h4-core.cpp src/h4/h4-profile.cpp
    src/h4/h4-expert-cache.cpp
    src/h4/h4-expert-store.cpp
    src/h4/h4-reader.cpp)
target_link_libraries(galactus-h4-serve-check PRIVATE Threads::Threads)

# galactus-h4-metal-arena-probe : la sonde d'integration du cablage llama.cpp.
# Valide arene->MTLBuffer sans copie, tenseurs au pas du pack, noeud CPU de
# remappage a travers le planificateur. Fail-closed.
add_executable(galactus-h4-metal-arena-probe
    src/h4/h4-metal-arena-probe.cpp
    src/h4/h4-core.cpp src/h4/h4-profile.cpp
    src/h4/h4-reader.cpp)
target_include_directories(galactus-h4-metal-arena-probe PRIVATE
    "${CMAKE_SOURCE_DIR}/src/h4"
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
target_link_libraries(galactus-h4-metal-arena-probe PRIVATE
    "${GGML_LIBRARY}"
    "${GGML_BASE_LIBRARY}"
    Threads::Threads)
set_target_properties(galactus-h4-metal-arena-probe PROPERTIES
    BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
    INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

add_executable(galactus-glm-compute-microbench src/glm-compute-microbench.cpp)
target_include_directories(galactus-glm-compute-microbench PRIVATE
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
target_link_libraries(galactus-glm-compute-microbench PRIVATE
    "${GGML_LIBRARY}"
    "${GGML_BASE_LIBRARY}"
    Threads::Threads)
set_target_properties(galactus-glm-compute-microbench PROPERTIES
    BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
    INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

if(APPLE)
    find_library(METAL_FRAMEWORK Metal REQUIRED)
    find_library(FOUNDATION_FRAMEWORK Foundation REQUIRED)
    # galactus-metal-hold : allouer et TENIR le cache d'experts en memoire Metal.
    # N'a besoin ni de ggml ni de llama : Metal et Foundation suffisent.
    add_executable(galactus-metal-hold src/metal-hold.mm)
    target_link_libraries(galactus-metal-hold PRIVATE
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}")

    add_executable(galactus-glm-batch-b1m-sizing src/glm-batch-b1m-sizing.mm)
    target_include_directories(galactus-glm-batch-b1m-sizing PRIVATE
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
    target_link_libraries(galactus-glm-batch-b1m-sizing PRIVATE
        "${GGML_LIBRARY}"
        "${GGML_BASE_LIBRARY}"
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}"
        Threads::Threads)
    set_target_properties(galactus-glm-batch-b1m-sizing PROPERTIES
        BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
        INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

    add_executable(galactus-glm-batch-compute-probe src/glm-batch-compute-probe.mm)
    target_include_directories(galactus-glm-batch-compute-probe PRIVATE
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
    target_link_libraries(galactus-glm-batch-compute-probe PRIVATE
        "${GGML_LIBRARY}"
        "${GGML_BASE_LIBRARY}"
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}"
        Threads::Threads)
    set_target_properties(galactus-glm-batch-compute-probe PROPERTIES
        BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
        INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

    add_executable(galactus-glm-batch-b2s-scheduler-sizing
        src/glm-batch-b2s-scheduler-sizing.mm)
    target_include_directories(galactus-glm-batch-b2s-scheduler-sizing PRIVATE
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
    target_link_libraries(galactus-glm-batch-b2s-scheduler-sizing PRIVATE
        "${GGML_LIBRARY}"
        "${GGML_BASE_LIBRARY}"
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}"
        Threads::Threads)
    set_target_properties(galactus-glm-batch-b2s-scheduler-sizing PROPERTIES
        BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
        INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

    add_executable(galactus-glm-batch-b2c-selfchecked-scheduler-sizing
        src/glm-batch-b2c-selfchecked-scheduler-sizing.mm)
    target_include_directories(
        galactus-glm-batch-b2c-selfchecked-scheduler-sizing PRIVATE
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include"
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/vendor")
    target_link_libraries(
        galactus-glm-batch-b2c-selfchecked-scheduler-sizing PRIVATE
        "${GGML_LIBRARY}"
        "${GGML_BASE_LIBRARY}"
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}"
        Threads::Threads)
    target_compile_options(
        galactus-glm-batch-b2c-selfchecked-scheduler-sizing PRIVATE
        -Wall -Wextra -Wpedantic -Werror)
    set_target_properties(
        galactus-glm-batch-b2c-selfchecked-scheduler-sizing PROPERTIES
        BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
        INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

    add_executable(galactus-b2c-sha256-file-test
        tests/b2c-sha256-file-test.cpp)
    target_include_directories(galactus-b2c-sha256-file-test PRIVATE
        "${CMAKE_SOURCE_DIR}/src")
    target_compile_options(galactus-b2c-sha256-file-test PRIVATE
        -Wall -Wextra -Wpedantic -Werror)

    add_executable(galactus-c1-contract-test tests/c1-contract-test.cpp)
    target_include_directories(galactus-c1-contract-test PRIVATE
        "${CMAKE_SOURCE_DIR}/src")
    target_compile_options(galactus-c1-contract-test PRIVATE
        -Wall -Wextra -Wpedantic -Werror)

    add_executable(galactus-glm-batch-c1-compute
        src/glm-batch-c1-compute.mm)
    target_include_directories(galactus-glm-batch-c1-compute PRIVATE
        "${CMAKE_SOURCE_DIR}/src"
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include"
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/vendor")
    target_link_libraries(galactus-glm-batch-c1-compute PRIVATE
        "${GGML_LIBRARY}"
        "${GGML_BASE_LIBRARY}"
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}"
        Threads::Threads)
    target_compile_options(galactus-glm-batch-c1-compute PRIVATE
        -Wall -Wextra -Wpedantic -Werror)
    set_target_properties(galactus-glm-batch-c1-compute PROPERTIES
        BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
        INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

    add_executable(galactus-h4-a0-contract-test tests/h4-a0-contract-test.cpp)
    target_include_directories(galactus-h4-a0-contract-test PRIVATE
        "${CMAKE_SOURCE_DIR}/src")
    target_compile_options(galactus-h4-a0-contract-test PRIVATE
        -Wall -Wextra -Wpedantic -Werror)

    add_executable(galactus-h4-a0-ramp src/h4-a0-ramp.mm)
    target_include_directories(galactus-h4-a0-ramp PRIVATE
        "${CMAKE_SOURCE_DIR}/src")
    target_link_libraries(galactus-h4-a0-ramp PRIVATE
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}"
        Threads::Threads)
    target_compile_options(galactus-h4-a0-ramp PRIVATE
        -Wall -Wextra -Wpedantic -Werror -fblocks)
endif()

add_executable(galactus-h4-memory-probe src/h4/h4-memory-probe.cpp)
target_include_directories(galactus-h4-memory-probe PRIVATE
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/include"
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/src"
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
target_link_libraries(galactus-h4-memory-probe PRIVATE
    "${LLAMA_LIBRARY}"
    "${GGML_LIBRARY}"
    "${GGML_BASE_LIBRARY}")
set_target_properties(galactus-h4-memory-probe PROPERTIES
    BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
    INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

add_executable(galactus-h4-runtime-size-audit src/h4/h4-runtime-size-audit.cpp)
target_link_libraries(galactus-h4-runtime-size-audit PRIVATE galactus-h4-core)

# galactus-h4-split-probe : expose plan_p0_split au differentiel packeur/lecteur
# (scripts/tests/test-p0-split-differential.py).
add_executable(galactus-h4-split-probe src/h4/h4-split-probe.cpp)
target_link_libraries(galactus-h4-split-probe PRIVATE galactus-h4-core)

enable_testing()
add_test(NAME galactus-h4-selftest COMMAND galactus-h4-selftest)
add_test(
    NAME galactus-p0-split-differential
    COMMAND "${CMAKE_COMMAND}" -E env
        "GALACTUS_SPLIT_PROBE=$<TARGET_FILE:galactus-h4-split-probe>"
        python3 "${CMAKE_SOURCE_DIR}/scripts/tests/test-p0-split-differential.py")
if(APPLE)
    add_test(
        NAME galactus-b2c-sha256-file-runtime
        COMMAND galactus-b2c-sha256-file-test
            "${CMAKE_SOURCE_DIR}/tests/fixtures/b2c-sha256-known.txt")
    add_test(NAME galactus-c1-contract-runtime COMMAND galactus-c1-contract-test)
    add_test(NAME galactus-h4-a0-contract-runtime COMMAND galactus-h4-a0-contract-test)
endif()

target_include_directories(galactus-route-trace PRIVATE
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/include"
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/src"
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")

target_link_libraries(galactus-route-trace PRIVATE
    "${LLAMA_LIBRARY}"
    "${GGML_LIBRARY}"
    "${GGML_BASE_LIBRARY}")

set_target_properties(galactus-route-trace PROPERTIES
    BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
    INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

# galactus-h4-kernel-parity-probe : parite numerique CPU vs Metal des noyaux
# mul_mat_id (phase MESURE : quantifier la divergence avant tout correctif).
add_executable(galactus-h4-kernel-parity-probe src/h4/h4-kernel-parity-probe.cpp)
target_include_directories(galactus-h4-kernel-parity-probe PRIVATE
    "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
target_link_libraries(galactus-h4-kernel-parity-probe PRIVATE
    "${GGML_LIBRARY}"
    "${GGML_BASE_LIBRARY}"
    Threads::Threads)
set_target_properties(galactus-h4-kernel-parity-probe PROPERTIES
    BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
    INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")

if(APPLE)
    # galactus-h4-expf-parity-probe : parite numerique CPU vs Metal de l'exponentielle
    # (balayage exhaustif des 2^32 float32) et de l'operateur SWIGLU_OAI complet.
    # Le MSL teste est extrait du ggml-metal.metal reellement livre : aucune recopie.
    add_executable(galactus-h4-expf-parity-probe src/h4/h4-expf-parity-probe.mm)
    target_compile_definitions(galactus-h4-expf-parity-probe PRIVATE
        "GALACTUS_METAL_SRC_PATH=\"${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/src/ggml-metal/ggml-metal.metal\"")
    target_include_directories(galactus-h4-expf-parity-probe PRIVATE
        "${CMAKE_SOURCE_DIR}/third_party/llama.cpp/ggml/include")
    target_link_libraries(galactus-h4-expf-parity-probe PRIVATE
        "${GGML_LIBRARY}"
        "${GGML_BASE_LIBRARY}"
        "${METAL_FRAMEWORK}"
        "${FOUNDATION_FRAMEWORK}"
        Threads::Threads)
    set_target_properties(galactus-h4-expf-parity-probe PROPERTIES
        BUILD_RPATH "${LLAMA_CPP_BUILD_DIR}/bin"
        INSTALL_RPATH "${LLAMA_CPP_BUILD_DIR}/bin")
endif()
