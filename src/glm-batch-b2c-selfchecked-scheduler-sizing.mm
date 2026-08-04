#include "b2c-sha256-file.hpp"
#include "glm-batch-b2c-topology.hpp"
#include "nlohmann/json.hpp"

#import <Metal/Metal.h>

#include <mach-o/dyld.h>

#include <array>
#include <cerrno>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace galactus::b2c {

namespace fs = std::filesystem;
namespace topo = galactus::b2c_topology;
using json = nlohmann::ordered_json;

constexpr int REPEAT_COUNT = 3;
constexpr std::string_view RUNG =
    "B2C_SELFCHECKED_WEIGHT_ANCHORED_SCHEDULER_SIZE_K1_K2";
constexpr std::string_view SELFCHECK_SCHEMA =
    "galactus.h4-b2c-non-observational-readiness.v1";
constexpr std::string_view MEASUREMENT_SCHEMA =
    "galactus.h4-b2c-weight-anchored-scheduler-size.v1";

enum class Phase {
    selfcheck,
    measure,
};

struct CliOptions {
    Phase phase = Phase::selfcheck;
    fs::path output;
    fs::path repo_root;
    fs::path runtime_manifest;
    std::string binary_sha256;
    std::string runtime_manifest_sha256;
    fs::path selfcheck_artifact;
    std::string selfcheck_sha256;
    fs::path token;
};

enum class PreconditionStatus {
    pass,
    fail,
    blocked,
};

enum class PreconditionIndex : size_t {
    system_device_available,
    gpu_backend_initialized,
    cpu_backend_initialized,
    gpu_device_type_enum,
    cpu_device_type_enum,
    backend_order_gpu_then_cpu,
    gpu_default_buffer_type_available,
    weight_context_constructed,
    weight_tensors_present,
    weight_tensors_unallocated,
    zero_dummy_created,
    zero_dummy_size,
    zero_dummy_buffer_type,
    zero_dummy_usage_weights,
    weights_attached_to_zero_dummy,
    weights_restored_unallocated,
    graph_context_constructed,
    graph_tensors_unallocated,
    scheduler_constructed,
    measurement_fixture_ready,
    count,
};

constexpr size_t PRECONDITION_COUNT =
    static_cast<size_t>(PreconditionIndex::count);

// B2C_PRECONDITION_IDS_BEGIN
constexpr std::array<std::string_view, PRECONDITION_COUNT> PRECONDITION_IDS{
    "system_device_available",
    "gpu_backend_initialized",
    "cpu_backend_initialized",
    "gpu_device_type_enum",
    "cpu_device_type_enum",
    "backend_order_gpu_then_cpu",
    "gpu_default_buffer_type_available",
    "weight_context_constructed",
    "weight_tensors_present",
    "weight_tensors_unallocated",
    "zero_dummy_created",
    "zero_dummy_size",
    "zero_dummy_buffer_type",
    "zero_dummy_usage_weights",
    "weights_attached_to_zero_dummy",
    "weights_restored_unallocated",
    "graph_context_constructed",
    "graph_tensors_unallocated",
    "scheduler_constructed",
    "measurement_fixture_ready",
};
// B2C_PRECONDITION_IDS_END

constexpr std::array<std::string_view, PRECONDITION_COUNT> PRECONDITION_DESCRIPTIONS{
    "A system GPU device object is available",
    "The GPU backend initializes",
    "The CPU backend initializes",
    "Backend index 0 has the GPU enum type",
    "Backend index 1 has the CPU enum type",
    "The scheduler backend order is GPU then CPU",
    "The GPU backend exposes a default buffer type",
    "The exact weight no-alloc context is constructed",
    "The exact weight context contains tensors",
    "Every weight tensor has null buffer and data",
    "A disposable zero-byte backend buffer is created",
    "The disposable backend buffer reports size zero",
    "The disposable backend buffer retains the GPU buffer type",
    "The disposable backend buffer retains WEIGHTS usage",
    "Every weight can point to the disposable buffer",
    "Every weight is restored to null buffer and data",
    "The exact graph no-alloc context is constructed",
    "Every graph-context tensor has null buffer and data",
    "A scheduler is constructed with the checked backend order",
    "The exact fixture is ready without an experimental observation",
};

constexpr std::array<std::string_view, PRECONDITION_COUNT> PRECONDITION_EXPECTED{
    "available",
    "initialized",
    "initialized",
    "GPU",
    "CPU",
    "GPU,CPU",
    "available",
    "constructed",
    "nonempty",
    "all-null",
    "created",
    "0",
    "same-object",
    "WEIGHTS",
    "all-attached",
    "all-null",
    "constructed",
    "all-null",
    "constructed",
    "ready-no-observation",
};

struct PreconditionRow {
    std::string_view id;
    std::string_view description;
    std::vector<size_t> dependencies;
    std::string observed = "not-evaluated";
    std::string_view expected;
    PreconditionStatus status = PreconditionStatus::blocked;
};

const char * status_name(PreconditionStatus status) {
    switch (status) {
        case PreconditionStatus::pass: return "pass";
        case PreconditionStatus::fail: return "fail";
        case PreconditionStatus::blocked: return "blocked";
    }
    return "blocked";
}

class PreconditionTable {
public:
    PreconditionTable() {
        rows_.reserve(PRECONDITION_COUNT);
        for (size_t index = 0; index < PRECONDITION_COUNT; ++index) {
            rows_.push_back({
                PRECONDITION_IDS[index], PRECONDITION_DESCRIPTIONS[index], {},
                "not-evaluated", PRECONDITION_EXPECTED[index],
                PreconditionStatus::blocked,
            });
        }
        dependencies(PreconditionIndex::gpu_device_type_enum,
                     {PreconditionIndex::gpu_backend_initialized});
        dependencies(PreconditionIndex::cpu_device_type_enum,
                     {PreconditionIndex::cpu_backend_initialized});
        dependencies(PreconditionIndex::backend_order_gpu_then_cpu,
                     {PreconditionIndex::gpu_device_type_enum,
                      PreconditionIndex::cpu_device_type_enum});
        dependencies(PreconditionIndex::gpu_default_buffer_type_available,
                     {PreconditionIndex::gpu_backend_initialized});
        dependencies(PreconditionIndex::weight_tensors_present,
                     {PreconditionIndex::weight_context_constructed});
        dependencies(PreconditionIndex::weight_tensors_unallocated,
                     {PreconditionIndex::weight_tensors_present});
        dependencies(PreconditionIndex::zero_dummy_created,
                     {PreconditionIndex::gpu_default_buffer_type_available,
                      PreconditionIndex::weight_tensors_unallocated});
        dependencies(PreconditionIndex::zero_dummy_size,
                     {PreconditionIndex::zero_dummy_created});
        dependencies(PreconditionIndex::zero_dummy_buffer_type,
                     {PreconditionIndex::zero_dummy_created});
        dependencies(PreconditionIndex::zero_dummy_usage_weights,
                     {PreconditionIndex::zero_dummy_created});
        dependencies(PreconditionIndex::weights_attached_to_zero_dummy,
                     {PreconditionIndex::zero_dummy_size,
                      PreconditionIndex::zero_dummy_buffer_type,
                      PreconditionIndex::zero_dummy_usage_weights});
        dependencies(PreconditionIndex::weights_restored_unallocated,
                     {PreconditionIndex::weights_attached_to_zero_dummy});
        dependencies(PreconditionIndex::graph_context_constructed,
                     {PreconditionIndex::weights_restored_unallocated});
        dependencies(PreconditionIndex::graph_tensors_unallocated,
                     {PreconditionIndex::graph_context_constructed});
        dependencies(PreconditionIndex::scheduler_constructed,
                     {PreconditionIndex::backend_order_gpu_then_cpu});
        dependencies(PreconditionIndex::measurement_fixture_ready,
                     {PreconditionIndex::graph_tensors_unallocated,
                      PreconditionIndex::scheduler_constructed});
    }

