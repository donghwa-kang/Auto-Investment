#pragma once
#include "file-probe-common.hpp"
#include "isolation-lifecycle.hpp"
#include <memory>

namespace isolation {
// Internal future configuration, not a JSON/CLI approval format. Provisioning is not implemented.
struct NativeConfig {
    std::wstring root, profile_sid;
    std::string probe_sha256, request;
};
std::unique_ptr<Backend> make_win32_backend(NativeConfig config);
} // namespace isolation
