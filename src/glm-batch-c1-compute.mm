#include "b2c-sha256-file.hpp"
#include "glm-batch-b2c-topology.hpp"
#include "h4-c1-contract.hpp"
#include "nlohmann/json.hpp"

#import <Metal/Metal.h>

#include <CommonCrypto/CommonDigest.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace galactus::c1 {

namespace fs = std::filesystem;
namespace topo = galactus::b2c_topology;
namespace contract = galactus::c1_contract;
using json = nlohmann::ordered_json;

constexpr std::string_view RUNG =
    "C1_SAME8_FIXED_KV_COMPUTE_K1_K2_K4_K6_K8_R1";
constexpr std::string_view SELFCHECK_SCHEMA =
    "galactus.h4-c1-non-observational-readiness.v1";
constexpr std::string_view MEASURE_SCHEMA =
    "galactus.h4-c1-same8-fixed-kv-compute.v1";
constexpr std::size_t EXPECTED_WEIGHT_BYTES = 3473342464ULL;
constexpr std::size_t EXPECTED_KV_BYTES = 4718592ULL;
constexpr std::size_t EXPECTED_K1_GPU_RESERVE = 9603360ULL;
constexpr std::size_t EXPECTED_K1_CPU_RESERVE = 24608ULL;
constexpr std::size_t EXPECTED_K2_GPU_RESERVE = 14340672ULL;
constexpr std::size_t EXPECTED_K2_CPU_RESERVE = 49216ULL;
constexpr std::uint64_t FOOTPRINT_LIMIT_BYTES = 17179869184ULL;
constexpr std::int64_t MARGIN_BAND2_BYTES = 34616924LL;
constexpr std::size_t SAMPLE_WINDOW_BYTES = 4096;
constexpr std::size_t SAMPLE_WINDOW_COUNT = 4096;

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

struct SchedulerDeleter {
    void operator()(ggml_backend_sched_t scheduler) const {
        if (scheduler != nullptr) {
            ggml_backend_sched_free(scheduler);
        }
    }
};
using scheduler_ptr = std::unique_ptr<ggml_backend_sched, SchedulerDeleter>;

std::string required_value(int argc, char ** argv, int & index) {
    if (++index >= argc) {
        throw std::runtime_error("missing CLI value");
    }
    return argv[index];
}

CliOptions parse_cli(int argc, char ** argv) {
    CliOptions options;
    std::string phase;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--phase") {
            phase = required_value(argc, argv, index);
        } else if (argument == "--output") {
            options.output = required_value(argc, argv, index);
        } else if (argument == "--repo-root") {
            options.repo_root = required_value(argc, argv, index);
        } else if (argument == "--runtime-manifest") {
            options.runtime_manifest = required_value(argc, argv, index);
        } else if (argument == "--binary-sha256") {
            options.binary_sha256 = required_value(argc, argv, index);
        } else if (argument == "--runtime-manifest-sha256") {
            options.runtime_manifest_sha256 = required_value(argc, argv, index);
        } else if (argument == "--selfcheck-artifact") {
            options.selfcheck_artifact = required_value(argc, argv, index);
        } else if (argument == "--selfcheck-sha256") {
            options.selfcheck_sha256 = required_value(argc, argv, index);
        } else if (argument == "--token") {
            options.token = required_value(argc, argv, index);
        } else {
            throw std::runtime_error("unknown CLI argument: " + argument);
        }
    }
    if (phase == "selfcheck") {
        options.phase = Phase::selfcheck;
    } else if (phase == "measure") {
        options.phase = Phase::measure;
    } else {
        throw std::runtime_error("--phase must be selfcheck or measure");
    }
    if (options.output.empty() || options.repo_root.empty() ||
        options.runtime_manifest.empty() || options.binary_sha256.empty() ||
        options.runtime_manifest_sha256.empty()) {
        throw std::runtime_error("incomplete package identity arguments");
    }
    if (options.phase == Phase::selfcheck &&
        (!options.selfcheck_artifact.empty() || !options.selfcheck_sha256.empty() ||
         !options.token.empty())) {
        throw std::runtime_error("selfcheck cannot receive measure capabilities");
    }
    if (options.phase == Phase::measure &&
        (options.selfcheck_artifact.empty() || options.selfcheck_sha256.empty() ||
         options.token.empty())) {
        throw std::runtime_error("measure requires selfcheck identity and token path");
    }
    return options;
}

fs::path executable_path() {
    std::array<char, 4096> path{};
    std::uint32_t size = static_cast<std::uint32_t>(path.size());
    if (_NSGetExecutablePath(path.data(), &size) != 0) {
        throw std::runtime_error("executable path exceeds fixed buffer");
    }
    return fs::weakly_canonical(path.data());
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

std::string hex_digest(const unsigned char * digest, std::size_t size) {
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (std::size_t index = 0; index < size; ++index) {
        output << std::setw(2) << static_cast<unsigned int>(digest[index]);
    }
    return output.str();
}

std::string sha256_bytes(const void * bytes, std::size_t size) {
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    const auto * cursor = static_cast<const unsigned char *>(bytes);
    while (size > 0) {
        const CC_LONG count = static_cast<CC_LONG>(std::min<std::size_t>(
            size, static_cast<std::size_t>(std::numeric_limits<CC_LONG>::max())));
        CC_SHA256_Update(&context, cursor, count);
        cursor += count;
        size -= static_cast<std::size_t>(count);
    }
    std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
    CC_SHA256_Final(digest.data(), &context);
    return hex_digest(digest.data(), digest.size());
}

std::string utc_now() {
    const std::time_t value = std::time(nullptr);
    std::tm utc{};
    gmtime_r(&value, &utc);
    std::array<char, 32> buffer{};
    std::strftime(buffer.data(), buffer.size(), "%Y-%m-%dT%H:%M:%SZ", &utc);
    return buffer.data();
}

std::uint64_t physical_footprint_bytes() {
    task_vm_info_data_t information{};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO,
                  reinterpret_cast<task_info_t>(&information), &count) != KERN_SUCCESS) {
        throw std::runtime_error("task_info(TASK_VM_INFO) failed");
    }
    return information.phys_footprint;
}

std::uint64_t current_allocated_bytes(id<MTLDevice> device) {
    return static_cast<std::uint64_t>(device.currentAllocatedSize);
}

void enforce_internal_footprint() {
    if (physical_footprint_bytes() > FOOTPRINT_LIMIT_BYTES) {
        throw std::runtime_error("qualified: physical footprint exceeded 16 GiB");
    }
}

struct PackageEvidence {
    std::size_t dependency_count = 0;
};

