// galactus-metal-hold — allouer et TENIR un cache d'experts en memoire Metal.
//
// Question binaire du projet : ~96,7 Go de tampons Metal peuvent-ils etre
// alloues et gardes residents pendant que la machine sert autre chose ?
// Tout le reste en depend, et ca n'a jamais ete demontre : le palier A0
// s'est termine en `inconclusive-invalid`.
//
// Le programme alloue par tranches, ecrit dans chaque tranche (une reserve
// non touchee ne prouve rien : `vm_allocate` reussit sans page physique),
// publie l'etat du peripherique a chaque palier, puis TIENT jusqu'a ce que
// le fichier sentinelle disparaisse ou que la duree soit ecoulee. Chaque
// palier est ecrit et vide immediatement : un arret brutal laisse la trace.
//
// Aucune allocation n'est faite au-dela de --target-bytes. En cas d'echec
// d'allocation, on s'arrete et on publie le dernier palier atteint : c'est
// le resultat, pas une erreur.

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {

std::uint64_t parse_u64(const char * text, const char * option) {
    char * end = nullptr;
    const unsigned long long value = std::strtoull(text, &end, 10);
    if (end == text || *end != '\0') {
        std::fprintf(stderr, "error: %s expects an unsigned integer\n", option);
        std::exit(2);
    }
    return static_cast<std::uint64_t>(value);
}

bool file_exists(const std::string & path) {
    struct stat info;
    return stat(path.c_str(), &info) == 0;
}

double monotonic_seconds() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return static_cast<double>(ts.tv_sec) + static_cast<double>(ts.tv_nsec) * 1e-9;
}

}  // namespace

int main(int argc, char ** argv) {
    std::uint64_t target_bytes = 0;
    std::uint64_t chunk_bytes = 1ULL << 30;   // 1 GiB
    std::uint64_t hold_seconds = 120;
    std::string sentinel_path;
    std::string output_path;

    for (int i = 1; i < argc; ++i) {
        const std::string option = argv[i];
        auto next = [&](const char * name) -> const char * {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "error: %s requires a value\n", name);
                std::exit(2);
            }
            return argv[++i];
        };
        if (option == "--target-bytes") {
            target_bytes = parse_u64(next("--target-bytes"), "--target-bytes");
        } else if (option == "--chunk-bytes") {
            chunk_bytes = parse_u64(next("--chunk-bytes"), "--chunk-bytes");
        } else if (option == "--hold-seconds") {
            hold_seconds = parse_u64(next("--hold-seconds"), "--hold-seconds");
        } else if (option == "--sentinel") {
            sentinel_path = next("--sentinel");
        } else if (option == "--output") {
            output_path = next("--output");
        } else {
            std::fprintf(stderr,
                "usage: %s --target-bytes N [--chunk-bytes N] [--hold-seconds N]"
                " [--sentinel FILE] --output FILE\n", argv[0]);
            return 2;
        }
    }
    if (target_bytes == 0 || chunk_bytes == 0 || output_path.empty()) {
        std::fprintf(stderr, "error: --target-bytes and --output are required\n");
        return 2;
    }

    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (device == nil) {
            std::fprintf(stderr, "error: no Metal device\n");
            return 3;
        }
        const std::uint64_t recommended = [device recommendedMaxWorkingSetSize];
        const std::uint64_t max_buffer = [device maxBufferLength];
        std::fprintf(stderr,
            "device %s  recommendedMaxWorkingSetSize %" PRIu64
            "  maxBufferLength %" PRIu64 "\n",
            [[device name] UTF8String], recommended, max_buffer);

        FILE * out = std::fopen(output_path.c_str(), "w");
        if (out == nullptr) {
            std::fprintf(stderr, "error: cannot open output\n");
            return 4;
        }
        std::fprintf(out,
            "{\"schema\":\"galactus.metal-hold.v1\","
            "\"device\":\"%s\",\"recommended_max_working_set_bytes\":%" PRIu64 ","
            "\"max_buffer_length_bytes\":%" PRIu64 ","
            "\"target_bytes\":%" PRIu64 ",\"chunk_bytes\":%" PRIu64 ",\"milestones\":[",
            [[device name] UTF8String], recommended, max_buffer, target_bytes, chunk_bytes);
        std::fflush(out);

        std::vector<id<MTLBuffer>> buffers;
        buffers.reserve(static_cast<std::size_t>(target_bytes / chunk_bytes) + 2);
        std::uint64_t allocated = 0;
        bool first = true;
        bool allocation_failed = false;
        const double t0 = monotonic_seconds();

        while (allocated < target_bytes) {
            const std::uint64_t want = std::min<std::uint64_t>(chunk_bytes, target_bytes - allocated);
            id<MTLBuffer> buffer = [device newBufferWithLength:want
                                                      options:MTLResourceStorageModeShared];
            if (buffer == nil) {
                allocation_failed = true;
                std::fprintf(stderr, "allocation refused at %" PRIu64 " bytes\n", allocated);
                break;
            }
            // Toucher : une reserve non ecrite ne prouve aucune page physique.
            std::memset([buffer contents], 0x5A, static_cast<std::size_t>(want));
            buffers.push_back(buffer);
            allocated += want;

            if (allocated % (8ULL << 30) == 0 || allocated == target_bytes) {
                std::fprintf(out,
                    "%s{\"allocated_bytes\":%" PRIu64 ",\"current_allocated_size\":%" PRIu64
                    ",\"elapsed_seconds\":%.3f}",
                    first ? "" : ",", allocated,
                    static_cast<std::uint64_t>([device currentAllocatedSize]),
                    monotonic_seconds() - t0);
                std::fflush(out);
                first = false;
                std::fprintf(stderr, "palier %" PRIu64 " Go  currentAllocatedSize %" PRIu64 "\n",
                    allocated / 1000000000ULL,
                    static_cast<std::uint64_t>([device currentAllocatedSize]));
            }
        }

        const double ramp_seconds = monotonic_seconds() - t0;
        std::fprintf(stderr, "tenue de %" PRIu64 " octets pendant %" PRIu64 " s\n",
            allocated, hold_seconds);
        if (!sentinel_path.empty()) {
            FILE * s = std::fopen(sentinel_path.c_str(), "w");
            if (s != nullptr) { std::fprintf(s, "ready\n"); std::fclose(s); }
        }
        const double hold_start = monotonic_seconds();
        while (monotonic_seconds() - hold_start < static_cast<double>(hold_seconds)) {
            if (!sentinel_path.empty() && !file_exists(sentinel_path)) break;
            sleep(1);
        }

        std::fprintf(out,
            "],\"allocated_bytes\":%" PRIu64 ",\"allocation_failed\":%s,"
            "\"final_current_allocated_size\":%" PRIu64 ",\"ramp_seconds\":%.3f,"
            "\"held_seconds\":%.3f,\"buffers\":%zu}\n",
            allocated, allocation_failed ? "true" : "false",
            static_cast<std::uint64_t>([device currentAllocatedSize]),
            ramp_seconds, monotonic_seconds() - hold_start, buffers.size());
        std::fclose(out);
        std::fprintf(stderr, "termine : %" PRIu64 " octets alloues, echec=%s\n",
            allocated, allocation_failed ? "oui" : "non");
        return allocation_failed ? 1 : 0;
    }
}
