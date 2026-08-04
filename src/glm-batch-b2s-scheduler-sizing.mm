// Reuse the frozen synthetic GLM graph topology without modifying the consumed
// B2R source. The legacy entry point is renamed and never called by B2S.
#define main galactus_consumed_b2r_entrypoint_do_not_call
#include "glm-batch-compute-probe.mm"
#undef main

#include <set>

namespace b2s {

constexpr int REPEAT_COUNT = 3;

struct CliOptions {
    std::string output;
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
    size_t metal_nodes = 0;
    size_t cpu_nodes = 0;
    size_t unassigned_nodes = 0;
    size_t metal_non_view_compute_nodes = 0;
    size_t cpu_non_view_compute_nodes = 0;
};

struct CaseMeasurement {
    int k = 0;
    int graph_nodes = 0;
    size_t graph_capacity = 0;
    size_t metal_reserve_bytes = 0;
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
    uint64_t after_graph_build = 0;
    uint64_t after_scheduler_new = 0;
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

CliOptions parse_cli(int argc, char ** argv) {
    CliOptions options;
    for (int index = 1; index < argc; ++index) {
        const std::string argument = argv[index];
        if (argument == "--output" && index + 1 < argc) {
            options.output = argv[++index];
        } else {
            throw std::runtime_error("usage: --output PATH");
        }
    }
    if (options.output.empty()) {
        throw std::runtime_error("--output is required");
    }
    return options;
}

struct WeightFixture {
    ggml_context_ptr context;
    std::vector<InitializedTensor> tensors;
    std::vector<ExpertBundle> experts_a;
    std::vector<ExpertBundle> experts_b;
    std::vector<ExpertBundle> experts_c;
    std::vector<SharedBundle> shared;
    std::vector<AttentionBundle> attention;
    size_t future_real_buffer_bytes = 0;
    uint64_t after_weight_sizing_capture = 0;
    uint64_t after_dummy_attachment_capture = 0;
    ggml_backend_buffer_ptr dummy;

    WeightFixture(ggml_backend_buffer_type_t metal_buft, id<MTLDevice> metal_device) {
        ggml_init_params parameters{};
        parameters.mem_size = CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        context.reset(ggml_init(parameters));
        if (!context) {
            throw std::runtime_error("weight ggml_init failed");
        }
        for (int pool = 0; pool < POOL_SIZE; ++pool) {
            experts_a.push_back(new_expert_bundle(
                context.get(), CLASS_A, tensors, 1000 + pool * 10));
            experts_b.push_back(new_expert_bundle(
                context.get(), CLASS_B, tensors, 2000 + pool * 10));
            experts_c.push_back(new_expert_bundle(
                context.get(), CLASS_C, tensors, 3000 + pool * 10));
            shared.push_back(new_shared_bundle(
                context.get(), tensors, 4000 + pool * 10));
            attention.push_back(new_attention_bundle(
                context.get(), tensors, 5000 + pool * 10));
        }

        // This ordering is a contractual precondition: attaching the dummy first
        // would make the sizing API skip every weight and silently return zero.
        future_real_buffer_bytes =
            ggml_backend_alloc_ctx_tensors_from_buft_size(context.get(), metal_buft);
        if (future_real_buffer_bytes == 0 || tensors.empty()) {
            throw std::runtime_error("weight sizing returned zero before dummy attachment");
        }
        after_weight_sizing_capture = current_allocated_bytes(metal_device);

        dummy.reset(ggml_backend_buft_alloc_buffer(metal_buft, 0));
        if (!dummy || ggml_backend_buffer_get_size(dummy.get()) != 0 ||
            ggml_backend_buffer_get_type(dummy.get()) != metal_buft) {
            throw std::runtime_error("zero-sized Metal dummy precondition failed");
        }
        ggml_backend_buffer_set_usage(
            dummy.get(), GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        if (ggml_backend_buffer_get_usage(dummy.get()) !=
                GGML_BACKEND_BUFFER_USAGE_WEIGHTS) {
            throw std::runtime_error("dummy usage is not WEIGHTS");
        }
        for (const auto & item : tensors) {
            if (item.tensor->buffer != nullptr || item.tensor->data != nullptr) {
                throw std::runtime_error("weight unexpectedly allocated before dummy attachment");
            }
            item.tensor->buffer = dummy.get();
        }
        for (const auto & item : tensors) {
            if (item.tensor->buffer != dummy.get()) {
                throw std::runtime_error("not every weight points to the dummy");
            }
        }
        after_dummy_attachment_capture = current_allocated_bytes(metal_device);
    }
};

struct GraphFixture {
    ggml_context_ptr context;
    std::vector<GraphCase> cases;

