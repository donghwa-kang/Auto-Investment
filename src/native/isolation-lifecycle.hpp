#pragma once
#include <array>
#include <cstddef>
#include <string_view>

namespace isolation {
enum class Step { Preflight, Job, Pipes, Attributes, Suspended, Identity, Resume, Exchange, Exit, Count };
constexpr std::array<const char*, 9> names{"PREFLIGHT", "JOB", "PIPES", "ATTRIBUTES", "SUSPENDED", "IDENTITY", "RESUME", "EXCHANGE", "EXIT"};
enum class Kind { Model, Win32 };
struct Backend {
    virtual ~Backend() = default;
    virtual Kind kind() const noexcept = 0;
    virtual bool perform(Step step) = 0;
    virtual bool cleanup() noexcept = 0;
    virtual std::string_view receipt() const noexcept = 0;
};
struct Result { bool locked = false, passed = false, cleanup_verified = false; Step failed_at = Step::Count; size_t calls = 0; };
// No flag, environment variable or input can opt a Win32 backend into execution in this build.
inline Result run(Backend& backend, bool model_requested) noexcept {
    if (!model_requested || backend.kind() != Kind::Model) return {true, false, false, Step::Count, 0};
    Result result;
    try {
        for (size_t i = 0; i < static_cast<size_t>(Step::Count); ++i) {
            ++result.calls;
            const Step step = static_cast<Step>(i);
            if (!backend.perform(step)) { result.failed_at = step; break; }
        }
    } catch (...) {
        result.failed_at = static_cast<Step>(result.calls - 1);
    }
    // Always clean up partially-created resources, including a failing create operation.
    result.cleanup_verified = backend.cleanup();
    result.passed = result.calls == static_cast<size_t>(Step::Count) && result.failed_at == Step::Count && result.cleanup_verified;
    return result;
}
} // namespace isolation