    bool dependencies_pass(PreconditionIndex index) const {
        for (const size_t dependency : row(index).dependencies) {
            if (rows_.at(dependency).status != PreconditionStatus::pass) {
                return false;
            }
        }
        return true;
    }

    void evaluate(PreconditionIndex index, bool condition, std::string observed) {
        auto & item = row(index);
        if (!dependencies_pass(index)) {
            item.observed = "blocked-by-dependency";
            item.status = PreconditionStatus::blocked;
            return;
        }
        item.observed = std::move(observed);
        item.status = condition ? PreconditionStatus::pass : PreconditionStatus::fail;
    }

    void fail(PreconditionIndex index, const std::string & message) {
        auto & item = row(index);
        item.observed = message;
        item.status = dependencies_pass(index)
            ? PreconditionStatus::fail : PreconditionStatus::blocked;
    }

    void finalize_blocked() {
        for (auto & item : rows_) {
            if (item.status == PreconditionStatus::blocked &&
                item.observed == "not-evaluated") {
                item.observed = "blocked-by-dependency";
            }
        }
    }

    bool all_pass() const {
        for (const auto & item : rows_) {
            if (item.status != PreconditionStatus::pass) {
                return false;
            }
        }
        return true;
    }

    const std::vector<PreconditionRow> & rows() const {
        return rows_;
    }

private:
    static size_t position(PreconditionIndex index) {
        return static_cast<size_t>(index);
    }

    PreconditionRow & row(PreconditionIndex index) {
        return rows_.at(position(index));
    }

    const PreconditionRow & row(PreconditionIndex index) const {
        return rows_.at(position(index));
    }

    void dependencies(
        PreconditionIndex index,
        std::initializer_list<PreconditionIndex> values) {
        auto & target = row(index).dependencies;
        for (const auto value : values) {
            target.push_back(position(value));
        }
    }

    std::vector<PreconditionRow> rows_;
};

struct SourceEdge {
    ggml_tensor * node;
    int slot;
    ggml_tensor * original;
};

struct CopyCounts {
    size_t total = 0;
    size_t weight = 0;
    size_t graph_input = 0;
    size_t activation = 0;
    size_t changed_edges = 0;
};

struct PlacementCounts {
    size_t nodes = 0;
    size_t non_view_compute_nodes = 0;
    size_t gpu_nodes = 0;
    size_t cpu_nodes = 0;
    size_t unassigned_nodes = 0;
    size_t gpu_non_view_compute_nodes = 0;
    size_t cpu_non_view_compute_nodes = 0;
};

struct CaseMeasurement {
    int k = 0;
    int graph_nodes = 0;
    size_t graph_capacity = 0;
    size_t gpu_reserve_bytes = 0;
    size_t cpu_reserve_bytes = 0;
    int scheduler_split_count = 0;
    int scheduler_parallel_copy_slots = 0;
    PlacementCounts placement;
    CopyCounts copies;
    bool beta_placement_gate = false;
};

struct MetalCaptures {
    uint64_t before_weight_sizing = 0;
    uint64_t after_weight_sizing = 0;
    uint64_t after_dummy_attachment = 0;
    uint64_t after_all_reserve_size = 0;
    uint64_t after_scheduler_free = 0;
};

struct RepeatMeasurement {
    int repeat_index = 0;
    size_t weight_tensor_count = 0;
    size_t future_real_weight_buffer_bytes = 0;
    MetalCaptures metal;
    std::vector<CaseMeasurement> cases;
};

std::string require_value(int argc, char ** argv, int & index) {
    if (++index >= argc) {
        throw std::runtime_error("missing CLI value");
    }
    return argv[index];
}

CliOptions parse_cli(int argc, char ** argv) {
    CliOptions options;
    bool phase_set = false;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--phase") {
            const auto value = require_value(argc, argv, index);
            if (value == "selfcheck") {
                options.phase = Phase::selfcheck;
            } else if (value == "measure") {
                options.phase = Phase::measure;
            } else {
                throw std::runtime_error("--phase must be selfcheck or measure");
            }
            phase_set = true;
        } else if (argument == "--output") {
            options.output = require_value(argc, argv, index);
        } else if (argument == "--repo-root") {
            options.repo_root = require_value(argc, argv, index);
        } else if (argument == "--runtime-manifest") {
            options.runtime_manifest = require_value(argc, argv, index);
        } else if (argument == "--binary-sha256") {
            options.binary_sha256 = require_value(argc, argv, index);
        } else if (argument == "--runtime-manifest-sha256") {
            options.runtime_manifest_sha256 = require_value(argc, argv, index);
        } else if (argument == "--selfcheck-artifact") {
            options.selfcheck_artifact = require_value(argc, argv, index);
        } else if (argument == "--selfcheck-sha256") {
            options.selfcheck_sha256 = require_value(argc, argv, index);
        } else if (argument == "--token") {
            options.token = require_value(argc, argv, index);
        } else {
            throw std::runtime_error("unknown CLI argument: " + argument);
        }
    }
    if (!phase_set || options.output.empty() || options.repo_root.empty() ||
        options.runtime_manifest.empty() || options.binary_sha256.empty() ||
        options.runtime_manifest_sha256.empty()) {
        throw std::runtime_error("missing required common CLI arguments");
    }
    if (options.phase == Phase::selfcheck &&
        (!options.selfcheck_artifact.empty() || !options.selfcheck_sha256.empty() ||
         !options.token.empty())) {
        throw std::runtime_error("selfcheck forbids measurement-only arguments");
    }
    if (options.phase == Phase::measure &&
        (options.selfcheck_artifact.empty() || options.selfcheck_sha256.empty() ||
         options.token.empty())) {
        throw std::runtime_error("measure requires selfcheck and token arguments");
    }
    return options;
}

