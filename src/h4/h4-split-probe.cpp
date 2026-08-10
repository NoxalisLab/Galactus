// h4-split-probe: expose plan_p0_split to a differential.
//
// The packer and the reader must land on the same cut for every record or the
// engine reads the wrong bytes off one of the two volumes, and nothing says
// so. The only honest way to know they agree is to run BOTH and compare, which
// means the C++ cut has to be reachable from a script. That is all this
// program is.
//
// stdin: one "<record_bytes> <ratio>" pair per line, blanks and # comments
//        ignored.
// stdout: one "<record_bytes> <ratio> <internal_bytes> <external_bytes>" line
//        per input line, or "<record_bytes> <ratio> ERROR <what>".
//
// Driver: scripts/tests/test-p0-split-differential.py

#include "h4-core.hpp"

#include <cstdint>
#include <exception>
#include <iostream>
#include <sstream>
#include <string>

int main() {
    using namespace galactus::h4;
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto hash = line.find('#');
        if (hash != std::string::npos) {
            line.erase(hash);
        }
        std::istringstream fields(line);
        std::uint64_t record_bytes = 0;
        std::string ratio_text;
        if (!(fields >> record_bytes >> ratio_text)) {
            continue;   // blank or comment-only line
        }
        // strtod through std::stod: correctly rounded, so this recovers the
        // same double Python's float() built from the same characters. That
        // equality is the whole reason the two cuts can be compared at all.
        try {
            const double ratio = std::stod(ratio_text);
            const auto split = plan_p0_split(record_bytes, P0Profile::dual_ratio, ratio);
            std::cout << record_bytes << ' ' << ratio_text << ' '
                      << split.internal_bytes << ' ' << split.external_bytes << '\n';
        } catch (const std::exception & failure) {
            std::cout << record_bytes << ' ' << ratio_text << " ERROR " << failure.what() << '\n';
        }
    }
    return 0;
}