    explicit GraphFixture(const WeightFixture & weights) {
        ggml_init_params parameters{};
        parameters.mem_size = CONTEXT_BYTES;
        parameters.mem_buffer = nullptr;
        parameters.no_alloc = true;
        context.reset(ggml_init(parameters));
        if (!context) {
            throw std::runtime_error("graph ggml_init failed");
        }

        auto * k_cache = ggml_new_tensor_3d(
            context.get(), GGML_TYPE_F16, MLA_QK, N_CTX, 1);
        for (const int batch_size : B2_BATCH_SIZES) {
            auto * input = ggml_new_tensor_2d(
                context.get(), GGML_TYPE_F32, N_EMBD, batch_size);
            auto * ids = ggml_new_tensor_2d(
                context.get(), GGML_TYPE_I32, N_EXPERT_USED, batch_size);
            ggml_set_input(input);
            ggml_set_input(ids);
            auto * full_root = build_chain(
                context.get(), ChainKind::full, batch_size,
                weights.experts_a, weights.experts_b, weights.experts_c,
                weights.shared, weights.attention, k_cache, ids, input);
            GraphCase item{};
            item.batch_size = batch_size;
            item.input = input;
            item.ids = ids;
            item.full_root = full_root;
            item.full = graph_for(context.get(), full_root);
            cases.push_back(item);
        }

        for (ggml_tensor * tensor = ggml_get_first_tensor(context.get());
             tensor != nullptr; tensor = ggml_get_next_tensor(context.get(), tensor)) {
            if (tensor->buffer != nullptr || tensor->data != nullptr) {
                throw std::runtime_error("graph-context tensor unexpectedly owns storage");
            }
        }
    }
};

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
            throw std::runtime_error("scheduler replaced a source with null");
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
    ggml_backend_t metal,
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
        if (assigned == metal) {
            ++result.metal_nodes;
            if (non_view) {
                ++result.metal_non_view_compute_nodes;
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
        item.placement.metal_non_view_compute_nodes ==
            item.placement.non_view_compute_nodes &&
        item.placement.unassigned_nodes == 0 &&
        item.scheduler_split_count == 1 &&
        item.copies.weight == 0 &&
        item.metal_reserve_bytes > 0;
}

bool captures_equal(const MetalCaptures & value) {
    return value.before_weight_sizing == value.after_weight_sizing &&
        value.after_weight_sizing == value.after_dummy_attachment &&
        value.after_dummy_attachment == value.after_graph_build &&
        value.after_graph_build == value.after_scheduler_new &&
        value.after_scheduler_new == value.after_all_reserve_size &&
        value.after_all_reserve_size == value.after_scheduler_free;
}

const char * json_bool(bool value) {
    return value ? "true" : "false";
}

void write_case(std::ostream & out, const CaseMeasurement & item, int indent) {
    const std::string s(static_cast<size_t>(indent), ' ');
    out << s << "{\n"
        << s << "  \"k\": " << item.k << ",\n"
        << s << "  \"graph_nodes\": " << item.graph_nodes << ",\n"
        << s << "  \"graph_capacity\": " << item.graph_capacity << ",\n"
        << s << "  \"reserve_bytes\": {\"Metal\": "
        << item.metal_reserve_bytes << ", \"CPU\": "
        << item.cpu_reserve_bytes << "},\n"
        << s << "  \"scheduler_split_count\": "
        << item.scheduler_split_count << ",\n"
        << s << "  \"scheduler_parallel_copy_slots\": "
        << item.scheduler_parallel_copy_slots << ",\n"
        << s << "  \"placement\": {\"nodes\": " << item.placement.nodes
        << ", \"non_view_compute_nodes\": "
        << item.placement.non_view_compute_nodes
        << ", \"Metal\": " << item.placement.metal_nodes
        << ", \"CPU\": " << item.placement.cpu_nodes
        << ", \"unassigned\": " << item.placement.unassigned_nodes
        << ", \"metal_non_view_compute_nodes\": "
        << item.placement.metal_non_view_compute_nodes
        << ", \"cpu_non_view_compute_nodes\": "
        << item.placement.cpu_non_view_compute_nodes << "},\n"
        << s << "  \"inserted_copies\": {\"total\": " << item.copies.total
        << ", \"weights\": " << item.copies.weight
        << ", \"graph_inputs\": " << item.copies.graph_input
        << ", \"activations\": " << item.copies.activation
        << ", \"changed_edges\": " << item.copies.changed_edges << "},\n"
        << s << "  \"beta_placement_gate\": "
        << json_bool(item.beta_placement_gate) << "\n"
        << s << "}";
}

void write_result(
    const CliOptions & options,
    const std::string & status,
    const std::string & metal_backend_name,
    const std::string & cpu_backend_name,
    const std::string & metal_buft_name,
    uint64_t before_backend,
    uint64_t after_backend,
    uint64_t after_all_fixtures,
    bool vectors_identical,
    bool weight_sizes_identical,
    bool all_intervals_zero,
    bool all_placement_gates,
    const std::vector<RepeatMeasurement> & repeats) {
    std::ofstream out(options.output, std::ios::out | std::ios::trunc);
    if (!out) {
        throw std::runtime_error("cannot open B2S output");
    }
    out << "{\n"
        << "  \"schema\": \"galactus.h4-b2s-weight-anchored-scheduler-size.v1\",\n"
        << "  \"status\": \"" << status << "\",\n"
        << "  \"rung\": \"B2S_WEIGHT_ANCHORED_SCHEDULER_SIZE_K1_K2\",\n"
        << "  \"scope\": \"same8-lower-bound fixed-kv-optimistic\",\n"
        << "  \"backend_order\": [\"" << metal_backend_name << "\", \""
        << cpu_backend_name << "\"],\n"
        << "  \"metal_buffer_type\": \"" << metal_buft_name << "\",\n"
        << "  \"weight_sizing_precedes_dummy_attachment\": true,\n"
        << "  \"dummy_buffer_object_count_per_fixture\": 1,\n"
        << "  \"dummy_buffer_size_bytes\": 0,\n"
        << "  \"dummy_buffer_usage\": \"WEIGHTS\",\n"
        << "  \"real_backend_buffer_bytes_allocated\": 0,\n"
        << "  \"tensor_initialization_executed\": false,\n"
        << "  \"graph_compute_executed\": false,\n"
        << "  \"model_or_pack_read\": false,\n"
        << "  \"repeat_count\": " << repeats.size() << ",\n"
        << "  \"fully_fresh_fixture_per_repeat\": true,\n"
        << "  \"all_reserve_vectors_identical\": "
        << json_bool(vectors_identical) << ",\n"
        << "  \"all_weight_sizes_identical\": "
        << json_bool(weight_sizes_identical) << ",\n"
        << "  \"all_no_allocation_intervals_zero\": "
        << json_bool(all_intervals_zero) << ",\n"
        << "  \"all_beta_placement_gates_pass\": "
        << json_bool(all_placement_gates) << ",\n"
        << "  \"metal_current_allocated_bytes\": {\"before_backend_init\": "
        << before_backend << ", \"after_backend_init\": " << after_backend
        << ", \"after_all_fixtures\": " << after_all_fixtures << "},\n"
        << "  \"repeats\": [\n";
    for (size_t index = 0; index < repeats.size(); ++index) {
        const auto & repeat = repeats[index];
        out << "    {\n"
            << "      \"repeat_index\": " << repeat.repeat_index << ",\n"
            << "      \"weight_tensor_count\": " << repeat.weight_tensor_count << ",\n"
            << "      \"future_real_weight_buffer_bytes\": "
            << repeat.future_real_weight_buffer_bytes << ",\n"
            << "      \"metal_current_allocated_bytes\": {"
            << "\"before_weight_sizing\": " << repeat.metal.before_weight_sizing
            << ", \"after_weight_sizing\": " << repeat.metal.after_weight_sizing
            << ", \"after_dummy_attachment\": " << repeat.metal.after_dummy_attachment
            << ", \"after_graph_build\": " << repeat.metal.after_graph_build
            << ", \"after_scheduler_new\": " << repeat.metal.after_scheduler_new
            << ", \"after_all_reserve_size\": " << repeat.metal.after_all_reserve_size
            << ", \"after_scheduler_free\": " << repeat.metal.after_scheduler_free
            << "},\n"
            << "      \"cases\": [\n";
        for (size_t case_index = 0; case_index < repeat.cases.size(); ++case_index) {
            write_case(out, repeat.cases[case_index], 8);
            out << (case_index + 1 == repeat.cases.size() ? "\n" : ",\n");
        }
        out << "      ]\n    }"
            << (index + 1 == repeats.size() ? "\n" : ",\n");
    }
    out << "  ],\n"
        << "  \"beta_gate\": {\"metal_non_view_compute_nodes_percent\": 100, "
        << "\"unassigned_node_count\": 0, \"scheduler_split_count\": 1, "
        << "\"weight_copy_count\": 0},\n"
        << "  \"limits\": {\"only_metal_component_feeds_beta\": true, "
        << "\"full_metal_cpu_vector_is_future_compute_identity\": true, "
        << "\"placement_gate_failure_is_diagnostic_not_retryable\": true, "
        << "\"fixture_must_be_rebuilt_between_reserve_and_compute\": true, "
        << "\"automatic_retry\": false, \"automatic_transition\": false}\n"
        << "}\n";
    if (!out) {
        throw std::runtime_error("failed while writing B2S output");
    }
}

} // namespace b2s

int main(int argc, char ** argv) {
    try {
        const b2s::CliOptions options = b2s::parse_cli(argc, argv);
        id<MTLDevice> metal_device = MTLCreateSystemDefaultDevice();
        if (metal_device == nil) {
            throw std::runtime_error("MTLCreateSystemDefaultDevice failed");
        }
        const uint64_t before_backend = current_allocated_bytes(metal_device);

        ggml_backend_load_all();
        ggml_backend_ptr metal(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr));
        ggml_backend_ptr cpu(
            ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr));
        if (!metal || !cpu) {
            throw std::runtime_error("Metal or CPU backend initialization failed");
        }
        if (ggml_backend_dev_type(ggml_backend_get_device(metal.get())) !=
                GGML_BACKEND_DEVICE_TYPE_GPU ||
            ggml_backend_dev_type(ggml_backend_get_device(cpu.get())) !=
                GGML_BACKEND_DEVICE_TYPE_CPU) {
            throw std::runtime_error("scheduler backend order precondition failed");
        }
        const std::string metal_name = ggml_backend_name(metal.get());
        const std::string cpu_name = ggml_backend_name(cpu.get());
        if (metal_name.find("Metal") == std::string::npos) {
            throw std::runtime_error("GPU backend is not Metal");
        }
        const uint64_t after_backend = current_allocated_bytes(metal_device);
        ggml_backend_buffer_type_t metal_buft =
            ggml_backend_get_default_buffer_type(metal.get());
        std::array<ggml_backend_t, 2> backends{metal.get(), cpu.get()};