fs::path executable_path() {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buffer(size);
    if (_NSGetExecutablePath(buffer.data(), &size) != 0) {
        throw std::runtime_error("cannot resolve executable path");
    }
    return fs::canonical(buffer.data());
}

json read_json(const fs::path & path) {
    std::ifstream input(path);
    if (!input) {
        throw std::runtime_error("cannot open JSON input: " + path.string());
    }
    return json::parse(input);
}

void write_json_atomic(const fs::path & path, const json & document) {
    const fs::path temporary = path.string() + ".tmp";
    {
        std::ofstream output(temporary, std::ios::out | std::ios::trunc);
        if (!output) {
            throw std::runtime_error("cannot open JSON output: " + temporary.string());
        }
        output << std::setw(2) << document << '\n';
        if (!output) {
            throw std::runtime_error("cannot write JSON output: " + temporary.string());
        }
    }
    std::error_code error;
    fs::rename(temporary, path, error);
    if (error) {
        throw std::runtime_error("cannot publish JSON output: " + error.message());
    }
}

struct PackageEvidence {
    std::string binary_sha256;
    std::string runtime_manifest_sha256;
    size_t runtime_dependency_count = 0;
};

PackageEvidence validate_package(const CliOptions & options) {
    PackageEvidence evidence;
    evidence.binary_sha256 = sha256_file(executable_path());
    if (evidence.binary_sha256 != options.binary_sha256) {
        throw std::runtime_error("executable SHA-256 mismatch");
    }
    evidence.runtime_manifest_sha256 = sha256_file(options.runtime_manifest);
    if (evidence.runtime_manifest_sha256 != options.runtime_manifest_sha256) {
        throw std::runtime_error("runtime manifest SHA-256 mismatch");
    }
    const auto manifest = read_json(options.runtime_manifest);
    if (manifest.at("schema") != "galactus.h4-b2c-runtime-closure.v1") {
        throw std::runtime_error("runtime manifest schema mismatch");
    }
    const auto & dependencies = manifest.at("dependencies");
    if (!dependencies.is_array() || dependencies.empty()) {
        throw std::runtime_error("runtime manifest has no dependencies");
    }
    for (const auto & dependency : dependencies) {
        const fs::path path = options.repo_root / dependency.at("path").get<std::string>();
        if (sha256_file(path) != dependency.at("sha256").get<std::string>()) {
            throw std::runtime_error("runtime dependency SHA-256 mismatch");
        }
        ++evidence.runtime_dependency_count;
    }
    return evidence;
}

void validate_selfcheck_for_measure(const CliOptions & options) {
    if (sha256_file(options.selfcheck_artifact) != options.selfcheck_sha256) {
        throw std::runtime_error("selfcheck artifact SHA-256 mismatch");
    }
    const auto document = read_json(options.selfcheck_artifact);
    if (document.at("schema") != SELFCHECK_SCHEMA ||
        document.at("phase") != "selfcheck" ||
        document.at("status") != "ready" ||
        document.at("binary_sha256") != options.binary_sha256 ||
        document.at("runtime_manifest_sha256") !=
            options.runtime_manifest_sha256) {
        throw std::runtime_error("selfcheck identity or global status mismatch");
    }
}

class RunToken {
public:
    RunToken(const RunToken &) = delete;
    RunToken & operator=(const RunToken &) = delete;
    RunToken(RunToken &&) noexcept = default;
    RunToken & operator=(RunToken &&) noexcept = default;

    static RunToken acquire(const fs::path & path) {
        std::error_code error;
        const bool created = fs::create_directory(path, error);
        if (!created || error) {
            throw std::runtime_error(
                "cannot atomically create unique run token: " + error.message());
        }
        return RunToken(path);
    }

    const fs::path & path() const {
        return path_;
    }

private:
    explicit RunToken(fs::path path) : path_(std::move(path)) {}
    fs::path path_;
};

class WeightFixture {
public:
    WeightFixture() {
        ggml_init_params parameters{};
        parameters.mem_size = topo::CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        context_.reset(ggml_init(parameters));
        if (!context_) {
            throw std::runtime_error("weight context construction failed");
        }
        for (int pool = 0; pool < topo::POOL_SIZE; ++pool) {
            experts_a_.push_back(topo::new_expert_bundle(
                context_.get(), topo::CLASS_A, tensors_, 1000 + pool * 10));
            experts_b_.push_back(topo::new_expert_bundle(
                context_.get(), topo::CLASS_B, tensors_, 2000 + pool * 10));
            experts_c_.push_back(topo::new_expert_bundle(
                context_.get(), topo::CLASS_C, tensors_, 3000 + pool * 10));
            shared_.push_back(topo::new_shared_bundle(
                context_.get(), tensors_, 4000 + pool * 10));
            attention_.push_back(topo::new_attention_bundle(
                context_.get(), tensors_, 5000 + pool * 10));
        }
    }

    bool tensors_present() const {
        return !tensors_.empty();
    }

    bool all_unallocated() const {
        for (const auto & item : tensors_) {
            if (item.tensor->buffer != nullptr || item.tensor->data != nullptr) {
                return false;
            }
        }
        return true;
    }

    void attach(ggml_backend_buffer_t buffer) {
        for (const auto & item : tensors_) {
            item.tensor->buffer = buffer;
        }
    }

    bool all_attached_to(ggml_backend_buffer_t buffer) const {
        for (const auto & item : tensors_) {
            if (item.tensor->buffer != buffer) {
                return false;
            }
        }
        return true;
    }

    void restore_unallocated() {
        for (const auto & item : tensors_) {
            item.tensor->buffer = nullptr;
        }
    }

