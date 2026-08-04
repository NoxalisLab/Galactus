#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml.h"
#include "gguf.h"
#include "llama-ext.h"
#include "llama.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

namespace fs = std::filesystem;

constexpr std::string_view RUNG_D1 = "D1_NO_ALLOC_FULL";
constexpr std::string_view RUNG_D2 = "D2_TWIN_SIZING";
constexpr std::uint64_t EXPECTED_FILE_BYTES = 216715360960ULL;
constexpr std::uint64_t EXPECTED_CORE_BYTES = 15322887168ULL;
constexpr std::uint64_t EXPECTED_MTP_BYTES = 3755716608ULL;
constexpr std::uint64_t EXPECTED_ROUTED_BYTES = 197627215872ULL;

struct Options {
    std::string rung;
    fs::path model;
    fs::path model_directory;
};

struct ModelDeleter {
    void operator()(llama_model * model) const {
        llama_model_free(model);
    }
};

struct ContextDeleter {
    void operator()(llama_context * context) const {
        llama_free(context);
    }
};

struct GgufDeleter {
    void operator()(gguf_context * context) const {
        gguf_free(context);
    }
};

struct GgmlDeleter {
    void operator()(ggml_context * context) const {
        ggml_free(context);
    }
};

using ModelPtr = std::unique_ptr<llama_model, ModelDeleter>;
using ContextPtr = std::unique_ptr<llama_context, ContextDeleter>;
using GgufPtr = std::unique_ptr<gguf_context, GgufDeleter>;
using GgmlPtr = std::unique_ptr<ggml_context, GgmlDeleter>;

struct TensorDescriptor {
    std::string name;
    std::string category;
    ggml_type type = GGML_TYPE_F32;
    int n_dims = 0;
    std::array<std::int64_t, GGML_MAX_DIMS> ne{};
    std::uint64_t tensor_bytes = 0;
};

struct CategoryStats {
    std::uint64_t tensor_bytes = 0;
    std::uint64_t tensor_count = 0;
};

std::string json_escape(std::string_view value) {
    std::string result;
    result.reserve(value.size() + 8);
    for (const unsigned char character : value) {
        switch (character) {
            case '\\': result += "\\\\"; break;
            case '"': result += "\\\""; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default:
                if (character < 0x20) {
                    constexpr char HEX[] = "0123456789abcdef";
                    result += "\\u00";
                    result += HEX[(character >> 4) & 0x0f];
                    result += HEX[character & 0x0f];
                } else {
                    result += static_cast<char>(character);
                }
        }
    }
    return result;
}

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string_view argument = argv[index];
        if (argument == "--rung" && index + 1 < argc) {
            options.rung = argv[++index];
        } else if (argument == "--model" && index + 1 < argc) {
            options.model = argv[++index];
        } else if (argument == "--model-directory" && index + 1 < argc) {
            options.model_directory = argv[++index];
        } else {
            throw std::invalid_argument("unknown or incomplete argument: " + std::string(argument));
        }
    }

    if (options.rung == RUNG_D1 && options.model.empty()) {
        throw std::invalid_argument("D1 requires --model");
    }
    if (options.rung == RUNG_D2 && options.model_directory.empty()) {
        throw std::invalid_argument("D2 requires --model-directory");
    }
    if (options.rung != RUNG_D1 && options.rung != RUNG_D2) {
        throw std::invalid_argument("--rung must be D1_NO_ALLOC_FULL or D2_TWIN_SIZING");
    }
    return options;
}