        std::vector<b2s::RepeatMeasurement> repeats;
        for (int repeat_index = 1; repeat_index <= b2s::REPEAT_COUNT; ++repeat_index) {
            b2s::RepeatMeasurement repeat{};
            repeat.repeat_index = repeat_index;
            repeat.metal.before_weight_sizing = current_allocated_bytes(metal_device);
            b2s::WeightFixture weights(metal_buft, metal_device);
            repeat.future_real_weight_buffer_bytes = weights.future_real_buffer_bytes;
            repeat.weight_tensor_count = weights.tensors.size();
            repeat.metal.after_weight_sizing = weights.after_weight_sizing_capture;
            repeat.metal.after_dummy_attachment =
                weights.after_dummy_attachment_capture;
            b2s::GraphFixture graphs(weights);
            repeat.metal.after_graph_build = current_allocated_bytes(metal_device);

            scheduler_ptr scheduler(ggml_backend_sched_new(
                backends.data(), nullptr, static_cast<int>(backends.size()),
                SCHEDULER_GRAPH_SIZE, false, true));
            if (!scheduler) {
                throw std::runtime_error("ggml_backend_sched_new failed");
            }
            repeat.metal.after_scheduler_new = current_allocated_bytes(metal_device);

            for (auto & graph_case : graphs.cases) {
                const auto sources = b2s::snapshot_sources(graph_case.full);
                std::array<size_t, 2> sizes{};
                ggml_backend_sched_reserve_size(
                    scheduler.get(), graph_case.full, sizes.data());
                b2s::CaseMeasurement measured{};
                measured.k = graph_case.batch_size;
                measured.graph_nodes = ggml_graph_n_nodes(graph_case.full);
                measured.graph_capacity = ggml_graph_size(graph_case.full);
                measured.metal_reserve_bytes = sizes[0];
                measured.cpu_reserve_bytes = sizes[1];
                measured.scheduler_split_count =
                    ggml_backend_sched_get_n_splits(scheduler.get());
                measured.scheduler_parallel_copy_slots =
                    ggml_backend_sched_get_n_copies(scheduler.get());
                measured.placement = b2s::count_placement(
                    scheduler.get(), graph_case.full, metal.get(), cpu.get());
                measured.copies = b2s::classify_copies(sources);
                measured.beta_placement_gate = b2s::placement_gate(measured);
                repeat.cases.push_back(measured);
            }
            repeat.metal.after_all_reserve_size = current_allocated_bytes(metal_device);
            scheduler.reset();
            repeat.metal.after_scheduler_free = current_allocated_bytes(metal_device);
            repeats.push_back(std::move(repeat));
        }
        const uint64_t after_all_fixtures = current_allocated_bytes(metal_device);