    size_t observe_and_anchor(
        const RunToken & token,
        ggml_backend_buffer_type_t buffer_type,
        id<MTLDevice> device,
        uint64_t & after_sizing,
        uint64_t & after_dummy) {
        static_cast<void>(token.path());
        const size_t future_bytes =
            ggml_backend_alloc_ctx_tensors_from_buft_size(context_.get(), buffer_type);
        if (future_bytes == 0 || tensors_.empty()) {
            throw std::runtime_error("qualified: weight sizing returned zero");
        }
        after_sizing = current_allocated_bytes(device);
        dummy_.reset(ggml_backend_buft_alloc_buffer(buffer_type, 0));
        if (!dummy_ || ggml_backend_buffer_get_size(dummy_.get()) != 0 ||
            ggml_backend_buffer_get_type(dummy_.get()) != buffer_type) {
            throw std::runtime_error("qualified: production zero dummy mismatch");
        }
        ggml_backend_buffer_set_usage(
            dummy_.get(), GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        if (ggml_backend_buffer_get_usage(dummy_.get()) !=
            GGML_BACKEND_BUFFER_USAGE_WEIGHTS) {
            throw std::runtime_error("qualified: production dummy usage mismatch");
        }
        attach(dummy_.get());
        if (!all_attached_to(dummy_.get())) {
            throw std::runtime_error("qualified: production weight attachment mismatch");
        }
        after_dummy = current_allocated_bytes(device);
        return future_bytes;
    }

    size_t tensor_count() const {
        return tensors_.size();
    }

    const std::vector<topo::ExpertBundle> & experts_a() const { return experts_a_; }
    const std::vector<topo::ExpertBundle> & experts_b() const { return experts_b_; }
    const std::vector<topo::ExpertBundle> & experts_c() const { return experts_c_; }
    const std::vector<topo::SharedBundle> & shared() const { return shared_; }
    const std::vector<topo::AttentionBundle> & attention() const { return attention_; }

private:
    static uint64_t current_allocated_bytes(id<MTLDevice> device) {
        return static_cast<uint64_t>(device.currentAllocatedSize);
    }

    ggml_context_ptr context_;
    std::vector<topo::InitializedTensor> tensors_;
    std::vector<topo::ExpertBundle> experts_a_;
    std::vector<topo::ExpertBundle> experts_b_;
    std::vector<topo::ExpertBundle> experts_c_;
    std::vector<topo::SharedBundle> shared_;
    std::vector<topo::AttentionBundle> attention_;
    ggml_backend_buffer_ptr dummy_;
};

class GraphFixture {
public:
    explicit GraphFixture(const WeightFixture & weights) {
        ggml_init_params parameters{};
        parameters.mem_size = topo::CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        context_.reset(ggml_init(parameters));
        if (!context_) {
            throw std::runtime_error("graph context construction failed");
        }
        auto * k_cache = ggml_new_tensor_3d(
            context_.get(), GGML_TYPE_F16, topo::MLA_QK, topo::N_CTX, 1);
        for (const int batch_size : topo::BATCH_SIZES) {
            auto * input = ggml_new_tensor_2d(
                context_.get(), GGML_TYPE_F32, topo::N_EMBD, batch_size);
            auto * ids = ggml_new_tensor_2d(
                context_.get(), GGML_TYPE_I32, topo::N_EXPERT_USED, batch_size);
            ggml_set_input(input);
            ggml_set_input(ids);
            auto * root = topo::build_chain(
                context_.get(), topo::ChainKind::full, batch_size,
                weights.experts_a(), weights.experts_b(), weights.experts_c(),
                weights.shared(), weights.attention(), k_cache, ids, input);
            cases_.push_back({
                batch_size, input, ids, root, topo::graph_for(context_.get(), root),
            });
        }
    }

    bool all_unallocated() const {
        for (ggml_tensor * tensor = ggml_get_first_tensor(context_.get());
             tensor != nullptr; tensor = ggml_get_next_tensor(context_.get(), tensor)) {
            if (tensor->buffer != nullptr || tensor->data != nullptr) {
                return false;
            }
        }
        return true;
    }

