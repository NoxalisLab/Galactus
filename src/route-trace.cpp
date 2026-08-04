#include "ggml-backend.h"
#include "ggml.h"
#include "llama-context.h"
#include "llama-graph.h"
#include "llama-model.h"
#include "llama.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <clocale>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct options {
    std::string model_path;
    std::string trace_path;
    std::string prompt = "The capital of France is";
    std::string prompt_file;
    std::string prompt_id;
    int prompt_token_target = 0;
    int n_predict = 128;
    int n_gpu_layers = 999;
    int n_ctx = 0;
    int prefill_chunk_size = 0;
    uint32_t seed = 0;
    float temperature = 1.0f;
    float top_p = 0.95f;
    int32_t expert_count = 0;
    bool sequential_prefill = false;
    bool repack = true;
    bool prompt_explicit = false;
    bool sampling = false;
};

struct trace_record {
    std::string phase;
    int64_t step;
    int32_t layer;
    int64_t token_offset;
    std::vector<int32_t> experts;
    std::vector<float> weights;
};

[[noreturn]] void usage(const char * program, const std::string & error = {}) {
    if (!error.empty()) {
        std::cerr << "error: " << error << "\n\n";
    }
    std::cerr
        << "usage: " << program << " --model MODEL.gguf [options]\n"
        << "\n"
        << "options:\n"
        << "  --trace FILE.jsonl    enable deferred MoE route capture\n"
        << "  --prompt TEXT         prompt text\n"
        << "  --prompt-file FILE    read the natural prompt from FILE\n"
        << "  --prompt-id ID        stable corpus document identifier\n"
        << "  --prompt-tokens N     repeat/truncate prompt to exactly N tokens\n"
        << "  --prefill-chunk N     evaluate prompt in chunks of at most N tokens\n"
        << "  --seed N              enable deterministic top-p sampling with seed N\n"
        << "  --temperature F       sampling temperature (default: 1.0)\n"
        << "  --top-p F             nucleus sampling threshold (default: 0.95)\n"
        << "  --sequential-prefill  teacher-force prompt one token per decode\n"
        << "  --no-repack           disable CPU weight repacking to reduce peak RAM\n"
        << "  --n-predict N         evaluated generation tokens (default: 128)\n"
        << "  --n-gpu-layers N      GPU layers (default: 999)\n"
        << "  --ctx-size N          context size (default: auto)\n";
    std::exit(error.empty() ? 0 : 2);
}

int parse_int(const char * value, const char * option) {
    try {
        size_t parsed = 0;
        const int result = std::stoi(value, &parsed);
        if (parsed != std::strlen(value)) {
            throw std::invalid_argument("trailing data");
        }
        return result;
    } catch (...) {
        usage("galactus-route-trace", std::string("invalid value for ") + option);
    }
}

uint32_t parse_uint32(const char * value, const char * option) {
    try {
        size_t parsed = 0;
        const unsigned long result = std::stoul(value, &parsed);
        if (parsed != std::strlen(value) || result > UINT32_MAX) {
            throw std::invalid_argument("out of range");
        }
        return static_cast<uint32_t>(result);
    } catch (...) {
        usage("galactus-route-trace", std::string("invalid value for ") + option);
    }
}

float parse_float(const char * value, const char * option) {
    try {
        size_t parsed = 0;
        const float result = std::stof(value, &parsed);
        if (parsed != std::strlen(value)) {
            throw std::invalid_argument("trailing data");
        }
        return result;
    } catch (...) {
        usage("galactus-route-trace", std::string("invalid value for ") + option);
    }
}