        bool vectors_identical = true;
        bool weight_sizes_identical = true;
        bool all_intervals_zero = true;
        bool all_placement_gates = true;
        for (const auto & repeat : repeats) {
            all_intervals_zero = all_intervals_zero && b2s::captures_equal(repeat.metal);
            weight_sizes_identical = weight_sizes_identical &&
                repeat.future_real_weight_buffer_bytes ==
                    repeats.front().future_real_weight_buffer_bytes;
            if (repeat.cases.size() != repeats.front().cases.size()) {
                vectors_identical = false;
            }
            for (size_t index = 0; index < repeat.cases.size(); ++index) {
                const auto & item = repeat.cases[index];
                all_placement_gates = all_placement_gates && item.beta_placement_gate;
                if (index >= repeats.front().cases.size() ||
                    item.metal_reserve_bytes !=
                        repeats.front().cases[index].metal_reserve_bytes ||
                    item.cpu_reserve_bytes !=
                        repeats.front().cases[index].cpu_reserve_bytes) {
                    vectors_identical = false;
                }
            }
        }
        const bool beta_valid = vectors_identical && weight_sizes_identical &&
            all_intervals_zero && all_placement_gates;
        const std::string status = !all_intervals_zero
            ? "refused-unexpected-metal-allocation"
            : (beta_valid ? "valid-beta-sizing" : "valid-placement-diagnostic");
        b2s::write_result(
            options, status, metal_name, cpu_name,
            ggml_backend_buft_name(metal_buft), before_backend, after_backend,
            after_all_fixtures, vectors_identical, weight_sizes_identical,
            all_intervals_zero, all_placement_gates, repeats);
        return all_intervals_zero ? 0 : 3;
    } catch (const std::exception & error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}