std::string classify_tensor(const std::string & name) {
    int layer = -1;
    if (name.rfind("blk.", 0) == 0) {
        const auto begin = std::string_view(name).substr(4);
        const auto end = begin.find('.');
        const auto layer_text = begin.substr(0, end);
        if (!layer_text.empty() &&
                std::all_of(layer_text.begin(), layer_text.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) {
            layer = std::stoi(std::string(layer_text));
        }
    }

    if (layer == 78) {
        return "mtp_layer78_all";
    }
    if (layer >= 3 && layer <= 77 && name.find(".ffn_") != std::string::npos &&
            name.find("_exps.weight") != std::string::npos) {
        return "main_routed_experts";
    }

    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (lower.find("shexp") != std::string::npos) {
        return "shared_experts";
    }
    if (lower.find("attn") != std::string::npos) {
        return "attention";
    }
    if (name.find("token_embd") != std::string::npos || name.rfind("output", 0) == 0) {
        return "embedding_output";
    }
    if (name.find(".ffn_") != std::string::npos) {
        return "dense_or_router_ffn";
    }
    if (name.find("norm") != std::string::npos) {
        return "norms";
    }
    return "other";
}

bool belongs_to_core(std::string_view category) {
    return category != "main_routed_experts" && category != "mtp_layer78_all";
}

void silent_log_callback(ggml_log_level, const char *, void *) {
}

void print_breakdown(const llama_memory_breakdown & breakdown, int indent) {
    std::cout << "[\n";
    bool first = true;
    for (const auto & [buffer_type, memory] : breakdown) {
        if (!first) {
            std::cout << ",\n";
        }
        first = false;
        std::cout << std::string(indent + 2, ' ') << "{\"buffer_type\":\""
                  << json_escape(ggml_backend_buft_name(buffer_type)) << "\","
                  << "\"model_bytes\":" << memory.model << ','
                  << "\"context_bytes\":" << memory.context << ','
                  << "\"compute_bytes\":" << memory.compute << ','
                  << "\"total_bytes\":" << memory.total() << '}';
    }
    std::cout << '\n' << std::string(indent, ' ') << ']';
}

void run_d1(const Options & options) {
    llama_log_set(silent_log_callback, nullptr);
    llama_backend_init();

    llama_model_params model_parameters = llama_model_default_params();
    model_parameters.no_alloc = true;
    model_parameters.load_mode = LLAMA_LOAD_MODE_NONE;
    model_parameters.n_gpu_layers = -1;
    model_parameters.check_tensors = false;

    ModelPtr model(llama_model_load_from_file(options.model.c_str(), model_parameters));
    if (!model) {
        throw std::runtime_error("llama_model_load_from_file failed in no_alloc mode");
    }

    std::cout << "{\n"
              << "  \"schema\":\"galactus.h4-memory-probe.d1.v1\",\n"
              << "  \"rung\":\"D1_NO_ALLOC_FULL\",\n"
              << "  \"valid\":true,\n"
              << "  \"real_allocation\":false,\n"
              << "  \"tensor_payload_read\":false,\n"
              << "  \"model_path\":\"" << json_escape(options.model.string()) << "\",\n"
              << "  \"model_params\":{\"no_alloc\":true,\"load_mode\":\"none\",\"n_gpu_layers\":-1},\n"
              << "  \"contexts\":[\n";

    const std::array<std::uint32_t, 2> contexts = {4096, 32768};
    for (std::size_t index = 0; index < contexts.size(); ++index) {
        llama_context_params context_parameters = llama_context_default_params();
        context_parameters.n_ctx = contexts[index];
        context_parameters.n_seq_max = 1;

        ContextPtr context(llama_init_from_model(model.get(), context_parameters));
        if (!context) {
            throw std::runtime_error("llama_init_from_model failed for context " + std::to_string(contexts[index]));
        }
        const auto breakdown = llama_get_memory_breakdown(context.get());

        if (index != 0) {
            std::cout << ",\n";
        }
        std::cout << "    {\"n_ctx\":" << contexts[index]
                  << ",\"n_batch\":" << context_parameters.n_batch
                  << ",\"n_ubatch\":" << context_parameters.n_ubatch
                  << ",\"n_seq_max\":" << context_parameters.n_seq_max
                  << ",\"type_k\":\"" << json_escape(ggml_type_name(context_parameters.type_k))
                  << "\",\"type_v\":\"" << json_escape(ggml_type_name(context_parameters.type_v))
                  << "\",\"flash_attn_type\":" << static_cast<int>(context_parameters.flash_attn_type)
                  << ",\"memory_breakdown\":";
        print_breakdown(breakdown, 4);
        std::cout << '}';
    }
    std::cout << "\n  ]\n}\n";

    model.reset();
    llama_backend_free();
}

std::vector<fs::path> model_shards(const fs::path & directory) {
    std::vector<fs::path> shards;
    for (const auto & entry : fs::directory_iterator(directory)) {
        if (entry.is_regular_file() && entry.path().extension() == ".gguf") {
            shards.push_back(entry.path());
        }
    }
    std::sort(shards.begin(), shards.end());
    if (shards.size() != 6) {
        throw std::runtime_error("expected exactly six GGUF shards");
    }
    return shards;
}

std::vector<TensorDescriptor> read_descriptors(const std::vector<fs::path> & shards,
        std::uint64_t & file_bytes) {
    std::vector<TensorDescriptor> descriptors;
    file_bytes = 0;
    for (const auto & shard : shards) {
        file_bytes += fs::file_size(shard);
        ggml_context * raw_tensor_context = nullptr;
        gguf_init_params parameters{};
        parameters.no_alloc = true;
        parameters.ctx = &raw_tensor_context;
        GgufPtr gguf(gguf_init_from_file(shard.c_str(), parameters));
        GgmlPtr tensor_context(raw_tensor_context);
        if (!gguf || !tensor_context) {
            throw std::runtime_error("failed to read GGUF metadata: " + shard.string());
        }
        for (ggml_tensor * tensor = ggml_get_first_tensor(tensor_context.get()); tensor != nullptr;
                tensor = ggml_get_next_tensor(tensor_context.get(), tensor)) {
            TensorDescriptor descriptor;
            descriptor.name = tensor->name;
            descriptor.category = classify_tensor(descriptor.name);
            descriptor.type = tensor->type;
            descriptor.n_dims = ggml_n_dims(tensor);
            std::copy_n(tensor->ne, GGML_MAX_DIMS, descriptor.ne.begin());
            descriptor.tensor_bytes = ggml_nbytes(tensor);
            descriptors.push_back(std::move(descriptor));
        }
    }
    return descriptors;
}

template <typename Predicate>
std::size_t simulated_allocation_size(const std::vector<TensorDescriptor> & descriptors,
        ggml_backend_buffer_type_t buffer_type, Predicate include) {
    const std::size_t selected = static_cast<std::size_t>(std::count_if(
        descriptors.begin(), descriptors.end(), include));
    const std::size_t metadata_bytes = std::max<std::size_t>(
        4 * 1024 * 1024, (selected + 64) * (ggml_tensor_overhead() + 128));
    ggml_init_params parameters{};
    parameters.mem_size = metadata_bytes;
    parameters.mem_buffer = nullptr;
    parameters.no_alloc = true;
    GgmlPtr context(ggml_init(parameters));
    if (!context) {
        throw std::runtime_error("ggml_init failed for categorized sizing context");
    }

    for (const auto & descriptor : descriptors) {
        if (!include(descriptor)) {
            continue;
        }
        ggml_tensor * tensor = ggml_new_tensor(
            context.get(), descriptor.type, descriptor.n_dims, descriptor.ne.data());
        ggml_set_name(tensor, descriptor.name.c_str());
    }
    return ggml_backend_alloc_ctx_tensors_from_buft_size(context.get(), buffer_type);
}

void run_d2(const Options & options) {
    llama_log_set(silent_log_callback, nullptr);
    ggml_backend_load_all();
    ggml_backend_dev_t device = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
    if (!device) {
        throw std::runtime_error("no GPU device available for Metal buffer sizing");
    }
    ggml_backend_buffer_type_t buffer_type = ggml_backend_dev_buffer_type(device);
    if (!buffer_type) {
        throw std::runtime_error("GPU device did not expose a default buffer type");
    }

    const auto shards = model_shards(options.model_directory);
    std::uint64_t file_bytes = 0;
    const auto descriptors = read_descriptors(shards, file_bytes);

    std::map<std::string, CategoryStats> categories;
    std::uint64_t tensor_bytes = 0;
    for (const auto & descriptor : descriptors) {
        auto & category = categories[descriptor.category];
        category.tensor_bytes += descriptor.tensor_bytes;
        category.tensor_count += 1;
        tensor_bytes += descriptor.tensor_bytes;
    }

    const auto category_bytes = [&](const std::string & name) -> std::uint64_t {
        const auto found = categories.find(name);
        return found == categories.end() ? 0 : found->second.tensor_bytes;
    };
    std::uint64_t core_bytes = 0;
    for (const auto & [name, stats] : categories) {
        if (belongs_to_core(name)) {
            core_bytes += stats.tensor_bytes;
        }
    }
    const std::uint64_t mtp_bytes = category_bytes("mtp_layer78_all");
    const std::uint64_t routed_bytes = category_bytes("main_routed_experts");
    const std::uint64_t metadata_padding_bytes = file_bytes - tensor_bytes;

    if (file_bytes != EXPECTED_FILE_BYTES || core_bytes != EXPECTED_CORE_BYTES ||
            mtp_bytes != EXPECTED_MTP_BYTES || routed_bytes != EXPECTED_ROUTED_BYTES) {
        throw std::runtime_error("profile byte invariant failed");
    }

    const auto all = [](const TensorDescriptor &) { return true; };
    const auto core = [](const TensorDescriptor & descriptor) { return belongs_to_core(descriptor.category); };
    const auto mtp = [](const TensorDescriptor & descriptor) { return descriptor.category == "mtp_layer78_all"; };
    const auto core_with_mtp = [](const TensorDescriptor & descriptor) {
        return descriptor.category != "main_routed_experts";
    };
    const auto routed = [](const TensorDescriptor & descriptor) {
        return descriptor.category == "main_routed_experts";
    };

    const std::size_t all_alloc = simulated_allocation_size(descriptors, buffer_type, all);
    const std::size_t core_alloc = simulated_allocation_size(descriptors, buffer_type, core);
    const std::size_t mtp_alloc = simulated_allocation_size(descriptors, buffer_type, mtp);
    const std::size_t core_mtp_alloc = simulated_allocation_size(descriptors, buffer_type, core_with_mtp);
    const std::size_t routed_alloc = simulated_allocation_size(descriptors, buffer_type, routed);

    std::cout << "{\n"
              << "  \"schema\":\"galactus.h4-memory-probe.d2.v1\",\n"
              << "  \"rung\":\"D2_TWIN_SIZING\",\n"
              << "  \"valid\":true,\n"
              << "  \"real_allocation\":false,\n"
              << "  \"real_tensor_allocation\":false,\n"
              << "  \"backend_device_initialized_for_sizing\":true,\n"
              << "  \"tensor_payload_read\":false,\n"
              << "  \"model_directory\":\"" << json_escape(options.model_directory.string()) << "\",\n"
              << "  \"buffer_type\":\"" << json_escape(ggml_backend_buft_name(buffer_type)) << "\",\n"
              << "  \"buffer_alignment_bytes\":" << ggml_backend_buft_get_alignment(buffer_type) << ",\n"
              << "  \"shards\":" << shards.size() << ",\n"
              << "  \"tensor_count\":" << descriptors.size() << ",\n"
              << "  \"file_bytes\":" << file_bytes << ",\n"
              << "  \"tensor_bytes\":" << tensor_bytes << ",\n"
              << "  \"metadata_and_padding_bytes\":" << metadata_padding_bytes << ",\n"
              << "  \"categories\":{\n";
    bool first = true;
    for (const auto & [name, stats] : categories) {
        if (!first) {
            std::cout << ",\n";
        }
        first = false;
        std::cout << "    \"" << json_escape(name) << "\":{\"tensor_count\":" << stats.tensor_count
                  << ",\"tensor_bytes\":" << stats.tensor_bytes << '}';
    }
    std::cout << "\n  },\n"
              << "  \"profiles\":{\n"
              << "    \"H4_CORE_NO_MTP\":{\"tensor_bytes\":" << core_bytes
              << ",\"simulated_backend_allocation_bytes\":" << core_alloc << "},\n"
              << "    \"H4_MTP_DELTA\":{\"tensor_bytes\":" << mtp_bytes
              << ",\"simulated_backend_allocation_bytes\":" << mtp_alloc << "},\n"
              << "    \"H4_CORE_WITH_MTP\":{\"tensor_bytes\":" << core_bytes + mtp_bytes
              << ",\"simulated_backend_allocation_bytes\":" << core_mtp_alloc << "},\n"
              << "    \"H4_ROUTED_MAIN\":{\"tensor_bytes\":" << routed_bytes
              << ",\"simulated_backend_allocation_bytes\":" << routed_alloc << "},\n"
              << "    \"H4_ALL_TENSORS\":{\"tensor_bytes\":" << tensor_bytes
              << ",\"simulated_backend_allocation_bytes\":" << all_alloc << "}\n"
              << "  },\n"
              << "  \"invariants\":{\n"
              << "    \"file_sum_exact\":" << ((tensor_bytes + metadata_padding_bytes == file_bytes) ? "true" : "false") << ",\n"
              << "    \"profile_partition_exact\":"
              << ((core_bytes + mtp_bytes + routed_bytes == tensor_bytes) ? "true" : "false") << "\n"
              << "  }\n"
              << "}\n";
}

} // namespace

int main(int argc, char ** argv) {
    try {
        const auto options = parse_options(argc, argv);
        if (options.rung == RUNG_D1) {
            run_d1(options);
        } else {
            run_d2(options);
        }
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}