options parse_options(int argc, char ** argv) {
    options result;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        const auto next = [&]() -> const char * {
            if (++i >= argc) {
                usage(argv[0], "missing value for " + arg);
            }
            return argv[i];
        };

        if (arg == "--model" || arg == "-m") {
            result.model_path = next();
        } else if (arg == "--trace") {
            result.trace_path = next();
        } else if (arg == "--prompt" || arg == "-p") {
            result.prompt = next();
            result.prompt_explicit = true;
        } else if (arg == "--prompt-file") {
            result.prompt_file = next();
        } else if (arg == "--prompt-id") {
            result.prompt_id = next();
        } else if (arg == "--prompt-tokens") {
            result.prompt_token_target = parse_int(next(), arg.c_str());
        } else if (arg == "--prefill-chunk") {
            result.prefill_chunk_size = parse_int(next(), arg.c_str());
        } else if (arg == "--seed") {
            result.seed = parse_uint32(next(), arg.c_str());
            result.sampling = true;
        } else if (arg == "--temperature") {
            result.temperature = parse_float(next(), arg.c_str());
        } else if (arg == "--top-p") {
            result.top_p = parse_float(next(), arg.c_str());
        } else if (arg == "--sequential-prefill") {
            result.sequential_prefill = true;
        } else if (arg == "--no-repack") {
            result.repack = false;
        } else if (arg == "--n-predict" || arg == "-n") {
            result.n_predict = parse_int(next(), arg.c_str());
        } else if (arg == "--n-gpu-layers" || arg == "-ngl") {
            result.n_gpu_layers = parse_int(next(), arg.c_str());
        } else if (arg == "--ctx-size" || arg == "-c") {
            result.n_ctx = parse_int(next(), arg.c_str());
        } else if (arg == "--help" || arg == "-h") {
            usage(argv[0]);
        } else {
            usage(argv[0], "unknown option: " + arg);
        }
    }

    if (result.model_path.empty()) {
        usage(argv[0], "--model is required");
    }
    if (result.n_predict <= 0) {
        usage(argv[0], "--n-predict must be positive");
    }
    if (result.prompt_token_target < 0) {
        usage(argv[0], "--prompt-tokens must be positive");
    }
    if (result.prefill_chunk_size < 0) {
        usage(argv[0], "--prefill-chunk must be positive");
    }
    if (result.sequential_prefill && result.prefill_chunk_size > 0) {
        usage(argv[0], "--sequential-prefill and --prefill-chunk are mutually exclusive");
    }
    if (!(result.temperature > 0.0f)) {
        usage(argv[0], "--temperature must be positive");
    }
    if (!(result.top_p > 0.0f && result.top_p <= 1.0f)) {
        usage(argv[0], "--top-p must be in (0, 1]");
    }
    if (result.prompt_explicit && !result.prompt_file.empty()) {
        usage(argv[0], "--prompt and --prompt-file are mutually exclusive");
    }
    return result;
}

std::string read_prompt_file(const std::string & path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("cannot open prompt file: " + path);
    }
    std::ostringstream contents;
    contents << input.rdbuf();
    if (!input.good() && !input.eof()) {
        throw std::runtime_error("cannot read prompt file: " + path);
    }
    if (contents.str().empty()) {
        throw std::runtime_error("prompt file is empty: " + path);
    }
    return contents.str();
}

std::string json_escape(const std::string & value) {
    std::ostringstream out;
    for (const unsigned char ch : value) {
        switch (ch) {
            case '\"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (ch < 0x20) {
                    out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << int(ch);
                } else {
                    out << ch;
                }
        }
    }
    return out.str();
}

std::string make_run_id() {
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return std::to_string(std::chrono::duration_cast<std::chrono::microseconds>(now).count());
}

void collect_routes(
        llama_context * ctx,
        const std::string & phase,
        int64_t step,
        int64_t token_offset,
        int32_t expert_count,
        std::vector<trace_record> & records) {
    ctx->synchronize();

    const auto & routes = ctx->get_gf_res_prev()->get_moe_routes();
    ggml_tensor * tensor = ctx->get_gf_res_prev()->get_moe_route_trace();
    if (routes.empty() || tensor == nullptr) {
        return;
    }
    if (tensor->type != GGML_TYPE_F16) {
        throw std::runtime_error("aggregated MoE route tensor is not F16");
    }

    const int64_t n_layers = static_cast<int64_t>(routes.size());
    const int64_t n_experts_used = routes.front().experts->ne[0];
    const int64_t n_tokens = routes.front().experts->ne[1];
    if (tensor->ne[0] != 2*n_experts_used || tensor->ne[1] != n_tokens || tensor->ne[2] != n_layers) {
        throw std::runtime_error("aggregated MoE route tensor has an invalid shape");
    }

    std::vector<ggml_fp16_t> values(static_cast<size_t>(ggml_nelements(tensor)));
    ggml_backend_tensor_get(tensor, values.data(), 0, values.size() * sizeof(ggml_fp16_t));

    for (int64_t layer = 0; layer < n_layers; ++layer) {
        for (int64_t token = 0; token < n_tokens; ++token) {
            const size_t base = static_cast<size_t>((layer*n_tokens + token) * 2*n_experts_used);
            trace_record record;
            record.phase = phase;
            record.step = step;
            record.layer = routes[static_cast<size_t>(layer)].il;
            record.token_offset = token_offset + token;
            record.experts.reserve(static_cast<size_t>(n_experts_used));
            record.weights.reserve(static_cast<size_t>(n_experts_used));
            for (int64_t expert = 0; expert < n_experts_used; ++expert) {
                const float raw_expert_id = ggml_fp16_to_fp32(
                    values[base + static_cast<size_t>(expert)]);
                const float weight = ggml_fp16_to_fp32(
                    values[base + static_cast<size_t>(n_experts_used + expert)]);
                if (!std::isfinite(raw_expert_id) || raw_expert_id < 0.0f ||
                    raw_expert_id >= expert_count || std::trunc(raw_expert_id) != raw_expert_id) {
                    std::ostringstream error;
                    error << "invalid MoE expert ID at phase=" << phase
                          << " layer=" << record.layer
                          << " token_offset=" << record.token_offset
                          << " slot=" << expert
                          << "; expected integer in [0," << expert_count - 1 << ']';
                    throw std::runtime_error(error.str());
                }
                if (!std::isfinite(weight)) {
                    std::ostringstream error;
                    error << "non-finite MoE route weight at phase=" << phase
                          << " layer=" << record.layer
                          << " token_offset=" << record.token_offset
                          << " slot=" << expert;
                    throw std::runtime_error(error.str());
                }
                record.experts.push_back(static_cast<int32_t>(raw_expert_id));
                record.weights.push_back(weight);
            }
            records.push_back(std::move(record));
        }
    }
}

