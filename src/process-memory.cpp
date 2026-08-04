#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <libproc.h>
#include <sys/resource.h>

int main(int argc, char ** argv) {
    if (argc != 2) {
        std::cerr << "usage: galactus-process-memory PID\n";
        return 2;
    }

    char * end = nullptr;
    errno = 0;
    const long parsed = std::strtol(argv[1], &end, 10);
    if (errno != 0 || end == argv[1] || *end != '\0' || parsed <= 0) {
        std::cerr << "error: invalid PID\n";
        return 2;
    }

    rusage_info_v4 usage = {};
    if (proc_pid_rusage(static_cast<int>(parsed), RUSAGE_INFO_V4,
            reinterpret_cast<rusage_info_t *>(&usage)) != 0) {
        std::cerr << "error: proc_pid_rusage: " << std::strerror(errno) << '\n';
        return 1;
    }

    std::cout << usage.ri_phys_footprint << ' '
              << usage.ri_resident_size << ' '
              << usage.ri_pageins << ' '
              << usage.ri_diskio_bytesread << '\n';
    return 0;
}
