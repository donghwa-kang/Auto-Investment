#pragma once
#include <array>
#include <string_view>

namespace analysis_validator {
constexpr size_t max_input_bytes = 384;
struct Request {
    std::string_view run_id;
    std::string_view manifest_sha;
    std::string_view input_sha;
};
constexpr bool hex(char c) noexcept {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}
constexpr bool hash(std::string_view value) noexcept {
    if (value.size() != 64) return false;
    for (char c : value) if (!hex(c)) return false;
    return true;
}
constexpr bool uuid(std::string_view value) noexcept {
    if (value.size() != 36 || value[14] != '4') return false;
    if (value[19] != '8' && value[19] != '9' && value[19] != 'a' && value[19] != 'b') return false;
    for (size_t i = 0; i < value.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (value[i] != '-') return false;
        } else if (!hex(value[i])) return false;
    }
    return true;
}
// A fixed ASCII frame, not a general JSON/path/command parser. No OS side effects.
inline bool parse(std::string_view wire, Request& result) noexcept {
    if (wire.empty() || wire.size() > max_input_bytes) return false;
    std::array<std::string_view, 10> lines{};
    size_t position = 0;
    for (auto& line : lines) {
        const size_t end = wire.find('\n', position);
        if (end == std::string_view::npos) return false;
        line = wire.substr(position, end - position);
        position = end + 1;
    }
    if (position != wire.size() || lines[0] != "ANALYSIS_NATIVE_REQUEST_V1" ||
        !uuid(lines[1]) || !hash(lines[2]) || !hash(lines[3]) ||
        lines[4] != "PREPARATION_ONLY" || lines[5] != "CAPABILITIES=NONE" ||
        lines[6] != "CHILD_PROCESSES=DENY" ||
        lines[7] != "LIMITS=1,128,2000,10000,8192" ||
        lines[8] != "EXECUTION=LOCKED" || lines[9] != "END") return false;
    result = {lines[1], lines[2], lines[3]};
    return true;
}
} // namespace analysis_validator