PackageEvidence validate_package(const CliOptions & options) {
    if (galactus::b2c::sha256_file(executable_path()) != options.binary_sha256) {
        throw std::runtime_error("executable SHA-256 mismatch");
    }
    if (galactus::b2c::sha256_file(options.runtime_manifest) !=
        options.runtime_manifest_sha256) {
        throw std::runtime_error("runtime manifest SHA-256 mismatch");
    }
    const json manifest = read_json(options.runtime_manifest);
    if (manifest.at("schema") != "galactus.h4-c1-runtime-closure.v1") {
        throw std::runtime_error("runtime manifest schema mismatch");
    }
    PackageEvidence evidence;
    for (const auto & dependency : manifest.at("dependencies")) {
        const fs::path path = options.repo_root /
            dependency.at("path").get<std::string>();
        if (galactus::b2c::sha256_file(path) !=
            dependency.at("sha256").get<std::string>()) {
            throw std::runtime_error("runtime dependency SHA-256 mismatch");
        }
        ++evidence.dependency_count;
    }
    if (evidence.dependency_count == 0) {
        throw std::runtime_error("runtime closure is empty");
    }
    return evidence;
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
                "cannot atomically create unique C1 token: " + error.message());
        }
        return RunToken(path);
    }

    const fs::path & path() const { return path_; }

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
        if (tensors_.size() != 144) {
            throw std::runtime_error("weight tensor cardinality is not 144");
        }
    }

    const std::vector<topo::ExpertBundle> & experts_a() const { return experts_a_; }
    const std::vector<topo::ExpertBundle> & experts_b() const { return experts_b_; }
    const std::vector<topo::ExpertBundle> & experts_c() const { return experts_c_; }
    const std::vector<topo::SharedBundle> & shared() const { return shared_; }
    const std::vector<topo::AttentionBundle> & attention() const { return attention_; }
    std::size_t tensor_count() const { return tensors_.size(); }

    bool all_unallocated() const {
        return std::all_of(tensors_.begin(), tensors_.end(), [](const auto & item) {
            return item.tensor->buffer == nullptr && item.tensor->data == nullptr;
        });
    }

    void attach_zero_dummy(ggml_backend_buffer_type_t buffer_type) {
        dummy_.reset(ggml_backend_buft_alloc_buffer(buffer_type, 0));
        if (!dummy_ || ggml_backend_buffer_get_size(dummy_.get()) != 0 ||
            ggml_backend_buffer_get_type(dummy_.get()) != buffer_type) {
            throw std::runtime_error("zero-byte WEIGHTS dummy mismatch");
        }
        ggml_backend_buffer_set_usage(dummy_.get(), GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        for (const auto & item : tensors_) {
            item.tensor->buffer = dummy_.get();
        }
    }

    std::size_t observe_weight_size(
        const RunToken & token,
        ggml_backend_buffer_type_t buffer_type) const {
        static_cast<void>(token.path());
        return ggml_backend_alloc_ctx_tensors_from_buft_size(context_.get(), buffer_type);
    }

    void allocate_and_initialize(const RunToken & token, ggml_backend_t backend) {
        static_cast<void>(token.path());
        if (dummy_) {
            throw std::runtime_error("qualified: real weights cannot reuse dummy fixture");
        }
        buffer_.reset(ggml_backend_alloc_ctx_tensors(context_.get(), backend));
        if (!buffer_) {
            throw std::runtime_error("qualified: real weight allocation failed");
        }
        ggml_backend_buffer_set_usage(buffer_.get(), GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        if (ggml_backend_buffer_get_size(buffer_.get()) != EXPECTED_WEIGHT_BYTES) {
            throw std::runtime_error("qualified: real weight buffer size mismatch");
        }
        for (const auto & item : tensors_) {
            initialize_quantized(token, item.tensor, item.seed);
        }
    }

    ggml_backend_buffer_t buffer() const { return buffer_.get(); }

private:
    static void initialize_quantized(
        const RunToken & token,
        ggml_tensor * tensor,
        std::uint32_t seed) {
        static_cast<void>(token.path());
        const std::int64_t row_elements = tensor->ne[0];
        const std::int64_t rows = ggml_nrows(tensor);
        std::vector<float> source(static_cast<std::size_t>(row_elements));
        std::vector<float> imatrix(static_cast<std::size_t>(row_elements), 1.0F);
        for (std::int64_t index = 0; index < row_elements; ++index) {
            const double phase = static_cast<double>((index + 1) * (seed + 17U));
            source.at(static_cast<std::size_t>(index)) =
                static_cast<float>(0.01 * std::sin(phase * 0.00037));
        }
        const std::size_t row_bytes = ggml_row_size(tensor->type, row_elements);
        std::vector<std::uint8_t> quantized(row_bytes);
        const float * importance = ggml_quantize_requires_imatrix(tensor->type)
            ? imatrix.data() : nullptr;
        const std::size_t produced = ggml_quantize_chunk(
            tensor->type, source.data(), quantized.data(), 0, 1,
            row_elements, importance);
        if (produced != row_bytes) {
            throw std::runtime_error("qualified: quantized row size mismatch");
        }
        constexpr std::size_t target_chunk = 1024 * 1024;
        const std::size_t rows_per_chunk = std::max<std::size_t>(1, target_chunk / row_bytes);
        std::vector<std::uint8_t> chunk(rows_per_chunk * row_bytes);
        for (std::size_t row = 0; row < rows_per_chunk; ++row) {
            std::copy(quantized.begin(), quantized.end(), chunk.begin() +
                static_cast<std::ptrdiff_t>(row * row_bytes));
        }
        std::int64_t written_rows = 0;
        while (written_rows < rows) {
            const std::size_t count = static_cast<std::size_t>(std::min<std::int64_t>(
                rows - written_rows, static_cast<std::int64_t>(rows_per_chunk)));
            ggml_backend_tensor_set(tensor, chunk.data(),
                static_cast<std::size_t>(written_rows) * row_bytes, count * row_bytes);
            written_rows += static_cast<std::int64_t>(count);
        }
    }

    ggml_context_ptr context_;
    std::vector<topo::InitializedTensor> tensors_;
    std::vector<topo::ExpertBundle> experts_a_;
    std::vector<topo::ExpertBundle> experts_b_;
    std::vector<topo::ExpertBundle> experts_c_;
    std::vector<topo::SharedBundle> shared_;
    std::vector<topo::AttentionBundle> attention_;
    ggml_backend_buffer_ptr dummy_;
    ggml_backend_buffer_ptr buffer_;
};

struct GraphDescription {
    topo::ChainKind kind;
    const char * name;
    ggml_tensor * root;
    ggml_cgraph * graph;
};

class StructuralFixture {
public:
    StructuralFixture(const WeightFixture & weights, int batch_size)
        : batch_size_(batch_size) {
        ggml_init_params parameters{};
        parameters.mem_size = topo::CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        context_.reset(ggml_init(parameters));
        if (!context_) {
            throw std::runtime_error("graph context construction failed");
        }
        k_cache_ = ggml_new_tensor_3d(
            context_.get(), GGML_TYPE_F16, topo::MLA_QK, topo::N_CTX, 1);
        input_ = ggml_new_tensor_2d(
            context_.get(), GGML_TYPE_F32, topo::N_EMBD, batch_size);
        ids_ = ggml_new_tensor_2d(
            context_.get(), GGML_TYPE_I32, topo::N_EXPERT_USED, batch_size);
        ggml_set_input(k_cache_);
        ggml_set_input(input_);
        ggml_set_input(ids_);
        add_graph(weights, topo::ChainKind::full, "full75");
        add_graph(weights, topo::ChainKind::attention, "attention75");
        add_graph(weights, topo::ChainKind::routed, "routed75");
        add_graph(weights, topo::ChainKind::shared, "shared75");
        add_graph(weights, topo::ChainKind::combined_ffn, "combined_ffn75");
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

    ggml_cgraph * full_graph() const { return graphs_.front().graph; }
    const std::vector<GraphDescription> & graphs() const { return graphs_; }
    int batch_size() const { return batch_size_; }

private:
    void add_graph(
        const WeightFixture & weights,
        topo::ChainKind kind,
        const char * name) {
        auto * root = topo::build_chain(
            context_.get(), kind, batch_size_,
            weights.experts_a(), weights.experts_b(), weights.experts_c(),
            weights.shared(), weights.attention(), k_cache_, ids_, input_);
        ggml_set_output(root);
        graphs_.push_back({kind, name, root, topo::graph_for(context_.get(), root)});
    }

    int batch_size_;
    ggml_context_ptr context_;
    ggml_tensor * k_cache_ = nullptr;
    ggml_tensor * input_ = nullptr;
    ggml_tensor * ids_ = nullptr;
    std::vector<GraphDescription> graphs_;
};

std::string tensor_signature(const ggml_tensor * tensor) {
    std::ostringstream output;
    output << ggml_type_name(tensor->type) << ':' << ggml_op_name(tensor->op) << ':'
           << ggml_n_dims(tensor);
    for (int dimension = 0; dimension < GGML_MAX_DIMS; ++dimension) {
        output << ':' << tensor->ne[dimension] << ':' << tensor->nb[dimension];
    }
    return output.str();
}

std::string graph_canonical_sha256(ggml_cgraph * graph) {
    std::ostringstream canonical;
    const int node_count = ggml_graph_n_nodes(graph);
    canonical << node_count << ':' << ggml_graph_size(graph) << ';';
    for (int index = 0; index < node_count; ++index) {
        const ggml_tensor * node = ggml_graph_node(graph, index);
        canonical << index << '=' << tensor_signature(node) << '[';
        for (int source = 0; source < GGML_MAX_SRC; ++source) {
            if (node->src[source] != nullptr) {
                canonical << source << ':' << tensor_signature(node->src[source]) << ',';
            }
        }
        canonical << "];";
    }
    const std::string serialized = canonical.str();
    return sha256_bytes(serialized.data(), serialized.size());
}

json graph_fingerprint(const StructuralFixture & fixture) {
    json graph_rows = json::array();
    std::ostringstream canonical;
    canonical << "K=" << fixture.batch_size() << ';';
    for (const auto & description : fixture.graphs()) {
        json operation_histogram = json::object();
        json nodes = json::array();
        const int node_count = ggml_graph_n_nodes(description.graph);
        canonical << description.name << ':' << node_count << ':'
                  << ggml_graph_size(description.graph) << ';';
        for (int index = 0; index < node_count; ++index) {
            const ggml_tensor * node = ggml_graph_node(description.graph, index);
            const std::string op = ggml_op_name(node->op);
            operation_histogram[op] = operation_histogram.value(op, 0) + 1;
            json sources = json::array();
            canonical << index << '=' << tensor_signature(node) << '[';
            for (int source = 0; source < GGML_MAX_SRC; ++source) {
                if (node->src[source] != nullptr) {
                    const std::string signature = tensor_signature(node->src[source]);
                    sources.push_back(signature);
                    canonical << source << ':' << signature << ',';
                }
            }
            canonical << "];";
            nodes.push_back({
                {"index", index},
                {"signature", tensor_signature(node)},
                {"sources", sources},
            });
        }
        graph_rows.push_back({
            {"name", description.name},
            {"node_count", node_count},
            {"capacity", ggml_graph_size(description.graph)},
            {"root", tensor_signature(description.root)},
            {"canonical_sha256", graph_canonical_sha256(description.graph)},
            {"operation_histogram", operation_histogram},
            {"nodes", nodes},
        });
    }
    const std::string serialized = canonical.str();
    return {
        {"k", fixture.batch_size()},
        {"input_shape", {topo::N_EMBD, fixture.batch_size()}},
        {"ids_shape", {topo::N_EXPERT_USED, fixture.batch_size()}},
        {"kv_shape", {topo::MLA_QK, topo::N_CTX, 1}},
        {"kv_bytes", EXPECTED_KV_BYTES},
        {"graphs", graph_rows},
        {"canonical_sha256", sha256_bytes(serialized.data(), serialized.size())},
    };
}

scheduler_ptr make_scheduler(ggml_backend_t gpu, ggml_backend_t cpu) {
    std::array<ggml_backend_t, 2> backends{gpu, cpu};
    scheduler_ptr scheduler(ggml_backend_sched_new(
        backends.data(), nullptr, static_cast<int>(backends.size()),
        topo::SCHEDULER_GRAPH_SIZE, false, true));
    if (!scheduler) {
        throw std::runtime_error("GPU,CPU scheduler construction failed");
    }
    return scheduler;
}

struct Runtime {
    id<MTLDevice> device = nil;
    ggml_backend_ptr gpu;
    ggml_backend_ptr cpu;
    ggml_backend_buffer_type_t gpu_buffer_type = nullptr;
};

Runtime initialize_runtime() {
    Runtime runtime;
    runtime.device = MTLCreateSystemDefaultDevice();
    if (runtime.device == nil) {
        throw std::runtime_error("MTLCreateSystemDefaultDevice failed");
    }
    ggml_backend_load_all();
    runtime.gpu.reset(ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
    runtime.cpu.reset(ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr));
    if (!runtime.gpu || !runtime.cpu) {
        throw std::runtime_error("GPU or CPU backend unavailable");
    }
    if (ggml_backend_dev_type(ggml_backend_get_device(runtime.gpu.get())) !=
            GGML_BACKEND_DEVICE_TYPE_GPU ||
        ggml_backend_dev_type(ggml_backend_get_device(runtime.cpu.get())) !=
            GGML_BACKEND_DEVICE_TYPE_CPU) {
        throw std::runtime_error("backend enum order is not GPU,CPU");
    }
    runtime.gpu_buffer_type = ggml_backend_get_default_buffer_type(runtime.gpu.get());
    if (runtime.gpu_buffer_type == nullptr) {
        throw std::runtime_error("GPU default buffer type unavailable");
    }
    return runtime;
}

json runtime_telemetry(const Runtime & runtime) {
    return {
        {"gpu_backend", ggml_backend_name(runtime.gpu.get())},
        {"cpu_backend", ggml_backend_name(runtime.cpu.get())},
        {"gpu_buffer_type", ggml_backend_buft_name(runtime.gpu_buffer_type)},
        {"backend_order", {"GPU", "CPU"}},
    };
}

const char * component_name(topo::ChainKind kind) {
    switch (kind) {
        case topo::ChainKind::full: return "full75";
        case topo::ChainKind::attention: return "attention75";
        case topo::ChainKind::routed: return "routed75";
        case topo::ChainKind::shared: return "shared75";
        case topo::ChainKind::combined_ffn: return "combined_ffn75";
    }
    return "unknown";
}

constexpr std::array<topo::ChainKind, 5> COMPONENTS{
    topo::ChainKind::full,
    topo::ChainKind::attention,
    topo::ChainKind::routed,
    topo::ChainKind::shared,
    topo::ChainKind::combined_ffn,
};

struct SelfcheckFingerprints {
    std::array<std::string, 5> fixture;
    std::array<std::array<std::string, 5>, 5> components;
};

void validate_selfcheck_for_measure(
    const CliOptions & options,
    SelfcheckFingerprints & fingerprints) {
    if (galactus::b2c::sha256_file(options.selfcheck_artifact) !=
        options.selfcheck_sha256) {
        throw std::runtime_error("selfcheck artifact SHA-256 mismatch");
    }
    const json document = read_json(options.selfcheck_artifact);
    if (document.at("schema") != SELFCHECK_SCHEMA ||
        document.at("phase") != "selfcheck" || document.at("status") != "ready" ||
        document.at("binary_sha256") != options.binary_sha256 ||
        document.at("runtime_manifest_sha256") != options.runtime_manifest_sha256 ||
        document.at("experimental_observation_performed") != false ||
        document.at("scheduler_reserve_size_executed") != false ||
        document.at("real_backend_buffer_bytes_allocated") != 0 ||
        document.at("tensor_initialization_executed") != false ||
        document.at("graph_compute_executed") != false) {
        throw std::runtime_error("selfcheck is not measure-eligible");
    }
    const auto & cases = document.at("cases");
    if (cases.size() != contract::BATCH_SIZES.size()) {
        throw std::runtime_error("selfcheck K cardinality mismatch");
    }
    for (std::size_t index = 0; index < contract::BATCH_SIZES.size(); ++index) {
        if (cases.at(index).at("k") != contract::BATCH_SIZES.at(index) ||
            cases.at(index).at("status") != "pass") {
            throw std::runtime_error("selfcheck K ordering or status mismatch");
        }
        fingerprints.fixture.at(index) =
            cases.at(index).at("fingerprint").at("canonical_sha256").get<std::string>();
        const auto & graphs = cases.at(index).at("fingerprint").at("graphs");
        if (graphs.size() != COMPONENTS.size()) {
            throw std::runtime_error("selfcheck component cardinality mismatch");
        }
        for (std::size_t component = 0; component < COMPONENTS.size(); ++component) {
            if (graphs.at(component).at("name") != component_name(COMPONENTS.at(component))) {
                throw std::runtime_error("selfcheck component ordering mismatch");
            }
            fingerprints.components.at(index).at(component) =
                graphs.at(component).at("canonical_sha256").get<std::string>();
        }
    }
}

int run_selfcheck(const CliOptions & options) {
    json artifact = {
        {"schema", SELFCHECK_SCHEMA},
        {"rung", RUNG},
        {"phase", "selfcheck"},
        {"status", "blocked"},
        {"timestamp_utc", utc_now()},
        {"binary_sha256", options.binary_sha256},
        {"runtime_manifest_sha256", options.runtime_manifest_sha256},
        {"experimental_observation_performed", false},
        {"token_consumed", false},
        {"weight_sizing_executed", false},
        {"scheduler_reserve_size_executed", false},
        {"real_backend_buffer_bytes_allocated", 0},
        {"tensor_initialization_executed", false},
        {"graph_compute_executed", false},
        {"model_or_pack_read", false},
        {"cases", json::array()},
    };
    try {
        const PackageEvidence package = validate_package(options);
        Runtime runtime = initialize_runtime();
        artifact["runtime_dependency_count"] = package.dependency_count;
        artifact["backend_telemetry"] = runtime_telemetry(runtime);
        artifact["metal_current_allocated_before_fixtures"] =
            current_allocated_bytes(runtime.device);
        for (const int batch_size : contract::BATCH_SIZES) {
            WeightFixture weights;
            if (!weights.all_unallocated()) {
                throw std::runtime_error("selfcheck weight tensor unexpectedly allocated");
            }
            weights.attach_zero_dummy(runtime.gpu_buffer_type);
            StructuralFixture graphs(weights, batch_size);
            if (!graphs.all_unallocated()) {
                throw std::runtime_error("selfcheck graph tensor unexpectedly allocated");
            }
            auto scheduler = make_scheduler(runtime.gpu.get(), runtime.cpu.get());
            static_cast<void>(scheduler);
            artifact["cases"].push_back({
                {"k", batch_size},
                {"status", "pass"},
                {"weight_tensor_count", weights.tensor_count()},
                {"zero_dummy_bytes", 0},
                {"fingerprint", graph_fingerprint(graphs)},
            });
        }
        artifact["metal_current_allocated_after_fixtures"] =
            current_allocated_bytes(runtime.device);
        artifact["status"] = "ready";
        write_json_atomic(options.output, artifact);
        return 0;
    } catch (const std::exception & error) {
        artifact["status"] = "blocked";
        artifact["error"] = error.what();
        write_json_atomic(options.output, artifact);
        return 3;
    }
}

struct ReserveObservation {
    int batch_size = 0;
    std::size_t gpu_bytes = 0;
    std::size_t cpu_bytes = 0;
    std::size_t weight_bytes = 0;
    std::string fingerprint;
    std::array<std::string, 5> component_fingerprints;
};

ReserveObservation size_one(
    const RunToken & token,
    Runtime & runtime,
    int batch_size) {
    WeightFixture weights;
    const std::size_t weight_bytes =
        weights.observe_weight_size(token, runtime.gpu_buffer_type);
    weights.attach_zero_dummy(runtime.gpu_buffer_type);
    StructuralFixture graphs(weights, batch_size);
    const json fingerprint = graph_fingerprint(graphs);
    auto scheduler = make_scheduler(runtime.gpu.get(), runtime.cpu.get());
    std::array<std::size_t, 2> sizes{};
    static_cast<void>(token.path());
    ggml_backend_sched_reserve_size(scheduler.get(), graphs.full_graph(), sizes.data());
    std::array<std::string, 5> component_fingerprints{};
    for (std::size_t component = 0; component < COMPONENTS.size(); ++component) {
        component_fingerprints.at(component) =
            fingerprint.at("graphs").at(component).at("canonical_sha256").get<std::string>();
    }
    return {batch_size, sizes.at(0), sizes.at(1), weight_bytes,
            fingerprint.at("canonical_sha256").get<std::string>(),
            component_fingerprints};
}

class ComponentFixture {
public:
    ComponentFixture(
        const WeightFixture & weights,
        int batch_size,
        topo::ChainKind kind) : batch_size_(batch_size) {
        ggml_init_params parameters{};
        parameters.mem_size = topo::CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        context_.reset(ggml_init(parameters));
        if (!context_) {
            throw std::runtime_error("qualified: component graph context failed");
        }
        k_cache_ = ggml_new_tensor_3d(
            context_.get(), GGML_TYPE_F16, topo::MLA_QK, topo::N_CTX, 1);
        input_ = ggml_new_tensor_2d(
            context_.get(), GGML_TYPE_F32, topo::N_EMBD, batch_size);
        ids_ = ggml_new_tensor_2d(
            context_.get(), GGML_TYPE_I32, topo::N_EXPERT_USED, batch_size);
        ggml_set_input(k_cache_);
        ggml_set_input(input_);
        ggml_set_input(ids_);
        root_ = topo::build_chain(
            context_.get(), kind, batch_size,
            weights.experts_a(), weights.experts_b(), weights.experts_c(),
            weights.shared(), weights.attention(), k_cache_, ids_, input_);
        ggml_set_output(root_);
        graph_ = topo::graph_for(context_.get(), root_);
    }

    void allocate_and_set_inputs(
        const RunToken & token,
        ggml_backend_sched_t scheduler,
        const std::vector<float> & input_values) {
        static_cast<void>(token.path());
        if (!ggml_backend_sched_alloc_graph(scheduler, graph_)) {
            throw std::runtime_error("qualified: scheduler graph allocation failed");
        }
        if (ggml_nbytes(k_cache_) != EXPECTED_KV_BYTES) {
            throw std::runtime_error("qualified: fixed KV size mismatch");
        }
        if (input_values.size() !=
            static_cast<std::size_t>(topo::N_EMBD * batch_size_)) {
            throw std::runtime_error("qualified: input geometry mismatch");
        }
        set_zero(token, k_cache_);
        ggml_backend_tensor_set(input_, input_values.data(), 0,
                                input_values.size() * sizeof(float));
        std::vector<std::int32_t> ids(
            static_cast<std::size_t>(topo::N_EXPERT_USED * batch_size_));
        for (int position = 0; position < batch_size_; ++position) {
            std::iota(ids.begin() + position * topo::N_EXPERT_USED,
                      ids.begin() + (position + 1) * topo::N_EXPERT_USED, 0);
        }
        ggml_backend_tensor_set(ids_, ids.data(), 0, ids.size() * sizeof(std::int32_t));
    }

    double compute(const RunToken & token, ggml_backend_sched_t scheduler) {
        static_cast<void>(token.path());
        const auto start = std::chrono::steady_clock::now();
        const ggml_status status = ggml_backend_sched_graph_compute(scheduler, graph_);
        const auto end = std::chrono::steady_clock::now();
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error(
                std::string("qualified: graph compute failed: ") +
                ggml_status_to_string(status));
        }
        return std::chrono::duration<double, std::milli>(end - start).count();
    }

    std::vector<std::uint8_t> output(const RunToken & token) const {
        static_cast<void>(token.path());
        std::vector<std::uint8_t> bytes(ggml_nbytes(root_));
        ggml_backend_tensor_get(root_, bytes.data(), 0, bytes.size());
        if (bytes.size() != static_cast<std::size_t>(topo::N_EMBD * batch_size_) *
                sizeof(float)) {
            throw std::runtime_error("qualified: output geometry mismatch");
        }
        for (std::size_t offset = 0; offset < bytes.size(); offset += sizeof(float)) {
            float value = 0.0F;
            std::memcpy(&value, bytes.data() + offset, sizeof(value));
            if (!std::isfinite(value)) {
                throw std::runtime_error("qualified: non-finite output");
            }
        }
        return bytes;
    }

    std::string canonical_sha256() const {
        return graph_canonical_sha256(graph_);
    }

private:
    static void set_zero(const RunToken & token, ggml_tensor * tensor) {
        static_cast<void>(token.path());
        constexpr std::size_t chunk_bytes = 1024 * 1024;
        std::vector<std::uint8_t> zeros(chunk_bytes, 0);
        for (std::size_t offset = 0; offset < ggml_nbytes(tensor); offset += chunk_bytes) {
            const std::size_t count = std::min(chunk_bytes, ggml_nbytes(tensor) - offset);
            ggml_backend_tensor_set(tensor, zeros.data(), offset, count);
        }
    }

    int batch_size_;
    ggml_context_ptr context_;
    ggml_tensor * k_cache_ = nullptr;
    ggml_tensor * input_ = nullptr;
    ggml_tensor * ids_ = nullptr;
    ggml_tensor * root_ = nullptr;
    ggml_cgraph * graph_ = nullptr;
};

std::string weight_full_digest(const RunToken & token, ggml_backend_buffer_t buffer) {
    static_cast<void>(token.path());
    const void * base = ggml_backend_buffer_get_base(buffer);
    const std::size_t size = ggml_backend_buffer_get_size(buffer);
    if (base == nullptr || size != EXPECTED_WEIGHT_BYTES) {
        throw std::runtime_error("qualified: weight base or size mismatch");
    }
    return sha256_bytes(base, size);
}

struct SampleDigest {
    std::string sha256;
    std::vector<std::size_t> offsets;
};

SampleDigest weight_sample_digest(const RunToken & token, ggml_backend_buffer_t buffer) {
    static_cast<void>(token.path());
    const auto * base = static_cast<const std::uint8_t *>(
        ggml_backend_buffer_get_base(buffer));
    const std::size_t size = ggml_backend_buffer_get_size(buffer);
    if (base == nullptr || size < SAMPLE_WINDOW_BYTES) {
        throw std::runtime_error("qualified: weight buffer cannot be sampled");
    }
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    SampleDigest result;
    result.offsets.reserve(SAMPLE_WINDOW_COUNT);
    for (std::size_t index = 0; index < SAMPLE_WINDOW_COUNT; ++index) {
        const std::size_t offset = index * (size - SAMPLE_WINDOW_BYTES) /
            (SAMPLE_WINDOW_COUNT - 1);
        result.offsets.push_back(offset);
        CC_SHA256_Update(&context, base + offset,
                         static_cast<CC_LONG>(SAMPLE_WINDOW_BYTES));
    }
    std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
    CC_SHA256_Final(digest.data(), &context);
    result.sha256 = hex_digest(digest.data(), digest.size());
    return result;
}

std::vector<std::string> position_digests(
    const std::vector<std::uint8_t> & output,
    int batch_size) {
    const std::size_t bytes_per_position =
        static_cast<std::size_t>(topo::N_EMBD) * sizeof(float);
    if (output.size() != bytes_per_position * static_cast<std::size_t>(batch_size)) {
        throw std::runtime_error("qualified: positional digest geometry mismatch");
    }
    std::vector<std::string> digests;
    digests.reserve(static_cast<std::size_t>(batch_size));
    for (int position = 0; position < batch_size; ++position) {
        digests.push_back(sha256_bytes(
            output.data() + static_cast<std::size_t>(position) * bytes_per_position,
            bytes_per_position));
    }
    return digests;
}

struct ComponentResult {
    double elapsed_ms = 0.0;
    std::string output_sha256;
    std::string fingerprint_sha256;
};

ComponentResult execute_component(
    const RunToken & token,
    const WeightFixture & weights,
    int batch_size,
    topo::ChainKind kind,
    ggml_backend_sched_t scheduler,
    const std::vector<float> & inputs,
    const std::string & expected_fingerprint,
    std::vector<std::uint8_t> * full_output) {
    ComponentFixture fixture(weights, batch_size, kind);
    const std::string fingerprint = fixture.canonical_sha256();
    if (fingerprint != expected_fingerprint) {
        throw std::runtime_error("qualified: ComputeFixture structural fingerprint mismatch");
    }
    fixture.allocate_and_set_inputs(token, scheduler, inputs);
    const double elapsed = fixture.compute(token, scheduler);
    std::vector<std::uint8_t> output = fixture.output(token);
    const std::string digest = sha256_bytes(output.data(), output.size());
    if (full_output != nullptr) {
        *full_output = std::move(output);
    }
    ggml_backend_sched_reset(scheduler);
    return {elapsed, digest, fingerprint};
}

json execute_k(
    const RunToken & token,
    Runtime & runtime,
    const WeightFixture & weights,
    int batch_size,
    const std::vector<float> & inputs,
    const std::array<std::string, 5> & expected_fingerprints,
    bool all_components,
    std::vector<std::uint8_t> * full_output) {
    enforce_internal_footprint();
    const std::uint64_t before_metal = current_allocated_bytes(runtime.device);
    const std::uint64_t before_footprint = physical_footprint_bytes();
    auto scheduler = make_scheduler(runtime.gpu.get(), runtime.cpu.get());
    json components = json::object();
    for (std::size_t component_index = 0; component_index < COMPONENTS.size();
         ++component_index) {
        const topo::ChainKind kind = COMPONENTS.at(component_index);
        if (!all_components && kind != topo::ChainKind::full) {
            continue;
        }
        ComponentResult result = execute_component(
            token, weights, batch_size, kind, scheduler.get(), inputs,
            expected_fingerprints.at(component_index),
            kind == topo::ChainKind::full ? full_output : nullptr);
        components[component_name(kind)] = {
            {"elapsed_ms", result.elapsed_ms},
            {"output_sha256", result.output_sha256},
            {"fingerprint_sha256", result.fingerprint_sha256},
            {"selfcheck_fingerprint_match", true},
        };
    }
    scheduler.reset();
    enforce_internal_footprint();
    return {
        {"k", batch_size},
        {"timestamp_utc", utc_now()},
        {"components", components},
        {"metal_current_allocated_before", before_metal},
        {"metal_current_allocated_after_scheduler_free",
         current_allocated_bytes(runtime.device)},
        {"physical_footprint_before", before_footprint},
        {"physical_footprint_after", physical_footprint_bytes()},
        {"temperature_celsius", nullptr},
        {"power_watts", nullptr},
        {"temperature_power_status", "unavailable-without-privileged-sampler"},
    };
}

double percentile(std::vector<double> values, double quantile) {
    if (values.empty()) {
        throw std::runtime_error("qualified: empty timing series");
    }
    std::sort(values.begin(), values.end());
    const std::size_t index = static_cast<std::size_t>(
        std::ceil(quantile * static_cast<double>(values.size())) - 1.0);
    return values.at(std::min(index, values.size() - 1));
}

json summarize(const json & rounds, const std::vector<ReserveObservation> & sizing) {
    json summary = json::array();
    double k1_p50 = 0.0;
    for (std::size_t k_index = 0; k_index < contract::BATCH_SIZES.size(); ++k_index) {
        const int batch_size = contract::BATCH_SIZES.at(k_index);
        json component_summary = json::object();
        for (const topo::ChainKind kind : COMPONENTS) {
            std::vector<double> samples;
            std::vector<std::string> checksums;
            for (const auto & round : rounds) {
                for (const auto & execution : round.at("executions")) {
                    if (execution.at("k") == batch_size) {
                        const auto & component = execution.at("components").at(component_name(kind));
                        samples.push_back(component.at("elapsed_ms").get<double>());
                        checksums.push_back(component.at("output_sha256").get<std::string>());
                    }
                }
            }
            component_summary[component_name(kind)] = {
                {"samples_ms", samples},
                {"p50_ms", percentile(samples, 0.50)},
                {"p95_ms", percentile(samples, 0.95)},
                {"output_sha256", checksums},
                {"checksum_deterministic",
                 std::set<std::string>(checksums.begin(), checksums.end()).size() == 1},
            };
        }
        const double p50 = component_summary.at("full75").at("p50_ms").get<double>();
        if (batch_size == 1) {
            k1_p50 = p50;
        }
        const double ratio = k1_p50 > 0.0 ? p50 / k1_p50 : 1.0;
        const std::int64_t delta = static_cast<std::int64_t>(sizing.at(k_index).gpu_bytes) -
            static_cast<std::int64_t>(sizing.front().gpu_bytes);
        summary.push_back({
            {"k", batch_size},
            {"components", component_summary},
            {"R_k", ratio},
            {"beta_k", batch_size == 1 ? json(nullptr) :
                json((ratio - 1.0) / static_cast<double>(batch_size - 1))},
            {"same8_fixed_kv_compute_positions_per_second_upper_bound",
             1000.0 * static_cast<double>(batch_size) / p50},
            {"reserve_gpu_bytes", sizing.at(k_index).gpu_bytes},
            {"reserve_cpu_bytes", sizing.at(k_index).cpu_bytes},
            {"delta_reserve_gpu_against_k1", delta},
            {"remaining_band2_known_bytes", MARGIN_BAND2_BYTES - delta},
        });
    }
    return summary;
}

const json & execution_for_k(const json & executions, int batch_size) {
    const json * match = nullptr;
    for (const auto & execution : executions) {
        if (execution.at("k") == batch_size) {
            if (match != nullptr) {
                throw std::runtime_error(
                    "qualified: duplicate K in determinism identity scope");
            }
            match = &execution;
        }
    }
    if (match == nullptr) {
        throw std::runtime_error(
            "qualified: missing K in determinism identity scope");
    }
    return *match;
}

std::pair<json, bool> build_determinism_identity_gate(
    const json & warmups,
    const json & measured_rounds) {
    if (warmups.size() != contract::WARMUP_ORDERS.size() ||
        warmups.at(0).at("round") != "A" ||
        measured_rounds.size() != contract::MEASURED_ORDERS.size()) {
        throw std::runtime_error(
            "qualified: determinism identity phase cardinality mismatch");
    }
    json rows = json::array();
    bool all_pass = true;
    for (const int batch_size : contract::BATCH_SIZES) {
        for (const topo::ChainKind kind : COMPONENTS) {
            const bool has_warmup_reference = kind == topo::ChainKind::full;
            const std::size_t expected_occurrences = has_warmup_reference ? 8 : 7;
            std::vector<std::string> digests;
            json occurrence_labels = json::array();
            if (has_warmup_reference) {
                const auto & warmup_execution = execution_for_k(
                    warmups.at(0).at("executions"), batch_size);
                digests.push_back(warmup_execution.at("components")
                    .at(component_name(kind)).at("output_sha256").get<std::string>());
                occurrence_labels.push_back("warmup-A");
            }
            for (std::size_t round = 0; round < measured_rounds.size(); ++round) {
                const auto & measured_execution = execution_for_k(
                    measured_rounds.at(round).at("executions"), batch_size);
                digests.push_back(measured_execution.at("components")
                    .at(component_name(kind)).at("output_sha256").get<std::string>());
                occurrence_labels.push_back("measured-r" + std::to_string(round + 1));
            }
            const contract::DigestIdentityResult result =
                contract::evaluate_digest_identity(digests, expected_occurrences);
            all_pass = all_pass && result.pass;
            rows.push_back({
                {"k", batch_size},
                {"component", component_name(kind)},
                {"scope", has_warmup_reference
                    ? "warmup-A-plus-seven-measured"
                    : "seven-measured-only"},
                {"warmup_reference_available", has_warmup_reference},
                {"positional_gate", false},
                {"expected_occurrence_count", expected_occurrences},
                {"observed_occurrence_count", result.occurrence_count},
                {"occurrence_labels", occurrence_labels},
                {"output_sha256", digests},
                {"reference_sha256", result.reference},
                {"mismatch_indices", result.mismatch_indices},
                {"status", result.pass ? "pass" : "fail"},
                {"reason", result.reason},
            });
        }
    }
    return {{
        {"status", all_pass ? "pass" : "fail"},
        {"additional_graph_compute_count", 0},
        {"additional_output_hash_count", 0},
        {"full75_occurrences_per_k", 8},
        {"auxiliary_occurrences_per_k", 7},
        {"auxiliary_warmup_equivalence_claimed", false},
        {"rows", rows},
    }, all_pass};
}

int run_measure(const CliOptions & options) {
    SelfcheckFingerprints expected_fingerprints{};
    validate_package(options);
    validate_selfcheck_for_measure(options, expected_fingerprints);
    Runtime runtime = initialize_runtime();

    RunToken token = RunToken::acquire(options.token);
    json artifact = {
        {"schema", MEASURE_SCHEMA},
        {"rung", RUNG},
        {"phase", "measure"},
        {"status", "qualified-in-progress"},
        {"timestamp_utc", utc_now()},
        {"binary_sha256", options.binary_sha256},
        {"runtime_manifest_sha256", options.runtime_manifest_sha256},
        {"selfcheck_sha256", options.selfcheck_sha256},
        {"measurement_token", token.path().string()},
        {"measurement_token_consumed", true},
        {"experimental_observation_performed", false},
        {"model_or_pack_read", false},
        {"automatic_retry_authorized", false},
        {"automatic_transition_authorized", false},
        {"end_to_end_throughput_derivation_authorized", false},
        {"post_token_artifact_preserved", true},
        {"sizing", json::array()},
        {"warmups", json::array()},
        {"measured_rounds", json::array()},
    };
    auto publish = [&]() { write_json_atomic(options.output, artifact); };
    publish();
    try {
        artifact["backend_telemetry"] = runtime_telemetry(runtime);
        std::vector<ReserveObservation> sizing;
        for (std::size_t index = 0; index < contract::BATCH_SIZES.size(); ++index) {
            const int batch_size = contract::BATCH_SIZES.at(index);
            ReserveObservation observed = size_one(token, runtime, batch_size);
            artifact["experimental_observation_performed"] = true;
            const bool fingerprint_matches =
                observed.fingerprint == expected_fingerprints.fixture.at(index) &&
                observed.component_fingerprints == expected_fingerprints.components.at(index);
            artifact["sizing"].push_back({
                {"k", batch_size},
                {"weight_bytes", observed.weight_bytes},
                {"reserve_gpu_bytes", observed.gpu_bytes},
                {"reserve_cpu_bytes", observed.cpu_bytes},
                {"fingerprint_sha256", observed.fingerprint},
                {"component_fingerprint_sha256", observed.component_fingerprints},
                {"selfcheck_fingerprint_match", fingerprint_matches},
            });
            sizing.push_back(observed);
            publish();
            if (observed.weight_bytes != EXPECTED_WEIGHT_BYTES || !fingerprint_matches) {
                throw std::runtime_error("qualified: sizing identity mismatch");
            }
            if ((batch_size == 1 &&
                 (observed.gpu_bytes != EXPECTED_K1_GPU_RESERVE ||
                  observed.cpu_bytes != EXPECTED_K1_CPU_RESERVE)) ||
                (batch_size == 2 &&
                 (observed.gpu_bytes != EXPECTED_K2_GPU_RESERVE ||
                  observed.cpu_bytes != EXPECTED_K2_CPU_RESERVE))) {
                throw std::runtime_error("qualified: K1/K2 reserve asymmetry failed");
            }
        }
        WeightFixture weights;
        weights.allocate_and_initialize(token, runtime.gpu.get());
        enforce_internal_footprint();
        const std::uintptr_t weight_base = reinterpret_cast<std::uintptr_t>(
            ggml_backend_buffer_get_base(weights.buffer()));
        const std::uint64_t resident_metal_baseline =
            current_allocated_bytes(runtime.device);
        const std::string full_digest_before = weight_full_digest(token, weights.buffer());
        const SampleDigest sample_before = weight_sample_digest(token, weights.buffer());
        artifact["weights"] = {
            {"buffer_base_address", weight_base},
            {"buffer_bytes", ggml_backend_buffer_get_size(weights.buffer())},
            {"full_sha256_before_warmup", full_digest_before},
            {"sample_sha256_before_warmup", sample_before.sha256},
            {"sample_window_bytes", SAMPLE_WINDOW_BYTES},
            {"sample_window_count", SAMPLE_WINDOW_COUNT},
            {"sample_offsets", sample_before.offsets},
            {"metal_resident_baseline_observed", resident_metal_baseline},
        };
        publish();

        std::array<std::vector<std::uint8_t>, 5> canonical_outputs;
        for (std::size_t round_index = 0; round_index < contract::WARMUP_ORDERS.size();
             ++round_index) {
            artifact["warmups"].push_back({
                {"round", round_index == 0 ? "A" : "B"},
                {"order", contract::WARMUP_ORDERS.at(round_index)},
                {"cyclic_shift", contract::CYCLIC_SHIFT},
                {"executions", json::array()},
            });
            for (const int batch_size : contract::WARMUP_ORDERS.at(round_index)) {
                const auto found = std::find(
                    contract::BATCH_SIZES.begin(), contract::BATCH_SIZES.end(), batch_size);
                const std::size_t index = static_cast<std::size_t>(
                    found - contract::BATCH_SIZES.begin());
                const std::vector<float> canonical = contract::make_canonical_inputs(batch_size);
                const std::vector<float> inputs = round_index == 0
                    ? canonical : contract::cyclic_shift_inputs(canonical, batch_size);
                const SampleDigest before_sample =
                    weight_sample_digest(token, weights.buffer());
                const std::uintptr_t before_weight_base = reinterpret_cast<std::uintptr_t>(
                    ggml_backend_buffer_get_base(weights.buffer()));
                std::vector<std::uint8_t> output;
                json execution;
                @autoreleasepool {
                    execution = execute_k(
                        token, runtime, weights, batch_size, inputs,
                        expected_fingerprints.components.at(index), false, &output);
                }
                const SampleDigest after_sample = weight_sample_digest(token, weights.buffer());
                const std::uintptr_t after_weight_base = reinterpret_cast<std::uintptr_t>(
                    ggml_backend_buffer_get_base(weights.buffer()));
                if (before_sample.sha256 != sample_before.sha256 ||
                    after_sample.sha256 != sample_before.sha256 ||
                    before_weight_base != weight_base || after_weight_base != weight_base ||
                    reinterpret_cast<std::uintptr_t>(
                        ggml_backend_buffer_get_base(weights.buffer())) != weight_base ||
                    ggml_backend_buffer_get_size(weights.buffer()) != EXPECTED_WEIGHT_BYTES) {
                    throw std::runtime_error("qualified: persistent weights changed during warmup");
                }
                if (current_allocated_bytes(runtime.device) != resident_metal_baseline) {
                    throw std::runtime_error("qualified: Metal baseline drift after warmup fixture");
                }
                if (round_index == 0) {
                    canonical_outputs.at(index) = std::move(output);
                    execution["intra_k_gate"] = {
                        {"status", batch_size == 1 ? "vacuous" : "pending-warmup-B"},
                        {"canonical_position_sha256",
                         position_digests(canonical_outputs.at(index), batch_size)},
                    };
                } else {
                    const contract::GateResult gate = contract::evaluate_gate(
                        canonical_outputs.at(index), output, batch_size,
                        static_cast<std::size_t>(topo::N_EMBD) * sizeof(float));
                    execution["intra_k_gate"] = {
                        {"status", contract::gate_status_name(gate.status)},
                        {"pairwise_distinct", gate.pairwise_distinct},
                        {"cyclic_equivariant", gate.cyclic_equivariant},
                        {"reason", gate.reason},
                        {"canonical_position_sha256",
                         position_digests(canonical_outputs.at(index), batch_size)},
                        {"shifted_position_sha256", position_digests(output, batch_size)},
                    };
                    if (batch_size > 1 && gate.status != contract::GateStatus::pass) {
                        throw std::runtime_error("qualified: intra-K positional gate failed");
                    }
                }
                execution["input_sha256"] = sha256_bytes(
                    inputs.data(), inputs.size() * sizeof(float));
                execution["weight_buffer_base_address_before"] = before_weight_base;
                execution["weight_buffer_base_address_after"] = after_weight_base;
                execution["weight_sample_sha256_before"] = before_sample.sha256;
                execution["weight_sample_sha256_after"] = after_sample.sha256;
                artifact["warmups"].back()["executions"].push_back(execution);
                publish();
            }
        }

        for (std::size_t round_index = 0; round_index < contract::MEASURED_ORDERS.size();
             ++round_index) {
            artifact["measured_rounds"].push_back({
                {"round", round_index + 1},
                {"order", contract::MEASURED_ORDERS.at(round_index)},
                {"executions", json::array()},
            });
            for (const int batch_size : contract::MEASURED_ORDERS.at(round_index)) {
                const SampleDigest sample_fixture_before =
                    weight_sample_digest(token, weights.buffer());
                const std::uintptr_t base_fixture_before = reinterpret_cast<std::uintptr_t>(
                    ggml_backend_buffer_get_base(weights.buffer()));
                const auto found = std::find(
                    contract::BATCH_SIZES.begin(), contract::BATCH_SIZES.end(), batch_size);
                const std::size_t index = static_cast<std::size_t>(
                    found - contract::BATCH_SIZES.begin());
                json execution;
                @autoreleasepool {
                    execution = execute_k(
                        token, runtime, weights, batch_size,
                        contract::make_canonical_inputs(batch_size),
                        expected_fingerprints.components.at(index), true, nullptr);
                }
                const SampleDigest sample_fixture_after =
                    weight_sample_digest(token, weights.buffer());
                const std::uintptr_t base_fixture_after = reinterpret_cast<std::uintptr_t>(
                    ggml_backend_buffer_get_base(weights.buffer()));
                execution["weight_buffer_base_address_before"] = base_fixture_before;
                execution["weight_buffer_base_address_after"] = base_fixture_after;
                execution["weight_buffer_bytes"] = EXPECTED_WEIGHT_BYTES;
                execution["weight_sample_sha256_before"] = sample_fixture_before.sha256;
                execution["weight_sample_sha256_after"] = sample_fixture_after.sha256;
                execution["metal_baseline_expected"] = resident_metal_baseline;
                if (sample_fixture_before.sha256 != sample_before.sha256 ||
                    sample_fixture_after.sha256 != sample_before.sha256 ||
                    base_fixture_before != weight_base || base_fixture_after != weight_base ||
                    current_allocated_bytes(runtime.device) != resident_metal_baseline) {
                    throw std::runtime_error(
                        "qualified: weight identity or Metal baseline drift after measured fixture");
                }
                artifact["measured_rounds"].back()["executions"].push_back(execution);
                publish();
            }
        }

        const auto determinism_gate = build_determinism_identity_gate(
            artifact["warmups"], artifact["measured_rounds"]);
        artifact["determinism_identity_gate"] = determinism_gate.first;
        publish();
        if (!determinism_gate.second) {
            throw std::runtime_error(
                "qualified: cross-round output digest identity failed");
        }

        const std::string full_digest_after = weight_full_digest(token, weights.buffer());
        const SampleDigest sample_after = weight_sample_digest(token, weights.buffer());
        artifact["weights"]["full_sha256_after_measure"] = full_digest_after;
        artifact["weights"]["sample_sha256_after_measure"] = sample_after.sha256;
        artifact["weights"]["immutable"] =
            full_digest_after == full_digest_before && sample_after.sha256 == sample_before.sha256;
        if (!artifact["weights"]["immutable"].get<bool>()) {
            throw std::runtime_error("qualified: persistent weight buffer mutated");
        }
        artifact["schedule"] = {
            {"warmup_orders", contract::WARMUP_ORDERS},
            {"measured_orders", contract::MEASURED_ORDERS},
            {"slot_sums", contract::measured_slot_sums()},
            {"slot_means", {2.0, 2.0, 2.0, 2.0, 2.0}},
            {"slot_variance_numerators", contract::measured_slot_variance_numerators()},
            {"slot_variance_denominator", 7},
            {"linear_drift_orthogonalized", true},
            {"curvature_residual_eliminated", false},
        };
        artifact["summary"] = summarize(artifact["measured_rounds"], sizing);
        artifact["memory_accounting"] = json::array();
        for (const auto & observed : sizing) {
            const std::size_t input_bytes = static_cast<std::size_t>(topo::N_EMBD) *
                static_cast<std::size_t>(observed.batch_size) * sizeof(float);
            const std::size_t ids_bytes = static_cast<std::size_t>(topo::N_EXPERT_USED) *
                static_cast<std::size_t>(observed.batch_size) * sizeof(std::int32_t);
            artifact["memory_accounting"].push_back({
                {"k", observed.batch_size},
                {"persistent_weight_bytes", EXPECTED_WEIGHT_BYTES},
                {"fresh_fixed_kv_bytes", EXPECTED_KV_BYTES},
                {"input_bytes", input_bytes},
                {"ids_bytes", ids_bytes},
                {"gpu_activation_scratch_scheduler_reserve_bytes", observed.gpu_bytes},
                {"cpu_activation_scratch_scheduler_reserve_bytes", observed.cpu_bytes},
                {"known_gpu_total_bytes", EXPECTED_WEIGHT_BYTES + EXPECTED_KV_BYTES +
                    input_bytes + ids_bytes + observed.gpu_bytes},
            });
        }
        artifact["historical_baseline"] = {
            {"tour", 113},
            {"full75_k1_ms", 61.3358125},
            {"non_regression_tolerance", nullptr},
            {"gate", false},
        };
        artifact["kv_capacity_statement"] = {
            {"k8_increment_per_layer_bytes", 9216},
            {"percent_of_fixed_kv", 0.1953125},
            {"type", "resident_capacity_only"},
            {"unexecuted_75_layer_write_bytes_at_k8", 691200},
            {"compute_credit_authorized", false},
        };
        artifact["status"] = "complete-awaiting-counter-read";
        artifact["contract_pass"] = true;
        publish();
        ggml_quantize_free();
        return 0;
    } catch (const std::exception & error) {
        artifact["status"] = "qualified-stopped";
        artifact["contract_pass"] = false;
        artifact["error"] = error.what();
        artifact["stopped_at_utc"] = utc_now();
        publish();
        ggml_quantize_free();
        return 4;
    }
}

} // namespace galactus::c1

int main(int argc, char ** argv) {
    try {
        const galactus::c1::CliOptions options = galactus::c1::parse_cli(argc, argv);
        if (options.phase == galactus::c1::Phase::selfcheck) {
            return galactus::c1::run_selfcheck(options);
        }
        return galactus::c1::run_measure(options);
    } catch (const std::exception & error) {
        std::cerr << "galactus-glm-batch-c1-compute: " << error.what() << '\n';
        return 2;
    }
}