void write_trace(
        const std::string & path,
        const std::string & run_id,
        const options & opts,
        int64_t prompt_tokens,
        double prompt_seconds,
        const std::vector<llama_token> & generated_tokens,
        const std::vector<trace_record> & records) {
    std::ofstream out(path, std::ios::app);
    if (!out) {
        throw std::runtime_error("cannot open trace file: " + path);
    }

    out << "{\"schema_version\":2,\"type\":\"run\",\"run_id\":\"" << run_id
        << "\",\"model\":\"" << json_escape(opts.model_path)
        << "\",\"prompt_id\":\"" << json_escape(opts.prompt_id)
        << "\",\"prompt_tokens\":" << prompt_tokens
        << ",\"prefill_chunk_size\":" << opts.prefill_chunk_size
        << ",\"prompt_seconds\":" << prompt_seconds
        << ",\"prompt_tokens_per_second\":" << prompt_tokens / prompt_seconds
        << ",\"evaluated_generation_tokens\":" << opts.n_predict
        << ",\"sampling\":\"" << (opts.sampling ? "top_p" : "greedy") << "\""
        << ",\"seed\":" << opts.seed
        << ",\"temperature\":" << opts.temperature
        << ",\"top_p\":" << opts.top_p
        << ",\"expert_count\":" << opts.expert_count
        << ",\"route_ids_valid\":true"
        << ",\"generated_tokens\":[";
    for (size_t i = 0; i < generated_tokens.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << generated_tokens[i];
    }
    out << ']'
        << ",\"trace_layout\":\"f16[2*top_k,tokens,moe_layers]\"}\n";

    for (const auto & record : records) {
        out << "{\"schema_version\":2,\"type\":\"route\",\"run_id\":\"" << run_id
            << "\",\"phase\":\"" << record.phase
            << "\",\"step\":" << record.step
            << ",\"layer\":" << record.layer
            << ",\"token_offset\":" << record.token_offset
            << ",\"experts\":[";
        for (size_t i = 0; i < record.experts.size(); ++i) {
            if (i != 0) {
                out << ',';
            }
            out << record.experts[i];
        }
        out << "],\"weights\":[";
        for (size_t i = 0; i < record.weights.size(); ++i) {
            if (i != 0) {
                out << ',';
            }
            out << record.weights[i];
        }
        out << "]}\n";
    }
}

} // namespace