    std::vector<topo::GraphCase> & cases() {
        return cases_;
    }

private:
    ggml_context_ptr context_;
    std::vector<topo::GraphCase> cases_;
};

struct PreparedRuntime {
    PreconditionTable preconditions;
    id<MTLDevice> system_device = nil;
    uint64_t before_backend_init = 0;
    uint64_t after_backend_init = 0;
    ggml_backend_ptr gpu;
    ggml_backend_ptr cpu;
    ggml_backend_buffer_type_t gpu_buffer_type = nullptr;
    std::unique_ptr<WeightFixture> weights;
    std::unique_ptr<GraphFixture> graphs;
    topo::scheduler_ptr scheduler;
};

uint64_t current_allocated_bytes(id<MTLDevice> device) {
    return static_cast<uint64_t>(device.currentAllocatedSize);
}

PreparedRuntime prepare_runtime() {
    PreparedRuntime prepared;
    auto & table = prepared.preconditions;

    prepared.system_device = MTLCreateSystemDefaultDevice();
    table.evaluate(
        PreconditionIndex::system_device_available,
        prepared.system_device != nil,
        prepared.system_device != nil ? "available" : "unavailable");
    if (prepared.system_device != nil) {
        prepared.before_backend_init = current_allocated_bytes(prepared.system_device);
    }

    ggml_backend_load_all();
    prepared.gpu.reset(
        ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
    table.evaluate(
        PreconditionIndex::gpu_backend_initialized,
        prepared.gpu != nullptr,
        prepared.gpu ? "initialized" : "unavailable");
    prepared.cpu.reset(
        ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr));
    table.evaluate(
        PreconditionIndex::cpu_backend_initialized,
        prepared.cpu != nullptr,
        prepared.cpu ? "initialized" : "unavailable");

    if (table.dependencies_pass(PreconditionIndex::gpu_device_type_enum)) {
        const bool matches = ggml_backend_dev_type(
            ggml_backend_get_device(prepared.gpu.get())) ==
            GGML_BACKEND_DEVICE_TYPE_GPU;
        table.evaluate(PreconditionIndex::gpu_device_type_enum, matches,
                       matches ? "GPU" : "not-GPU");
    } else {
        table.evaluate(PreconditionIndex::gpu_device_type_enum, false, "blocked");
    }
    if (table.dependencies_pass(PreconditionIndex::cpu_device_type_enum)) {
        const bool matches = ggml_backend_dev_type(
            ggml_backend_get_device(prepared.cpu.get())) ==
            GGML_BACKEND_DEVICE_TYPE_CPU;
        table.evaluate(PreconditionIndex::cpu_device_type_enum, matches,
                       matches ? "CPU" : "not-CPU");
    } else {
        table.evaluate(PreconditionIndex::cpu_device_type_enum, false, "blocked");
    }
    table.evaluate(
        PreconditionIndex::backend_order_gpu_then_cpu,
        table.dependencies_pass(PreconditionIndex::backend_order_gpu_then_cpu),
        table.dependencies_pass(PreconditionIndex::backend_order_gpu_then_cpu)
            ? "GPU,CPU" : "blocked");

    if (table.dependencies_pass(
            PreconditionIndex::gpu_default_buffer_type_available)) {
        prepared.gpu_buffer_type =
            ggml_backend_get_default_buffer_type(prepared.gpu.get());
    }
    table.evaluate(
        PreconditionIndex::gpu_default_buffer_type_available,
        prepared.gpu_buffer_type != nullptr,
        prepared.gpu_buffer_type ? "available" : "unavailable");

    try {
        prepared.weights = std::make_unique<WeightFixture>();
        table.evaluate(PreconditionIndex::weight_context_constructed, true,
                       "constructed");
    } catch (const std::exception & error) {
        table.fail(PreconditionIndex::weight_context_constructed, error.what());
    }
    table.evaluate(
        PreconditionIndex::weight_tensors_present,
        prepared.weights && prepared.weights->tensors_present(),
        prepared.weights && prepared.weights->tensors_present()
            ? "nonempty" : "empty");
    table.evaluate(
        PreconditionIndex::weight_tensors_unallocated,
        prepared.weights && prepared.weights->all_unallocated(),
        prepared.weights && prepared.weights->all_unallocated()
            ? "all-null" : "storage-present");

    ggml_backend_buffer_ptr disposable_dummy;
    if (table.dependencies_pass(PreconditionIndex::zero_dummy_created)) {
        disposable_dummy.reset(
            ggml_backend_buft_alloc_buffer(prepared.gpu_buffer_type, 0));
    }
    table.evaluate(
        PreconditionIndex::zero_dummy_created,
        disposable_dummy != nullptr,
        disposable_dummy ? "created" : "unavailable");
    table.evaluate(
        PreconditionIndex::zero_dummy_size,
        disposable_dummy && ggml_backend_buffer_get_size(disposable_dummy.get()) == 0,
        disposable_dummy
            ? std::to_string(ggml_backend_buffer_get_size(disposable_dummy.get()))
            : "blocked");
    table.evaluate(
        PreconditionIndex::zero_dummy_buffer_type,
        disposable_dummy &&
            ggml_backend_buffer_get_type(disposable_dummy.get()) ==
                prepared.gpu_buffer_type,
        disposable_dummy ? "same-object" : "blocked");
    if (disposable_dummy) {
        ggml_backend_buffer_set_usage(
            disposable_dummy.get(), GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    }
    table.evaluate(
        PreconditionIndex::zero_dummy_usage_weights,
        disposable_dummy &&
            ggml_backend_buffer_get_usage(disposable_dummy.get()) ==
                GGML_BACKEND_BUFFER_USAGE_WEIGHTS,
        disposable_dummy ? "WEIGHTS" : "blocked");
    if (table.dependencies_pass(
            PreconditionIndex::weights_attached_to_zero_dummy)) {
        prepared.weights->attach(disposable_dummy.get());
    }
    table.evaluate(
        PreconditionIndex::weights_attached_to_zero_dummy,
        prepared.weights && disposable_dummy &&
            prepared.weights->all_attached_to(disposable_dummy.get()),
        prepared.weights && disposable_dummy &&
                prepared.weights->all_attached_to(disposable_dummy.get())
            ? "all-attached" : "attachment-mismatch");
    if (prepared.weights) {
        prepared.weights->restore_unallocated();
    }
    table.evaluate(
        PreconditionIndex::weights_restored_unallocated,
        prepared.weights && prepared.weights->all_unallocated(),
        prepared.weights && prepared.weights->all_unallocated()
            ? "all-null" : "storage-present");
    disposable_dummy.reset();

    if (table.dependencies_pass(PreconditionIndex::graph_context_constructed)) {
        try {
            prepared.graphs = std::make_unique<GraphFixture>(*prepared.weights);
            table.evaluate(PreconditionIndex::graph_context_constructed, true,
                           "constructed");
        } catch (const std::exception & error) {
            table.fail(PreconditionIndex::graph_context_constructed, error.what());
        }
    } else {
        table.evaluate(PreconditionIndex::graph_context_constructed, false, "blocked");
    }
    table.evaluate(
        PreconditionIndex::graph_tensors_unallocated,
        prepared.graphs && prepared.graphs->all_unallocated(),
        prepared.graphs && prepared.graphs->all_unallocated()
            ? "all-null" : "storage-present");

    if (table.dependencies_pass(PreconditionIndex::scheduler_constructed)) {
        std::array<ggml_backend_t, 2> backends{
            prepared.gpu.get(), prepared.cpu.get(),
        };
        prepared.scheduler.reset(ggml_backend_sched_new(
            backends.data(), nullptr, static_cast<int>(backends.size()),
            topo::SCHEDULER_GRAPH_SIZE, false, true));
    }
    table.evaluate(
        PreconditionIndex::scheduler_constructed,
        prepared.scheduler != nullptr,
        prepared.scheduler ? "constructed" : "unavailable");
    table.evaluate(
        PreconditionIndex::measurement_fixture_ready,
        prepared.weights && prepared.graphs && prepared.scheduler &&
            prepared.weights->all_unallocated() &&
            prepared.graphs->all_unallocated(),
        prepared.weights && prepared.graphs && prepared.scheduler &&
                prepared.weights->all_unallocated() &&
                prepared.graphs->all_unallocated()
            ? "ready-no-observation" : "not-ready");

    if (prepared.system_device != nil) {
        prepared.after_backend_init = current_allocated_bytes(prepared.system_device);
    }
    table.finalize_blocked();
    return prepared;
}

json preconditions_json(const PreconditionTable & table) {
    json output = json::array();
    for (const auto & row : table.rows()) {
        json dependencies = json::array();
        for (const size_t dependency : row.dependencies) {
            dependencies.push_back(PRECONDITION_IDS.at(dependency));
        }
        output.push_back({
            {"precondition_id", row.id},
            {"description", row.description},
            {"dependencies", dependencies},
            {"observed", row.observed},
            {"expected", row.expected},
            {"status", status_name(row.status)},
        });
    }
    return output;
}

// B2C_BACKEND_TELEMETRY_WRITE_ONLY_BEGIN
json backend_telemetry(
    ggml_backend_t gpu,
    ggml_backend_t cpu,
    ggml_backend_buffer_type_t buffer_type) {
    const auto gpu_device = ggml_backend_get_device(gpu);
    const auto cpu_device = ggml_backend_get_device(cpu);
    return {
        {"reg_name", ggml_backend_reg_name(
            ggml_backend_dev_backend_reg(gpu_device))},
        {"dev_name", ggml_backend_dev_name(gpu_device)},
        {"dev_description", ggml_backend_dev_description(gpu_device)},
        {"backend_name", ggml_backend_name(gpu)},
        {"buffer_type_name", ggml_backend_buft_name(buffer_type)},
        {"cpu_dev_name", ggml_backend_dev_name(cpu_device)},
        {"cpu_dev_description", ggml_backend_dev_description(cpu_device)},
        {"cpu_backend_name", ggml_backend_name(cpu)},
    };
}
// B2C_BACKEND_TELEMETRY_WRITE_ONLY_END

json base_artifact(
    const CliOptions & options,
    const PackageEvidence * package,
    const std::string & bootstrap_status,
    const std::string & bootstrap_detail,
    const PreconditionTable & table) {
    json result{
        {"rung", RUNG},
        {"phase", options.phase == Phase::selfcheck ? "selfcheck" : "measure"},
        {"bootstrap_status", bootstrap_status},
        {"bootstrap_detail", bootstrap_detail},
        {"binary_sha256", package ? package->binary_sha256 : options.binary_sha256},
        {"runtime_manifest_sha256",
         package ? package->runtime_manifest_sha256 :
                   options.runtime_manifest_sha256},
        {"runtime_dependency_count",
         package ? package->runtime_dependency_count : 0},
        {"preconditions", preconditions_json(table)},
        {"names_are_telemetry_only", true},
        {"model_or_pack_read", false},
        {"tensor_initialization_executed", false},
        {"graph_compute_executed", false},
        {"automatic_retry", false},
        {"automatic_transition", false},
    };
    return result;
}

std::vector<SourceEdge> snapshot_sources(ggml_cgraph * graph) {
    std::vector<SourceEdge> edges;
    const int node_count = ggml_graph_n_nodes(graph);
    for (int index = 0; index < node_count; ++index) {
        ggml_tensor * node = ggml_graph_node(graph, index);
        for (int slot = 0; slot < GGML_MAX_SRC; ++slot) {
            if (node->src[slot] != nullptr) {
                edges.push_back({node, slot, node->src[slot]});
            }
        }
    }
    return edges;
}

CopyCounts classify_copies(const std::vector<SourceEdge> & before) {
    std::set<ggml_tensor *> all;
    std::set<ggml_tensor *> weights;
    std::set<ggml_tensor *> inputs;
    std::set<ggml_tensor *> activations;
    size_t changed_edges = 0;
    for (const auto & edge : before) {
        ggml_tensor * replacement = edge.node->src[edge.slot];
        if (replacement == edge.original) {
            continue;
        }
        if (replacement == nullptr) {
            throw std::runtime_error("qualified: scheduler source became null");
        }
        ++changed_edges;
        all.insert(replacement);
        if (edge.original->buffer != nullptr &&
            ggml_backend_buffer_get_usage(edge.original->buffer) ==
                GGML_BACKEND_BUFFER_USAGE_WEIGHTS) {
            weights.insert(replacement);
        } else if ((edge.original->flags & GGML_TENSOR_FLAG_INPUT) != 0) {
            inputs.insert(replacement);
        } else {
            activations.insert(replacement);
        }
    }
    return {all.size(), weights.size(), inputs.size(), activations.size(), changed_edges};
}

PlacementCounts count_placement(
    ggml_backend_sched_t scheduler,
    ggml_cgraph * graph,
    ggml_backend_t gpu,
    ggml_backend_t cpu) {
    PlacementCounts result{};
    const int node_count = ggml_graph_n_nodes(graph);
    result.nodes = static_cast<size_t>(node_count);
    for (int index = 0; index < node_count; ++index) {
        ggml_tensor * node = ggml_graph_node(graph, index);
        ggml_backend_t assigned =
            ggml_backend_sched_get_tensor_backend(scheduler, node);
        const bool non_view = !ggml_is_view(node);
        if (non_view) {
            ++result.non_view_compute_nodes;
        }
        if (assigned == gpu) {
            ++result.gpu_nodes;
            if (non_view) {
                ++result.gpu_non_view_compute_nodes;
            }
        } else if (assigned == cpu) {
            ++result.cpu_nodes;
            if (non_view) {
                ++result.cpu_non_view_compute_nodes;
            }
        } else {
            ++result.unassigned_nodes;
        }
    }
    return result;
}

bool placement_gate(const CaseMeasurement & item) {
    return item.placement.non_view_compute_nodes > 0 &&
        item.placement.gpu_non_view_compute_nodes ==
            item.placement.non_view_compute_nodes &&
        item.placement.unassigned_nodes == 0 &&
        item.scheduler_split_count == 1 &&
        item.copies.weight == 0 &&
        item.gpu_reserve_bytes > 0;
}

CaseMeasurement observe_reserve(
    const RunToken & token,
    ggml_backend_sched_t scheduler,
    topo::GraphCase & graph_case,
    ggml_backend_t gpu,
    ggml_backend_t cpu) {
    static_cast<void>(token.path());
    const auto sources = snapshot_sources(graph_case.full);
    std::array<size_t, 2> sizes{};
    ggml_backend_sched_reserve_size(
        scheduler, graph_case.full, sizes.data());
    CaseMeasurement measured{};
    measured.k = graph_case.batch_size;
    measured.graph_nodes = ggml_graph_n_nodes(graph_case.full);
    measured.graph_capacity = ggml_graph_size(graph_case.full);
    measured.gpu_reserve_bytes = sizes[0];
    measured.cpu_reserve_bytes = sizes[1];
    measured.scheduler_split_count =
        ggml_backend_sched_get_n_splits(scheduler);
    measured.scheduler_parallel_copy_slots =
        ggml_backend_sched_get_n_copies(scheduler);
    measured.placement = count_placement(
        scheduler, graph_case.full, gpu, cpu);
    measured.copies = classify_copies(sources);
    measured.beta_placement_gate = placement_gate(measured);
    return measured;
}

bool captures_equal(const MetalCaptures & value) {
    return value.before_weight_sizing == value.after_weight_sizing &&
        value.after_weight_sizing == value.after_dummy_attachment &&
        value.after_dummy_attachment == value.after_all_reserve_size &&
        value.after_all_reserve_size == value.after_scheduler_free;
}

json case_json(const CaseMeasurement & item) {
    return {
        {"k", item.k},
        {"graph_nodes", item.graph_nodes},
        {"graph_capacity", item.graph_capacity},
        {"reserve_bytes", {
            {"backend_index_0_gpu", item.gpu_reserve_bytes},
            {"backend_index_1_cpu", item.cpu_reserve_bytes},
        }},
        {"scheduler_split_count", item.scheduler_split_count},
        {"scheduler_parallel_copy_slots", item.scheduler_parallel_copy_slots},
        {"placement", {
            {"nodes", item.placement.nodes},
            {"non_view_compute_nodes", item.placement.non_view_compute_nodes},
            {"backend_index_0_gpu", item.placement.gpu_nodes},
            {"backend_index_1_cpu", item.placement.cpu_nodes},
            {"unassigned", item.placement.unassigned_nodes},
            {"gpu_non_view_compute_nodes",
             item.placement.gpu_non_view_compute_nodes},
            {"cpu_non_view_compute_nodes",
             item.placement.cpu_non_view_compute_nodes},
        }},
        {"inserted_copies", {
            {"total", item.copies.total},
            {"weights", item.copies.weight},
            {"graph_inputs", item.copies.graph_input},
            {"activations", item.copies.activation},
            {"changed_edges", item.copies.changed_edges},
        }},
        {"beta_placement_gate", item.beta_placement_gate},
    };
}

json repeat_json(const RepeatMeasurement & repeat) {
    json cases = json::array();
    for (const auto & item : repeat.cases) {
        cases.push_back(case_json(item));
    }
    return {
        {"repeat_index", repeat.repeat_index},
        {"weight_tensor_count", repeat.weight_tensor_count},
        {"future_real_weight_buffer_bytes",
         repeat.future_real_weight_buffer_bytes},
        {"metal_current_allocated_bytes", {
            {"before_weight_sizing", repeat.metal.before_weight_sizing},
            {"after_weight_sizing", repeat.metal.after_weight_sizing},
            {"after_dummy_attachment", repeat.metal.after_dummy_attachment},
            {"after_all_reserve_size", repeat.metal.after_all_reserve_size},
            {"after_scheduler_free", repeat.metal.after_scheduler_free},
        }},
        {"cases", cases},
    };
}

void measure_fixture(
    const RunToken & token,
    int repeat_index,
    id<MTLDevice> device,
    ggml_backend_t gpu,
    ggml_backend_t cpu,
    ggml_backend_buffer_type_t buffer_type,
    std::unique_ptr<WeightFixture> weights,
    std::unique_ptr<GraphFixture> graphs,
    topo::scheduler_ptr scheduler,
    std::vector<RepeatMeasurement> & repeats) {
    RepeatMeasurement repeat{};
    repeat.repeat_index = repeat_index;
    repeat.metal.before_weight_sizing = current_allocated_bytes(device);
    repeat.weight_tensor_count = weights->tensor_count();
    repeat.future_real_weight_buffer_bytes = weights->observe_and_anchor(
        token, buffer_type, device, repeat.metal.after_weight_sizing,
        repeat.metal.after_dummy_attachment);
    for (auto & graph_case : graphs->cases()) {
        repeat.cases.push_back(observe_reserve(
            token, scheduler.get(), graph_case, gpu, cpu));
    }
    repeat.metal.after_all_reserve_size = current_allocated_bytes(device);
    scheduler.reset();
    repeat.metal.after_scheduler_free = current_allocated_bytes(device);
    repeats.push_back(std::move(repeat));
}

struct FreshFixture {
    std::unique_ptr<WeightFixture> weights;
    std::unique_ptr<GraphFixture> graphs;
    topo::scheduler_ptr scheduler;
};

FreshFixture build_fresh_fixture(ggml_backend_t gpu, ggml_backend_t cpu) {
    FreshFixture fixture;
    fixture.weights = std::make_unique<WeightFixture>();
    fixture.graphs = std::make_unique<GraphFixture>(*fixture.weights);
    std::array<ggml_backend_t, 2> backends{gpu, cpu};
    fixture.scheduler.reset(ggml_backend_sched_new(
        backends.data(), nullptr, static_cast<int>(backends.size()),
        topo::SCHEDULER_GRAPH_SIZE, false, true));
    if (!fixture.scheduler) {
        throw std::runtime_error("qualified: fresh scheduler construction failed");
    }
    return fixture;
}

int run_selfcheck(const CliOptions & options) {
    PreconditionTable blocked_table;
    PackageEvidence package;
    try {
        package = validate_package(options);
    } catch (const std::exception & error) {
        blocked_table.finalize_blocked();
        auto artifact = base_artifact(
            options, nullptr, "fail", error.what(), blocked_table);
        artifact["schema"] = SELFCHECK_SCHEMA;
        artifact["status"] = "bootstrap-failed";
        artifact["experimental_observation_performed"] = false;
        artifact["token_consumed"] = false;
        write_json_atomic(options.output, artifact);
        return 2;
    }

    auto prepared = prepare_runtime();
    auto artifact = base_artifact(
        options, &package, "pass", "package-and-runtime-closure-match",
        prepared.preconditions);
    artifact["schema"] = SELFCHECK_SCHEMA;
    artifact["status"] = prepared.preconditions.all_pass() ? "ready" : "failed";
    artifact["experimental_observation_performed"] = false;
    artifact["weight_sizing_executed"] = false;
    artifact["scheduler_reserve_size_executed"] = false;
    artifact["real_backend_buffer_bytes_allocated"] = 0;
    artifact["token_consumed"] = false;
    artifact["fixture_constructed_then_destroyed"] = true;
    if (prepared.gpu && prepared.cpu && prepared.gpu_buffer_type) {
        artifact["backend_telemetry"] = backend_telemetry(
            prepared.gpu.get(), prepared.cpu.get(), prepared.gpu_buffer_type);
    }
    write_json_atomic(options.output, artifact);
    return prepared.preconditions.all_pass() ? 0 : 2;
}

int run_measure(const CliOptions & options) {
    PreconditionTable blocked_table;
    PackageEvidence package;
    try {
        package = validate_package(options);
        validate_selfcheck_for_measure(options);
    } catch (const std::exception & error) {
        blocked_table.finalize_blocked();
        auto artifact = base_artifact(
            options, nullptr, "fail", error.what(), blocked_table);
        artifact["schema"] = MEASUREMENT_SCHEMA;
        artifact["status"] = "pre-token-bootstrap-failed";
        artifact["token_consumed"] = false;
        artifact["experimental_observation_performed"] = false;
        write_json_atomic(options.output, artifact);
        return 2;
    }

    auto prepared = prepare_runtime();
    if (!prepared.preconditions.all_pass()) {
        auto artifact = base_artifact(
            options, &package, "pass", "package-and-selfcheck-match",
            prepared.preconditions);
        artifact["schema"] = MEASUREMENT_SCHEMA;
        artifact["status"] = "pre-token-readiness-failed";
        artifact["token_consumed"] = false;
        artifact["experimental_observation_performed"] = false;
        if (prepared.gpu && prepared.cpu && prepared.gpu_buffer_type) {
            artifact["backend_telemetry"] = backend_telemetry(
                prepared.gpu.get(), prepared.cpu.get(),
                prepared.gpu_buffer_type);
        }
        write_json_atomic(options.output, artifact);
        return 2;
    }

    RunToken token = RunToken::acquire(options.token);
    std::vector<RepeatMeasurement> repeats;
    std::string qualification_status = "complete";
    std::string qualification_stage = "complete";
    std::string qualification_detail = "none";
    const uint64_t before_backend = prepared.before_backend_init;
    const uint64_t after_backend = prepared.after_backend_init;

    try {
        qualification_stage = "repeat-1";
        measure_fixture(
            token, 1, prepared.system_device, prepared.gpu.get(),
            prepared.cpu.get(), prepared.gpu_buffer_type,
            std::move(prepared.weights), std::move(prepared.graphs),
            std::move(prepared.scheduler), repeats);
        for (int repeat_index = 2; repeat_index <= REPEAT_COUNT; ++repeat_index) {
            qualification_stage = "repeat-" + std::to_string(repeat_index);
            auto fixture = build_fresh_fixture(
                prepared.gpu.get(), prepared.cpu.get());
            measure_fixture(
                token, repeat_index, prepared.system_device,
                prepared.gpu.get(), prepared.cpu.get(),
                prepared.gpu_buffer_type, std::move(fixture.weights),
                std::move(fixture.graphs), std::move(fixture.scheduler), repeats);
        }
        qualification_stage = "classification";
    } catch (const std::exception & error) {
        qualification_status = "qualified-post-token-failure";
        qualification_detail = error.what();
    }

    bool vectors_identical = repeats.size() == REPEAT_COUNT;
    bool weight_sizes_identical = repeats.size() == REPEAT_COUNT;
    bool all_intervals_zero = repeats.size() == REPEAT_COUNT;
    bool all_placement_gates = repeats.size() == REPEAT_COUNT;
    if (!repeats.empty()) {
        for (const auto & repeat : repeats) {
            all_intervals_zero = all_intervals_zero && captures_equal(repeat.metal);
            weight_sizes_identical = weight_sizes_identical &&
                repeat.future_real_weight_buffer_bytes ==
                    repeats.front().future_real_weight_buffer_bytes;
            if (repeat.cases.size() != repeats.front().cases.size()) {
                vectors_identical = false;
            }
            for (size_t index = 0; index < repeat.cases.size(); ++index) {
                const auto & item = repeat.cases[index];
                all_placement_gates =
                    all_placement_gates && item.beta_placement_gate;
                if (index >= repeats.front().cases.size() ||
                    item.gpu_reserve_bytes !=
                        repeats.front().cases[index].gpu_reserve_bytes ||
                    item.cpu_reserve_bytes !=
                        repeats.front().cases[index].cpu_reserve_bytes) {
                    vectors_identical = false;
                }
            }
        }
    }
    if (qualification_status == "complete") {
        if (!all_intervals_zero) {
            qualification_status = "qualified-unexpected-metal-allocation";
            qualification_detail = "currentAllocatedSize changed in a no-allocation interval";
        } else if (vectors_identical && weight_sizes_identical &&
                   all_placement_gates) {
            qualification_status = "valid-beta-sizing";
        } else {
            qualification_status = "valid-placement-diagnostic";
        }
        qualification_stage = "complete";
    }

    auto artifact = base_artifact(
        options, &package, "pass", "package-and-selfcheck-match",
        prepared.preconditions);
    artifact["schema"] = MEASUREMENT_SCHEMA;
    artifact["status"] = qualification_status;
    artifact["token_consumed"] = true;
    artifact["token_path"] = token.path().string();
    artifact["experimental_observation_performed"] = true;
    artifact["selfcheck_sha256"] = options.selfcheck_sha256;
    artifact["post_token_qualification"] = {
        {"stage", qualification_stage},
        {"detail", qualification_detail},
        {"artifact_preserved", true},
        {"rejects_observation", false},
    };
    artifact["backend_device_type_order"] = {"GPU", "CPU"};
    artifact["backend_telemetry"] = backend_telemetry(
        prepared.gpu.get(), prepared.cpu.get(), prepared.gpu_buffer_type);
    artifact["weight_sizing_precedes_production_dummy_attachment"] = true;
    artifact["real_backend_buffer_bytes_allocated"] = 0;
    artifact["repeat_target"] = REPEAT_COUNT;
    artifact["repeat_count_completed"] = repeats.size();
    artifact["fully_fresh_fixture_per_repeat"] = true;
    artifact["all_reserve_vectors_identical"] = vectors_identical;
    artifact["all_weight_sizes_identical"] = weight_sizes_identical;
    artifact["all_no_allocation_intervals_zero"] = all_intervals_zero;
    artifact["all_beta_placement_gates_pass"] = all_placement_gates;
    artifact["metal_current_allocated_bytes"] = {
        {"before_backend_init", before_backend},
        {"after_backend_init", after_backend},
        {"after_all_fixtures",
         current_allocated_bytes(prepared.system_device)},
    };
    artifact["repeats"] = json::array();
    for (const auto & repeat : repeats) {
        artifact["repeats"].push_back(repeat_json(repeat));
    }
    artifact["beta_gate"] = {
        {"gpu_non_view_compute_nodes_percent", 100},
        {"unassigned_node_count", 0},
        {"scheduler_split_count", 1},
        {"weight_copy_count", 0},
    };
    artifact["limits"] = {
        {"only_backend_index_0_gpu_component_feeds_beta", true},
        {"full_gpu_cpu_vector_is_future_compute_identity", true},
        {"post_token_checks_qualify_and_never_discard", true},
        {"fixture_must_be_rebuilt_between_reserve_and_compute", true},
        {"automatic_retry", false},
        {"automatic_transition", false},
    };
    write_json_atomic(options.output, artifact);
    return 0;
}

} // namespace galactus::b2c

int main(int argc, char ** argv) {
    @autoreleasepool {
        try {
            const auto options = galactus::b2c::parse_cli(argc, argv);
            return options.phase == galactus::b2c::Phase::selfcheck
                ? galactus::b2c::run_selfcheck(options)
                : galactus::b2c::run_measure(options);
        } catch (const std::exception & error) {
            std::cerr << "error: " << error.what() << '\n';
            return 1;
        }
    }
}