int main(int argc, char ** argv) {
    const auto process_started = std::chrono::steady_clock::now();
    std::setlocale(LC_NUMERIC, "C");
    options opts = parse_options(argc, argv);
    if (!opts.prompt_file.empty()) {
        try {
            opts.prompt = read_prompt_file(opts.prompt_file);
        } catch (const std::exception & error) {
            std::cerr << "error: " << error.what() << '\n';
            return 1;
        }
    }
    const bool trace_enabled = !opts.trace_path.empty();
    if (trace_enabled && setenv("LLAMA_MOE_ROUTE_TRACE", "1", 1) != 0) {
        std::cerr << "error: cannot enable route tracing\n";
        return 1;
    }

    ggml_backend_load_all();

    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = opts.n_gpu_layers;
    model_params.use_extra_bufts = opts.repack;
    llama_model * model = llama_model_load_from_file(opts.model_path.c_str(), model_params);
    if (model == nullptr) {
        std::cerr << "error: cannot load model\n";
        return 1;
    }
    opts.expert_count = static_cast<int32_t>(model->hparams.n_expert);
    if (trace_enabled && opts.expert_count <= 0) {
        std::cerr << "error: route tracing requires a model with routed experts\n";
        llama_model_free(model);
        return 1;
    }
    const auto model_loaded = std::chrono::steady_clock::now();

    const llama_vocab * vocab = llama_model_get_vocab(model);
    int n_prompt = -llama_tokenize(vocab, opts.prompt.c_str(), opts.prompt.size(), nullptr, 0, true, true);
    if (n_prompt <= 0) {
        std::cerr << "error: cannot determine prompt token count\n";
        llama_model_free(model);
        return 1;
    }

    std::vector<llama_token> prompt_tokens(static_cast<size_t>(n_prompt));
    if (llama_tokenize(vocab, opts.prompt.c_str(), opts.prompt.size(), prompt_tokens.data(), prompt_tokens.size(), true, true) < 0) {
        std::cerr << "error: cannot tokenize prompt\n";
        llama_model_free(model);
        return 1;
    }

    if (opts.prompt_token_target > 0 && opts.prompt_token_target != n_prompt) {
        if (opts.prompt_token_target < n_prompt) {
            prompt_tokens.resize(static_cast<size_t>(opts.prompt_token_target));
        } else {
            const std::vector<llama_token> seed_tokens = prompt_tokens;
            const size_t repeat_from = seed_tokens.size() > 1 ? 1 : 0;
            while (prompt_tokens.size() < static_cast<size_t>(opts.prompt_token_target)) {
                const size_t source = repeat_from +
                    (prompt_tokens.size() - seed_tokens.size()) % (seed_tokens.size() - repeat_from);
                prompt_tokens.push_back(seed_tokens[source]);
            }
        }
        n_prompt = opts.prompt_token_target;
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = opts.n_ctx > 0 ? opts.n_ctx : std::max(512, n_prompt + opts.n_predict + 8);
    const int prompt_batch_size = opts.prefill_chunk_size > 0
        ? std::min(n_prompt, opts.prefill_chunk_size)
        : n_prompt;
    ctx_params.n_batch = std::max(512, prompt_batch_size);
    ctx_params.n_ubatch = ctx_params.n_batch;
    ctx_params.no_perf = false;

    llama_context * ctx = llama_init_from_model(model, ctx_params);
    if (ctx == nullptr) {
        std::cerr << "error: cannot create context\n";
        llama_model_free(model);
        return 1;
    }
    const auto context_ready = std::chrono::steady_clock::now();

    llama_sampler * sampler = nullptr;
    if (opts.sampling) {
        sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
        llama_sampler_chain_add(sampler, llama_sampler_init_top_p(opts.top_p, 1));
        llama_sampler_chain_add(sampler, llama_sampler_init_temp(opts.temperature));
        llama_sampler_chain_add(sampler, llama_sampler_init_dist(opts.seed));
    } else {
        sampler = llama_sampler_init_greedy();
    }
    std::vector<trace_record> records;
    records.reserve(static_cast<size_t>(opts.n_predict + n_prompt) * 128);

    const auto capture_routes = [&records, ctx, &opts](
            const std::string & phase,
            int64_t step,
            int64_t token_offset) -> bool {
        try {
            collect_routes(ctx, phase, step, token_offset, opts.expert_count, records);
            return true;
        } catch (const std::exception & error) {
            std::cerr << "error: route capture rejected invalid data: "
                      << error.what() << '\n';
            return false;
        }
    };

    llama_batch prompt_batch = {};
    bool prompt_batch_allocated = false;
    const auto prompt_started = std::chrono::steady_clock::now();
    if (opts.sequential_prefill) {
        for (int i = 0; i < n_prompt; ++i) {
            llama_token prompt_token = prompt_tokens[static_cast<size_t>(i)];
            const llama_batch token_batch = llama_batch_get_one(&prompt_token, 1);
            if (llama_decode(ctx, token_batch) != 0) {
                std::cerr << "error: sequential prompt decode failed at token " << i << "\n";
                llama_sampler_free(sampler);
                llama_free(ctx);
                llama_model_free(model);
                return 1;
            }
            if (trace_enabled) {
                if (!capture_routes("prompt", -1, i)) {
                    llama_sampler_free(sampler);
                    llama_free(ctx);
                    llama_model_free(model);
                    return 1;
                }
            }
        }
    } else {
        const int chunk_size = opts.prefill_chunk_size > 0 ? opts.prefill_chunk_size : n_prompt;
        for (int offset = 0; offset < n_prompt; offset += chunk_size) {
            const int count = std::min(chunk_size, n_prompt - offset);
            prompt_batch = llama_batch_init(count, 0, 1);
            prompt_batch_allocated = true;
            prompt_batch.n_tokens = count;
            for (int i = 0; i < count; ++i) {
                prompt_batch.token[i] = prompt_tokens[static_cast<size_t>(offset + i)];
                prompt_batch.pos[i] = offset + i;
                prompt_batch.n_seq_id[i] = 1;
                prompt_batch.seq_id[i][0] = 0;
                prompt_batch.logits[i] = trace_enabled ? 1 : (offset + i == n_prompt - 1);
            }

            if (llama_decode(ctx, prompt_batch) != 0) {
                std::cerr << "error: prompt decode failed at token " << offset << "\n";
                llama_batch_free(prompt_batch);
                llama_sampler_free(sampler);
                llama_free(ctx);
                llama_model_free(model);
                return 1;
            }
            if (trace_enabled) {
                if (!capture_routes("prompt", -1, offset)) {
                    llama_batch_free(prompt_batch);
                    llama_sampler_free(sampler);
                    llama_free(ctx);
                    llama_model_free(model);
                    return 1;
                }
            }
            llama_batch_free(prompt_batch);
            prompt_batch_allocated = false;
        }
    }
    const auto prompt_stopped = std::chrono::steady_clock::now();
    const double prompt_seconds = std::chrono::duration<double>(prompt_stopped - prompt_started).count();

    llama_token token = llama_sampler_sample(sampler, ctx, -1);
    if (prompt_batch_allocated) {
        llama_batch_free(prompt_batch);
    }
    const auto started = std::chrono::steady_clock::now();
    std::vector<llama_token> generated_tokens;
    generated_tokens.reserve(static_cast<size_t>(opts.n_predict));

    for (int step = 0; step < opts.n_predict; ++step) {
        generated_tokens.push_back(token);
        const llama_batch batch = llama_batch_get_one(&token, 1);
        if (llama_decode(ctx, batch) != 0) {
            std::cerr << "error: generation decode failed at step " << step << "\n";
            llama_sampler_free(sampler);
            llama_free(ctx);
            llama_model_free(model);
            return 1;
        }
        if (trace_enabled) {
            if (!capture_routes("generation", step, n_prompt + step)) {
                llama_sampler_free(sampler);
                llama_free(ctx);
                llama_model_free(model);
                return 1;
            }
        }
        token = llama_sampler_sample(sampler, ctx, -1);
    }

    ctx->synchronize();
    const auto stopped = std::chrono::steady_clock::now();
    const double seconds = std::chrono::duration<double>(stopped - started).count();
    const double tokens_per_second = opts.n_predict / seconds;
    const std::string run_id = make_run_id();

    if (trace_enabled) {
        try {
            write_trace(opts.trace_path, run_id, opts, n_prompt, prompt_seconds, generated_tokens, records);
        } catch (const std::exception & error) {
            std::cerr << "error: " << error.what() << '\n';
            llama_sampler_free(sampler);
            llama_free(ctx);
            llama_model_free(model);
            return 1;
        }
    }

    std::cout << std::fixed << std::setprecision(3)
        << "{\"schema_version\":1,\"run_id\":\"" << run_id
        << "\",\"trace_enabled\":" << (trace_enabled ? "true" : "false")
        << ",\"prompt_id\":\"" << json_escape(opts.prompt_id) << "\""
        << ",\"prompt_tokens\":" << n_prompt
        << ",\"prefill_chunk_size\":" << opts.prefill_chunk_size
        << ",\"sampling\":\"" << (opts.sampling ? "top_p" : "greedy") << "\""
        << ",\"seed\":" << opts.seed
        << ",\"temperature\":" << opts.temperature
        << ",\"top_p\":" << opts.top_p
        << ",\"expert_count\":" << opts.expert_count
        << ",\"route_ids_valid\":true"
        << ",\"model_load_seconds\":"
        << std::chrono::duration<double>(model_loaded - process_started).count()
        << ",\"context_init_seconds\":"
        << std::chrono::duration<double>(context_ready - model_loaded).count()
        << ",\"prompt_seconds\":" << prompt_seconds
        << ",\"prompt_tokens_per_second\":" << n_prompt / prompt_seconds
        << ",\"evaluated_generation_tokens\":" << opts.n_predict
        << ",\"seconds\":" << seconds
        << ",\"tokens_per_second\":" << tokens_per_second
        << ",\"route_records\":" << records.size() << "}\n";

    llama_sampler_free(sampler);
    llama_free(ctx);
    llama_model_free(model);
    return 0;
}
